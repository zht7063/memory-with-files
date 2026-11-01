// Host-independent safe file writing for the lifecycle commands (install / uninstall).
//
// Rules (Aegis 4-6 and A1-A4):
//  - the target is resolved with realpath; only a regular file owned by the current user inside a
//    directory owned by the current user and not world-writable is accepted (others' files,
//    dangling links, directories, FIFOs and sockets are refused);
//  - a symlink is never replaced: the new content is written next to the REAL file and renamed
//    over the real file, so a dotfile manager's link stays exactly as it was;
//  - the new content goes to a same-directory temp file created with O_EXCL | O_NOFOLLOW, is
//    fsynced, and is renamed (an absent target is created with link(), which never overwrites);
//  - what was read (device, inode, size, mtime in ns, sha256) is checked again immediately before
//    the rename; any change aborts the write and the file is left as the other writer made it;
//  - every directory on the way to the target is checked too (checkAncestors): each ancestor below
//    the trust root is resolved with realpath and must not be other-writable (always), nor
//    group-writable unless the group is the current user's primary group with no other member; a
//    symlink on the way must resolve inside the trust root, and a dangling one is refused;
//  - before an existing file is changed or removed it is copied to a unique, 0600 backup next to it
//    (`<name>.mwf-bak-<UTC>-<8 hex>`, created with O_EXCL); backups are never overwritten or deleted.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export type SafeWriteCode = 'UNSAFE_TARGET' | 'CONCURRENT_MODIFICATION' | 'IO_ERROR';

export class SafeWriteError extends Error {
  readonly code: SafeWriteCode;
  constructor(code: SafeWriteCode, message: string) {
    super(message);
    this.name = 'SafeWriteError';
    this.code = code;
  }
}

/** UNSAFE_TARGET when `error` is a refusal of an unsafe target, else `fallback`. */
export const unsafeOr = (error: unknown, fallback: string): string =>
  error instanceof SafeWriteError && error.code === 'UNSAFE_TARGET' ? error.code : fallback;

