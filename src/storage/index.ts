import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { MWFError } from "../contracts/error.js";
export { MWFError } from "../contracts/error.js";
import {
  isMwfOwned,
  JOURNAL_PATH,
  MANAGED_PATHS,
  TEMP_SCAN_DIRS,
} from "../contracts/managed-surface.js";
export const hash = (value: string | null) =>
  value === null ? null : createHash("sha256").update(value).digest("hex");
export function canonicalRoot(input: string): string {
  if (!path.isAbsolute(input))
    throw new MWFError(
      "ROOT_REQUIRED",
      "An absolute project root is required.",
    );
  const root = fs.realpathSync(input);
  if (!fs.statSync(root).isDirectory())
    throw new MWFError("INVALID_ROOT", "Project root must be a directory.");
  return root;
}
// Reject all symlinks below the root, including dangling links, before reading/writing.
export function safePath(root: string, relative: string): string {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((p) => p === "..")
  )
    throw new MWFError(
      "UNSAFE_PATH",
      `Invalid project-relative path: ${relative}`,
    );
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep))
    throw new MWFError("UNSAFE_PATH", "Path escapes project.");
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new MWFError("SYMLINK", `Symlinks are not allowed: ${relative}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return target;
}
export function read(root: string, relative: string): string | null {
  try {
    return fs.readFileSync(safePath(root, relative), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
function syncDir(dir: string) {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } catch (e) {
    if (process.platform !== "win32") throw e;
  } finally {
    fs.closeSync(fd);
  }
}
export function atomicWrite(root: string, relative: string, value: string) {
  const target = safePath(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.mwf-tmp-${randomUUID()}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, value, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, safePath(root, relative));
    syncDir(path.dirname(target));
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export function walk(root: string, relative: string): string[] {
  const base = safePath(root, relative);
  if (!fs.existsSync(base)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    safePath(root, name);
    if (entry.isDirectory()) result.push(...walk(root, name));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}
/** A project-relative path in canonical form: `/` separators only, no empty,
 * `.` or `..` segments, not absolute. Non-canonical spellings (`./AGENTS.md`,
 * `.codex//config.toml`, `.mwf/../x`, `a\\b`) are rejected rather than
 * normalized, so the whitelist match below can never be bypassed by aliasing. */
function canonicalRelative(file: string): string | null {
  if (typeof file !== "string" || !file || file.includes("\\")) return null;
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return null;
  const normalized = path.posix.normalize(file);
  if (normalized !== file) return null;
  if (file.split("/").some((p) => p === "" || p === "." || p === ".."))
    return null;
  return normalized;
}
function allowedChange(file: string) {
  const canonical = canonicalRelative(file);
  if (canonical === null) return false;
  return (
    isMwfOwned(canonical) ||
    (MANAGED_PATHS as readonly string[]).includes(canonical)
  );
}

type Change = { path: string; before: string | null; after: string | null };
type Journal = { version: 1; changes: Change[] };
const JOURNAL = JOURNAL_PATH;
function applyJournal(
  root: string,
  journal: Journal,
  fault?: (stage: string) => void,
) {
  // Preflight all entries, then check each again before replacement. External editors
  // don't participate in our lock; an unexpected value is never overwritten.
  for (const change of journal.changes) {
    if (!allowedChange(change.path))
      throw new MWFError(
        "INVALID_JOURNAL",
        "Journal targets a file outside the MWF managed surface.",
      );
    const current = hash(read(root, change.path));
    if (current !== change.before && current !== hash(change.after))
      throw new MWFError(
        "RECOVERY_CONFLICT",
        `External edit at ${change.path}; transaction retained for inspection.`,
      );
  }
  for (const [index, change] of journal.changes.entries()) {
    const current = hash(read(root, change.path));
    if (current !== hash(change.after)) {
      if (current !== change.before)
        throw new MWFError(
          "RECOVERY_CONFLICT",
          `External edit at ${change.path}.`,
        );
      if (change.after === null) {
        fs.unlinkSync(safePath(root, change.path));
        syncDir(path.dirname(safePath(root, change.path)));
      } else atomicWrite(root, change.path, change.after);
    }
    fault?.(`applied:${index}`);
  }
  fault?.("before-cleanup");
  fs.unlinkSync(safePath(root, JOURNAL));
  syncDir(path.dirname(safePath(root, JOURNAL)));
}
function cleanupTemporaryFiles(root: string) {
  // A crash can occur after fsync(temp) but before rename. Reserved temporary
  // names must not retain a hidden copy after subsequent forgetting/redaction.
  const pattern =
    /\.mwf-tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const file of walk(root, ".mwf"))
    if (pattern.test(file)) fs.unlinkSync(safePath(root, file));
  for (const directory of TEMP_SCAN_DIRS) {
    const absolute = directory ? safePath(root, directory) : root;
    if (!fs.existsSync(absolute)) continue;
    for (const name of fs.readdirSync(absolute)) {
      if (pattern.test(name))
        fs.unlinkSync(
          safePath(root, directory ? `${directory}/${name}` : name),
        );
    }
  }
}

