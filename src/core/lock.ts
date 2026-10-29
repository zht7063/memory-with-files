import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
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
const GUARD_STALE_MS = 10_000;

export interface LockInfo {
  pid: number;
  host: string;
  time: number;
  token: string;
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
  /** True when we reclaimed a stale lock from a dead / expired holder. */
  readonly reclaimed: boolean;
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

function isStale(path: string, info: LockInfo | null, staleMs: number, now: number): boolean {
  if (info === null) {
    // Unparseable: holder died between create and write, or is mid-write. Use file mtime.
    try {
      return now - statSync(path).mtimeMs > staleMs;
    } catch {
      return false;
    }
  }
  if (info.host === hostname() && !pidAlive(info.pid)) return true;
  return now - info.time > staleMs;
}

/** Inspect the current lock holder without touching it (for doctor/status). */
export function inspectLock(
  layout: Layout,
  opts: LockOptions = {},
): {
  held: boolean;
  stale: boolean;
  holder: LockInfo | null;
} {
  const now = (opts.now ?? Date.now)();
  const info = readInfo(layout.lock);
  if (info === 'absent') return { held: false, stale: false, holder: null };
  return {
    held: true,
    stale: isStale(layout.lock, info, opts.staleMs ?? DEFAULT_LOCK_STALE_MS, now),
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
    const data = Buffer.from(JSON.stringify(info), 'utf8');
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
  const guardInfo: LockInfo = {
    pid: process.pid,
    host: hostname(),
    time: opts.now(),
    token: randomBytes(8).toString('hex'),
  };
  if (!tryCreate(layout.lockGuard, guardInfo)) {
    // Someone else is reclaiming; clear the guard if its owner died.
    const guard = readInfo(layout.lockGuard);
    if (guard !== 'absent' && isStale(layout.lockGuard, guard, GUARD_STALE_MS, opts.now())) {
      try {
        unlinkSync(layout.lockGuard);
      } catch {
        // someone else cleared it
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

export async function acquireLock(layout: Layout, options: LockOptions = {}): Promise<LockHandle> {
  const now = options.now ?? Date.now;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = now() + waitMs;
  let reclaimed = false;
  let delay = 5;
  for (;;) {
    const info: LockInfo = {
      pid: process.pid,
      host: hostname(),
      time: now(),
      token: randomBytes(8).toString('hex'),
    };
    if (tryCreate(layout.lock, info)) {
      let released = false;
      return {
        info,
        reclaimed,
        release() {
          if (released) return;
          released = true;
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
    }
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