export interface Snapshot {
  /** The real path the content was read from (no symlink components). */
  real: string;
  exists: boolean;
  content: Buffer;
  sha256: string;
  mode: number;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

/** Text of the account databases, for the group-writable rule. Tests inject fakes. */
export interface AccountReader {
  /** The content of /etc/passwd (`name:x:uid:gid:...` lines). */
  passwd: () => string;
  /** The content of /etc/group (`name:x:gid:member,member` lines). */
  group: () => string;
}

export const systemAccounts: AccountReader = {
  passwd: () => readFileSync('/etc/passwd', 'utf8'),
  group: () => readFileSync('/etc/group', 'utf8'),
};

export interface Owner {
  /** The user the files must belong to; undefined on platforms without uids (no check then). */
  uid: number | undefined;
  /**
   * The trust root: the directories from here down to a write target are all checked
   * (checkAncestors) and no symlink may lead out of it. Directories above the root are the user's
   * own choice of where to put it and are not checked. Without a root only the target's own
   * directory is checked.
   */
  root?: string;
  /** Where the group-writable rule reads users and groups from (default: /etc/passwd, /etc/group). */
  accounts?: AccountReader;
}

/**
 * The trust root for a harness directory: the user's home when the directory is inside it (so a
 * symlinked `~/.pi` or `~/.agents` is seen), else the directory itself.
 */
export const trustRootFor = (dir: string, home: string): string => (inside(home, dir) ? home : dir);

/** The same owner with a trust root. */
export const withRoot = (owner: Owner, root: string): Owner => ({ ...owner, root });

export const currentOwner = (): Owner => ({ uid: process.getuid?.() });

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
export const sha256Hex = (data: string | Uint8Array): string =>
  sha256(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function unsafe(message: string): never {
  throw new SafeWriteError('UNSAFE_TARGET', message);
}

/**
 * Is `gid` the current user's primary group with nobody else in it? Needs both /etc/passwd and
 * /etc/group; anything that cannot be read or found counts as "no" (fail closed).
 */
function groupIsPrivate(gid: number, owner: Owner): boolean {
  if (owner.uid === undefined) return false;
  try {
    const accounts = owner.accounts ?? systemAccounts;
    const users = accounts
      .passwd()
      .split('\n')
      .map((l) => l.split(':'))
      .filter((f) => f.length >= 4 && f[0] !== '' && !f[0]!.startsWith('#'))
      .map((f) => ({ name: f[0]!, uid: Number(f[2]), gid: Number(f[3]) }));
    const me = users.filter((u) => u.uid === owner.uid);
    if (me.length === 0 || me.some((u) => u.gid !== gid)) return false;
    if (users.some((u) => u.gid === gid && u.uid !== owner.uid)) return false;
    const mine = new Set(me.map((u) => u.name));
    const groups = accounts
      .group()
      .split('\n')
      .map((l) => l.split(':'))
      .filter(
        (f) => f.length >= 3 && f[0] !== '' && !f[0]!.startsWith('#') && Number(f[2]) === gid,
      );
    if (groups.length === 0) return false; // membership cannot be determined
    for (const g of groups)
      for (const member of (g[3] ?? '').split(',').filter(Boolean))
        if (!mine.has(member)) return false;
    return true;
  } catch {
    return false;
  }
}

/** A directory we may rely on: owned by us, not other-writable, group-writable only if private. */
function checkDirStat(label: string, st: Stats, owner: Owner): void {
  if (!st.isDirectory()) unsafe(`${label} is not a directory`);
  if (owner.uid !== undefined && st.uid !== owner.uid)
    unsafe(`${label} is not owned by the current user`);
  if ((st.mode & 0o002) !== 0) unsafe(`${label} is world-writable`);
  if ((st.mode & 0o020) !== 0 && !groupIsPrivate(st.gid, owner))
    unsafe(
      `${label} is group-writable (group ${st.gid} is not the current user's own group, or has other members, or could not be looked up)`,
    );
}

/** The directory that will hold (or holds) the file. */
function checkDir(dir: string, owner: Owner): void {
  const st = lstatSafe(dir);
  if (!st) unsafe(`${dir} is not a directory`);
  checkDirStat(dir, st, owner);
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Check every directory from the trust root down to `dir` (which may not exist yet; the missing
 * tail is simply not there to check), after resolving each with realpath, and return the resolved
 * path of `dir`, so the caller can create and write below it without resolving a second time.
 * Refuses (UNSAFE_TARGET) a directory that is other-writable, group-writable without being a
 * private group, not ours, not a directory, a symlink that resolves outside the root, or a
 * dangling symlink. Without a trust root it returns `dir` unchanged.
 */
export function checkAncestors(dir: string, owner: Owner): string {
  const root = owner.root;
  if (root === undefined) return dir;
  const rel = relative(root, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) unsafe(`${dir} is outside ${root}`);
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') throw error;
    if (lstatSafe(root)) unsafe(`${root} is a dangling symbolic link`);
    return dir; // nothing exists yet: nothing to check
  }
  checkDirStat(rootReal, statSync(rootReal), owner);
  let resolved = rootReal;
  const parts = rel === '' ? [] : rel.split(sep);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]!);
    let real: string;
    try {
      real = realpathSync(cur);
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') throw error;
      if (lstatSafe(cur)) unsafe(`${cur} is a dangling symbolic link`);
      return join(resolved, ...parts.slice(i)); // the rest does not exist yet
    }
    if (!inside(rootReal, real))
      unsafe(
        `${cur} is a symbolic link to ${real}, outside ${rootReal}. ` +
          `A harness or skills directory that is symlinked outside the home directory (for example into a dotfiles repository) is refused; make it a real directory.`,
      );
    const label = real === cur ? cur : `${cur} (-> ${real})`;
    checkDirStat(label, statSync(real), owner);
    resolved = real;
  }
  return resolved;
}

