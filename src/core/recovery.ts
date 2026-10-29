import { readTextIfExists, atomicWrite } from './fsx.ts';
import type { Layout } from './paths.ts';
import { DAY_MS } from './util.ts';

/**
 * A roll-forward of a half-finished destructive write removes the files the interrupted writer
 * had planned to remove, but only those that still hold the planned content (`prior` hash). A
 * file that changed in the meantime (hand-edited, or rewritten by another tool) is LEFT in place
 * and recorded here so doctor can tell the user (L1). Machine-local (`*.local.*` is gitignored)
 * because it describes what happened on this machine.
 */
export interface SkippedRemoval {
  at: number;
  request_id: string;
  op: string;
  /** Path relative to `.mwf/`. */
  path: string;
  /** Hash the removal was planned against. */
  expected: string | null;
  /** Hash of the file when the roll-forward looked at it. */
  found: string | null;
}

export const RECOVERY_RETENTION_MS = 30 * DAY_MS;
export const RECOVERY_MAX_ENTRIES = 100;

export function readSkipped(layout: Layout): SkippedRemoval[] {
  const text = readTextIfExists(layout.recovery);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { skipped?: unknown };
    if (!Array.isArray(parsed.skipped)) return [];
    return parsed.skipped.filter(
      (e): e is SkippedRemoval =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as SkippedRemoval).path === 'string' &&
        typeof (e as SkippedRemoval).at === 'number' &&
        typeof (e as SkippedRemoval).request_id === 'string',
    );
  } catch {
    return [];
  }
}

/** Append entries (deduplicated by request_id + path), pruning old ones. Call inside the lock. */
export function recordSkipped(layout: Layout, now: number, entries: SkippedRemoval[]): void {
  if (!entries.length) return;
  const all = readSkipped(layout).filter((e) => now - e.at <= RECOVERY_RETENTION_MS);
  for (const entry of entries) {
    if (!all.some((e) => e.request_id === entry.request_id && e.path === entry.path)) {
      all.push(entry);
    }
  }
  const kept = all.slice(-RECOVERY_MAX_ENTRIES);
  atomicWrite(layout.recovery, JSON.stringify({ skipped: kept }, null, 2) + '\n');
}
