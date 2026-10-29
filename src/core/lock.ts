import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { MwfError } from './errors.ts';
import { failpoint } from './failpoint.ts';
import type { Layout } from './paths.ts';
import { sleep } from './util.ts';

export const DEFAULT_LOCK_STALE_MS = 30_000;
export const DEFAULT_WAIT_MS = 5_000;
/** doctor flags a live lock whose holder has had it for longer than this (L2). */
export const DEFAULT_LOCK_HELD_WARN_MS = 120_000;
const GUARD_STALE_MS = 10_000;

export interface LockInfo {
  pid: number;
  host: string;
  /** Last heartbeat (equals the acquisition time until the first heartbeat). */
  time: number;
  /** Acquisition time; never refreshed, so doctor can tell how long the lock has been held. */
  acquired?: number;
  token: string;
  /**
   * Opaque start-time identity of the holder process (Linux: boot id + /proc/<pid>/stat
   * starttime). Guards against pid reuse. Absent on platforms without /proc.
   */
  start?: string;
  /**
   * Identity of the holder's pid namespace (Linux: the target of /proc/self/ns/pid). Two containers
   * can share a hostname (`--hostname`, `--uts=host`) while having unrelated pid spaces; see
   * `isForeign`.
   */
  pidns?: string;
}

export interface LockOptions {
  /** How long to wait for the lock before throwing LOCK_TIMEOUT. 0 = single attempt. */
  waitMs?: number;
  /** A lock is reclaimable when its holder pid is dead (same host) or it is older than this. */
  staleMs?: number;
  now?: () => number;
}

export interface LockHandle {
  readonly info: LockInfo;
  /** True when we reclaimed a lock from a dead holder or a stale foreign-host holder. */
  readonly reclaimed: boolean;
  /**
   * Refresh the lock timestamp (throttled; cheap to call in loops). Returns false if we lost the
   * lock (file gone or now owned by someone else); `lost` stays true from then on.
   */
  heartbeat(force?: boolean): boolean;
  /** True once a heartbeat or `assertHeld` found that the lock is no longer ours. */
  readonly lost: boolean;
  /** Re-verify ownership right now (no throttle); throws LOCK_LOST when the lock is not ours. */
  assertHeld(): void;
  release(): void;
}