function lstatSafe(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * `mkdir -p` that never goes through a link: the existing part of the chain is checked and
 * resolved first (checkAncestors), the missing part is created below the RESOLVED path, and the
 * whole chain is checked again afterwards. Throws SafeWriteError(UNSAFE_TARGET).
 */
export function mkdirSafe(dir: string, owner: Owner, mode: number): void {
  const resolved = checkAncestors(dir, owner);
  mkdirSync(resolved, { recursive: true, mode });
  checkAncestors(dir, owner);
}

/** Resolve a path to the real file we may touch, or throw UNSAFE_TARGET. The file may be absent. */
export function resolveTarget(path: string, owner: Owner = currentOwner()): string {
  checkAncestors(dirname(path), owner);
  let real: string;
  try {
    real = realpathSync(path);
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') throw error;
    if (lstatSafe(path)) unsafe(`${path} is a dangling symbolic link`);
    let parent: string;
    try {
      parent = realpathSync(dirname(path));
    } catch (e) {
      if (errnoOf(e) === 'ENOENT') unsafe(`the directory of ${path} does not exist`);
      throw e;
    }
    checkDir(parent, owner);
    return join(parent, basename(path));
  }
  const st = lstatSync(real);
  if (!st.isFile()) unsafe(`${path} is not a regular file`);
  if (owner.uid !== undefined && st.uid !== owner.uid)
    unsafe(`${path} is not owned by the current user`);
  checkDir(dirname(real), owner);
  return real;
}

/** Like readSnapshot, but a file whose directory does not exist yet is simply absent. */
export function readSnapshotOrAbsent(path: string, owner: Owner = currentOwner()): Snapshot {
  try {
    return readSnapshot(path, owner);
  } catch (error) {
    if (error instanceof SafeWriteError && /directory of .* does not exist/.test(error.message))
      return {
        real: path,
        exists: false,
        content: Buffer.alloc(0),
        sha256: sha256(Buffer.alloc(0)),
        mode: 0o600,
        dev: 0n,
        ino: 0n,
        size: 0n,
        mtimeNs: 0n,
      };
    throw error;
  }
}

function readAll(fd: number, size: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
    if (total > Math.max(size, 0) + 16 * 1024 * 1024) unsafe('file is larger than expected');
  }
  return Buffer.concat(chunks);
}

/** Read the file (or note its absence) as one consistent snapshot. */
export function readSnapshot(path: string, owner: Owner = currentOwner()): Snapshot {
  const real = resolveTarget(path, owner);
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT')
      return {
        real,
        exists: false,
        content: Buffer.alloc(0),
        sha256: sha256(Buffer.alloc(0)),
        mode: 0o600,
        dev: 0n,
        ino: 0n,
        size: 0n,
        mtimeNs: 0n,
      };
    throw error;
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    const content = readAll(fd, Number(st.size));
    return {
      real,
      exists: true,
      content,
      sha256: sha256(content),
      mode: Number(st.mode & 0o7777n),
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeNs: st.mtimeNs,
    };
  } finally {
    closeSync(fd);
  }
}

function sameAs(expect: Snapshot, now: Snapshot): boolean {
  if (expect.exists !== now.exists) return false;
  if (!expect.exists) return true;
  return (
    expect.dev === now.dev &&
    expect.ino === now.ino &&
    expect.size === now.size &&
    expect.mtimeNs === now.mtimeNs &&
    expect.sha256 === now.sha256
  );
}