export function recover(root: string) {
  cleanupTemporaryFiles(root);
  const raw = read(root, JOURNAL);
  if (raw === null) return false;
  let journal: Journal;
  try {
    journal = JSON.parse(raw);
    if (
      journal.version !== 1 ||
      !Array.isArray(journal.changes) ||
      journal.changes.some(
        (c) =>
          typeof c.path !== "string" ||
          !(c.before === null || /^[a-f0-9]{64}$/.test(c.before)) ||
          !(c.after === null || typeof c.after === "string") ||
          c.path === JOURNAL ||
          c.path.includes("runtime.sqlite"),
      )
    )
      throw new Error();
  } catch {
    throw new MWFError(
      "INVALID_JOURNAL",
      "Invalid recovery journal; preserve it for manual inspection.",
    );
  }
  applyJournal(root, journal);
  return true;
}
export class Transaction {
  private originals = new Map<string, string | null>();
  private writes = new Map<string, string | null>();
  constructor(public root: string) {}
  get(file: string) {
    if (this.writes.has(file)) return this.writes.get(file)!;
    if (!this.originals.has(file))
      this.originals.set(file, read(this.root, file));
    return this.originals.get(file)!;
  }
  set(file: string, text: string | null) {
    this.get(file);
    this.writes.set(file, text);
  }
  files(dir: string) {
    return [...new Set([...walk(this.root, dir), ...this.writes.keys()])]
      .filter((p) => p.startsWith(dir + "/") && this.get(p) !== null)
      .sort();
  }
  changes(): Change[] {
    return [...this.writes]
      .filter(([p, v]) => this.originals.get(p) !== v)
      .map(([p, v]) => ({
        path: p,
        before: hash(this.originals.get(p)!),
        after: v,
      }));
  }
  commit(fault?: (stage: string) => void) {
    const changes = this.changes();
    if (!changes.length) return [];
    // Reads that influenced the operation must still match, even if not written.
    for (const [file, old] of this.originals)
      if (hash(read(this.root, file)) !== hash(old))
        throw new MWFError(
          "WRITE_CONFLICT",
          `File changed during operation: ${file}`,
        );
    atomicWrite(this.root, JOURNAL, JSON.stringify({ version: 1, changes }));
    fault?.("prepared");
    applyJournal(this.root, { version: 1, changes }, fault);
    return changes.map((c) => c.path);
  }
}
const LOCK_WAIT_MS = 10000;
let lockDeadline: number | undefined;
// Bounds how long every project-lock acquisition inside `fn` may wait in total.
// Short-lived hook processes use it so lock contention degrades to BUSY (the
// hook then fails open) before the host or runner kills them (#30). Nested
// budgets can only shorten the outer one.
export function withLockDeadline<T>(budgetMs: number, fn: () => T): T {
  const previous = lockDeadline,
    next = Date.now() + budgetMs;
  lockDeadline = previous === undefined ? next : Math.min(previous, next);
  try {
    return fn();
  } finally {
    lockDeadline = previous;
  }
}
export function withProjectLock<T>(root: string, fn: () => T): T {
  // This empty SQLite database is an OS-backed mutex only. No memory or result
  // data lives in it. Keep its inode in place; deleting a live lock splits writers.
  const file = safePath(root, ".mwf/local/runtime.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, {
    timeout:
      lockDeadline === undefined
        ? LOCK_WAIT_MS
        : Math.max(1, Math.min(LOCK_WAIT_MS, lockDeadline - Date.now())),
  });
  try {
    db.exec("BEGIN IMMEDIATE");
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    if ((e as Error).message.includes("database is locked"))
      throw new MWFError(
        "BUSY",
        "Another MWF operation holds the project lock. Retry later.",
      );
    throw e;
  } finally {
    db.close();
  }
}