function readInfo(path: string): LockInfo | null | 'absent' {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Partial<LockInfo>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.host === 'string' &&
      typeof parsed.time === 'number' &&
      typeof parsed.token === 'string'
    ) {
      return parsed as LockInfo;
    }
  } catch {
    // fallthrough: empty / partially written lock file
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let bootId: string | null | undefined;

/**
 * Start-time identity of a process, or null when the platform cannot tell (anything without
 * /proc, e.g. macOS / Windows) or the process does not exist. On Linux this is the boot id plus
 * field 22 (starttime) of /proc/<pid>/stat, so a recycled pid never matches an old lock.
 */
export function processStart(pid: number): string | null {
  try {
    if (bootId === undefined) {
      try {
        bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      } catch {
        bootId = '';
      }
    }
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // "pid (comm) state ..." where comm may contain spaces and parentheses: split after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const starttime = rest[19]; // field 22 overall; fields 1-2 are pid and comm
    return starttime ? `${bootId}:${starttime}` : null;
  } catch {
    return null;
  }
}

let ownPidns: string | null | undefined;

/** Identity of this process's pid namespace, or null where the platform cannot tell. */
export function pidNamespace(): string | null {
  if (ownPidns === undefined) {
    try {
      ownPidns = readlinkSync('/proc/self/ns/pid');
    } catch {
      ownPidns = null;
    }
  }
  return ownPidns;
}

/**
 * True when pid checks against this holder are meaningless for us: another hostname, or the same
 * hostname but a different pid namespace (both sides known). Such a holder is only ever reclaimed
 * by heartbeat staleness, never by "its pid is dead here".
 *
 * Known limit (L3): if the namespace of either side cannot be read (no /proc, a lock written by an
 * older mwf without `pidns`), two containers that share a hostname but not a pid namespace look
 * like the same host, and one can wrongly reclaim the other's lock because the holder's pid does
 * not exist in its namespace (or belongs to an unrelated process). Give such containers distinct
 * hostnames, or share the pid namespace.
 */
export function isForeign(info: LockInfo): boolean {
  if (info.host !== hostname()) return true;
  const own = pidNamespace();
  return info.pidns !== undefined && own !== null && info.pidns !== own;
}

/** Why a lock may be taken over (null = it must be respected). */
export type Takeover = 'dead-pid' | 'pid-reused' | 'foreign-stale' | 'torn-stale';

/**
 * Lock takeover rules:
 *  - same host: ONLY when the holder is confirmed dead: its pid is gone, or the pid now belongs to
 *    a process with a different start time (pid reuse). A live same-host holder is never
 *    reclaimed, however old the lock is. Where the start time cannot be read (no /proc) or the
 *    lock predates the `start` field, we fall back to plain pid liveness.
 *  - different host, or same hostname but a different pid namespace (`isForeign`): pid checks are
 *    meaningless, so the lock is reclaimed by staleness (`staleMs` since the last heartbeat).
 *    Long operations heartbeat to stay below that.
 *  - unparseable lock file (holder died between create and write): staleness by file mtime.
 */
export function takeoverReason(
  path: string,
  info: LockInfo | null,
  staleMs: number,
  now: number,
): Takeover | null {
  if (info === null) {
    try {
      return now - statSync(path).mtimeMs > staleMs ? 'torn-stale' : null;
    } catch {
      return null;
    }
  }
  if (!isForeign(info)) {
    if (!pidAlive(info.pid)) return 'dead-pid';
    if (info.start !== undefined) {
      const current = processStart(info.pid);
      if (current !== null && current !== info.start) return 'pid-reused';
    }
    return null;
  }
  return now - info.time > staleMs ? 'foreign-stale' : null;
}

function isStale(path: string, info: LockInfo | null, staleMs: number, now: number): boolean {
  return takeoverReason(path, info, staleMs, now) !== null;
}

/** Inspect the current lock holder without touching it (for doctor/status). */
export function inspectLock(
  layout: Layout,
  opts: LockOptions = {},
): {
  held: boolean;
  /** Reclaimable right now (dead holder, or foreign-host holder past the stale age). */
  stale: boolean;
  /** Held by a process on another host; only the stale timeout protects/reclaims it. */
  foreign: boolean;
  reason: Takeover | null;
  holder: LockInfo | null;
} {
  const now = (opts.now ?? Date.now)();
  const info = readInfo(layout.lock);
  if (info === 'absent') {
    return { held: false, stale: false, foreign: false, reason: null, holder: null };
  }
  const reason = takeoverReason(layout.lock, info, opts.staleMs ?? DEFAULT_LOCK_STALE_MS, now);
  return {
    held: true,
    stale: reason !== null,
    foreign: info !== null && isForeign(info),
    reason,
    holder: info,
  };
}

function tryCreate(path: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o644); // O_CREAT | O_EXCL
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    failpoint('lock:created');
    const data = encode(info);
    writeSync(fd, data, 0, data.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  failpoint('lock:written');
  return true;
}

/**
 * Reclaim a stale lock. A second O_EXCL guard file serialises reclaimers, and the lock content
 * is re-verified under the guard, so a lock freshly created by another process is never removed.
 */
function reclaim(
  layout: Layout,
  seen: LockInfo | null,
  opts: Required<Omit<LockOptions, 'waitMs'>>,
): boolean {
  const guardInfo = holderInfo(opts.now());
  if (!tryCreate(layout.lockGuard, guardInfo)) {
    // Someone else is reclaiming; clear the guard only if its owner is dead / it is stale, and only
    // if it is still the very same guard right before we unlink it (token compare), so a guard that
    // was released and freshly re-created by another reclaimer in the meantime is never deleted.
    const guard = readInfo(layout.lockGuard);
    if (guard !== 'absent' && isStale(layout.lockGuard, guard, GUARD_STALE_MS, opts.now())) {
      const again = readInfo(layout.lockGuard);
      const same =
        again !== 'absent' &&
        (again === null ? guard === null : guard !== null && again.token === guard.token);
      if (same) {
        try {
          unlinkSync(layout.lockGuard);
        } catch {
          // someone else cleared it
        }
      }
    }
    return false;
  }
  try {
    const current = readInfo(layout.lock);
    if (current === 'absent') return true;
    const sameHolder =
      (current === null) === (seen === null) && (current === null || current.token === seen?.token);
    if (!sameHolder) return false;
    if (!isStale(layout.lock, current, opts.staleMs, opts.now())) return false;
    try {
      unlinkSync(layout.lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return true;
  } finally {
    try {
      unlinkSync(layout.lockGuard);
    } catch {
      // already gone
    }
  }
}

function holderInfo(now: number): LockInfo {
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    time: now,
    acquired: now,
    token: randomBytes(8).toString('hex'),
  };
  const start = processStart(process.pid);
  if (start !== null) info.start = start;
  const pidns = pidNamespace();
  if (pidns !== null) info.pidns = pidns;
  return info;
}

/** Lock files are padded to a fixed size so a heartbeat can rewrite them in place. */
const LOCK_FILE_BYTES = 512;

function encode(info: LockInfo): Buffer {
  const json = JSON.stringify(info);
  return Buffer.from(json.length < LOCK_FILE_BYTES ? json.padEnd(LOCK_FILE_BYTES, ' ') : json);
}

let activeHandle: LockHandle | null = null;

/**
 * Heartbeat for the lock this process currently holds (no-op otherwise). Long loops in core
 * (reindex, compact, purge, index sync) call this; it is throttled to a fraction of the stale age.
 * Throws LOCK_LOST when a heartbeat (this one, or the timer's) found the lock taken away: the
 * caller must stop writing.
 */
export function beat(): void {
  const handle = activeHandle;
  if (!handle) return;
  handle.heartbeat();
  if (handle.lost) throw lockLost(handle.info);
}

/** Verify right now that this process still owns its lock; throws LOCK_LOST otherwise (no-op without a lock). */
export function assertLockHeld(): void {
  activeHandle?.assertHeld();
}

function lockLost(info: LockInfo): MwfError {
  return new MwfError(
    'LOCK_LOST',
    'the project lock was lost (another process reclaimed it, e.g. after a long pause); the write was aborted and any half-applied change is recovered by the next lock holder',
    { pid: info.pid, host: info.host },
  );
}

function makeHandle(
  layout: Layout,
  info: LockInfo,
  reclaimed: boolean,
  staleMs: number,
  now: () => number,
): LockHandle {
  let released = false;
  let lost = false;
  let lastBeat = info.time;
  const interval = Math.max(1, Math.floor(staleMs / 4));
  const owns = (): boolean => {
    const current = readInfo(layout.lock);
    return current !== 'absent' && current !== null && current.token === info.token;
  };
  const handle: LockHandle = {
    info,
    reclaimed,
    get lost() {
      return lost;
    },
    assertHeld() {
      if (released) return;
      if (!owns()) {
        lost = true;
        throw lockLost(info);
      }
    },
    heartbeat(force = false) {
      if (released) return false;
      const t = now();
      if (!force && t - lastBeat < interval) return true;
      let fd: number;
      try {
        fd = openSync(layout.lock, 'r+');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') lost = true;
        return false;
      }
      try {
        // verify ownership through the same fd we write to: if the file was replaced, we only
        // ever touch the (unlinked) old inode.
        const buf = Buffer.alloc(1024);
        const n = readSync(fd, buf, 0, buf.length, 0);
        const current = JSON.parse(buf.subarray(0, n).toString('utf8')) as Partial<LockInfo>;
        if (current.token !== info.token) {
          lost = true;
          return false;
        }
        const data = encode({ ...info, time: t });
        writeSync(fd, data, 0, data.length, 0);
        lastBeat = t;
        return true;
      } catch {
        return false;
      } finally {
        closeSync(fd);
      }
    },
    release() {
      if (released) return;
      released = true;
      if (activeHandle === handle) activeHandle = null;
      const current = readInfo(layout.lock);
      if (current !== 'absent' && current?.token === info.token) {
        try {
          unlinkSync(layout.lock);
        } catch {
          // already gone
        }
      }
    },
  };
  activeHandle = handle;
  return handle;
}

export async function acquireLock(layout: Layout, options: LockOptions = {}): Promise<LockHandle> {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = now() + waitMs;
  let reclaimed = false;
  let delay = 5;
  for (;;) {
    const info = holderInfo(now());
    if (tryCreate(layout.lock, info)) return makeHandle(layout, info, reclaimed, staleMs, now);
    const holder = readInfo(layout.lock);
    if (holder === 'absent') continue; // released between our attempts
    if (isStale(layout.lock, holder, staleMs, now())) {
      if (reclaim(layout, holder, { staleMs, now })) {
        reclaimed = true;
        continue;
      }
    }
    if (now() >= deadline) {
      throw new MwfError('LOCK_TIMEOUT', `could not acquire ${layout.lock} within ${waitMs}ms`, {
        waitMs,
        holder,
      });
    }
    await sleep(Math.min(delay, Math.max(1, deadline - now())) + Math.floor(Math.random() * 5));
    delay = Math.min(delay * 2, 50);
  }
}