function modified(path: string): SafeWriteError {
  return new SafeWriteError(
    'CONCURRENT_MODIFICATION',
    `${path} was modified while mwf was working (a running agent may have rewritten it); nothing was written, run the command again`,
  );
}

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (!['EISDIR', 'EPERM', 'EINVAL', 'EACCES', 'ENOTSUP'].includes(errnoOf(error) ?? ''))
      throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeNew(path: string, data: Uint8Array, mode: number): void {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

export interface BackupOptions {
  now?: Date;
  /** Where to put the backup (default: next to `path`). */
  dir?: string;
  /** The name to give it (default: the file's own name). */
  name?: string;
}

/** Copy the snapshot's content to a unique 0600 backup; returns its path. Never overwrites. */
export function backupSnapshot(path: string, snap: Snapshot, options: BackupOptions = {}): string {
  const dir = options.dir ?? dirname(path);
  const name = options.name ?? basename(path);
  for (let attempt = 0; attempt < 5; attempt++) {
    const target = join(
      dir,
      `${name}.mwf-bak-${stamp(options.now ?? new Date())}-${randomBytes(4).toString('hex')}`,
    );
    try {
      writeNew(target, snap.content, 0o600);
      return target;
    } catch (error) {
      if (errnoOf(error) === 'EEXIST') continue;
      throw error;
    }
  }
  throw new SafeWriteError('IO_ERROR', `could not create a unique backup name for ${path}`);
}

export interface WriteOptions extends BackupOptions {
  owner?: Owner;
  /** Mode for a new file (an existing file keeps its mode). Default 0600. */
  mode?: number;
  /** Back an existing file up first (default true). */
  backup?: boolean;
  /**
   * Test seam: called after the temp file is complete and before the final check and rename, so a
   * test can modify the target at exactly the racy moment.
   */
  beforeRename?: () => void;
}

export interface WriteResult {
  path: string;
  real: string;
  backup?: string;
}

/**
 * Write `data` to `path` (a symlink is followed, never replaced) if the file is still exactly what
 * `expect` read. Throws SafeWriteError; on any failure the original file is untouched.
 */
export function commitFile(
  path: string,
  data: string | Uint8Array,
  expect: Snapshot,
  options: WriteOptions = {},
): WriteResult {
  const owner = options.owner ?? currentOwner();
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const real = resolveTarget(path, owner);
  if (real !== expect.real) throw modified(path);
  if (!sameAs(expect, readSnapshot(path, owner))) throw modified(path);
  const result: WriteResult = { path, real };
  if (expect.exists && options.backup !== false)
    result.backup = backupSnapshot(real, expect, options);
  const tmp = join(dirname(real), `.${basename(real)}.mwf-tmp-${randomBytes(6).toString('hex')}`);
  try {
    writeNew(tmp, bytes, expect.exists ? expect.mode & 0o777 : (options.mode ?? 0o600));
    options.beforeRename?.();
    if (!sameAs(expect, readSnapshot(path, owner))) throw modified(path);
    if (expect.exists) renameSync(tmp, real);
    else {
      try {
        linkSync(tmp, real); // atomic and never overwrites a file that appeared meanwhile
      } catch (error) {
        if (errnoOf(error) === 'EEXIST') throw modified(path);
        throw error;
      }
      unlinkSync(tmp);
    }
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already renamed away or never created */
    }
    throw error;
  }
  fsyncDir(dirname(real));
  return result;
}

/**
 * Remove a regular file (not a symlink: a link into a dotfile repository is the user's) if it is
 * still what `expect` read. Backs it up first unless `backup` is false.
 */
export function removeFile(
  path: string,
  expect: Snapshot,
  options: WriteOptions = {},
): WriteResult {
  const owner = options.owner ?? currentOwner();
  const st = lstatSafe(path);
  if (st?.isSymbolicLink())
    unsafe(`${path} is a symbolic link; remove it yourself if you want it gone`);
  const real = resolveTarget(path, owner);
  if (!expect.exists || real !== expect.real) throw modified(path);
  if (!sameAs(expect, readSnapshot(path, owner))) throw modified(path);
  const result: WriteResult = { path, real };
  if (options.backup !== false) result.backup = backupSnapshot(real, expect, options);
  options.beforeRename?.();
  if (!sameAs(expect, readSnapshot(path, owner))) throw modified(path);
  unlinkSync(real);
  fsyncDir(dirname(real));
  return result;
}
