import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  requireInitialized,
  nowOf,
  staleOf,
  waitOf,
  type Ctx,
  type WriteInput,
} from './context.ts';
import {
  checkpoint,
  diffIndex,
  openIndex,
  openIndexReadOnly,
  rebuildIndex,
  scanFiles,
  syncIndex,
} from './db.ts';
import { invalid, MwfError } from './errors.ts';
import { failpoint } from './failpoint.ts';
import { recordSkipped, type SkippedRemoval } from './recovery.ts';
import { atomicWrite, readBytesIfExists, removeDurable, removeTempFiles } from './fsx.ts';
import { acquireLock, assertLockHeld, beat, inspectLock } from './lock.ts';
import { REQUEST_ID_RE, type Layout } from './paths.ts';
import { buildIndexMd } from './indexmd.ts';
import { loadAll } from './load.ts';
import { assertNoSecrets, isScannedPath } from './secrets.ts';
import { pruneDedup, readDedup, writeDedup } from './state.ts';
import { canonicalJson, newRequestId, sha256 } from './util.ts';

/** One file effect of a write: set content, or remove the file when content is null. */
export interface Target {
  /** Path relative to .mwf/ (posix). */
  path: string;
  content: string | null;
}

export interface Plan<R> {
  targets: Target[];
  result: R;
  /** Rebuild index.db from scratch (reindex) instead of an incremental sync. */
  rebuild?: boolean;
}

export interface WriteEnv {
  layout: Layout;
  db: DatabaseSync;
  now: number;
  requestId: string;
  ctx: Ctx;
}

export type WriteResult<R> = R & { request_id: string; deduped: boolean };

interface Intent {
  request_id: string;
  op: string;
  fingerprint: string;
  at: number;
  /**
   * `hash` is the content hash the target must end up with (null = file removed). For removals
   * `prior` is the hash of the file as planned for removal, so a roll-forward never deletes a
   * file that was modified in the meantime.
   */
  targets: Array<{ path: string; hash: string | null; prior?: string | null }>;
  result: unknown;
}

function abs(layout: Layout, rel: string): string {
  return join(layout.mwf, ...rel.split('/'));
}

function fileHash(layout: Layout, rel: string): string | null {
  const bytes = readBytesIfExists(abs(layout, rel));
  return bytes === null ? null : sha256(bytes);
}

function readIntent(layout: Layout): Intent | null {
  const bytes = readBytesIfExists(layout.intent);
  if (bytes === null) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as Intent;
    if (typeof parsed.request_id === 'string' && Array.isArray(parsed.targets)) return parsed;
  } catch {
    // corrupt intent: treat as discardable below
  }
  return null;
}

function registerDedup(layout: Layout, now: number, entry: Omit<Intent, 'targets' | 'at'>): void {
  const table = readDedup(layout);
  table[entry.request_id] = {
    at: now,
    op: entry.op,
    fingerprint: entry.fingerprint,
    result: JSON.stringify(entry.result),
  };
  pruneDedup(table, now);
  writeDedup(layout, table);
}

/**
 * Recover an intent left behind by a crashed writer. If every target already matches the intended
 * content hash the write completed: finish the dedup registration. If only removals are pending
 * (all content writes durable) they are rolled forward first. Otherwise discard the intent (the
 * caller may retry with the same request_id; nothing was removed yet, so the retry sees the
 * original state).
 */
function recoverIntent(layout: Layout, now: number): 'none' | 'completed' | 'discarded' {
  const intent = readIntent(layout);
  if (!intent) {
    if (readBytesIfExists(layout.intent) !== null) {
      repairIndexMd(layout);
      removeDurable(layout.intent);
      return 'discarded';
    }
    return 'none';
  }
  const matches = (t: Intent['targets'][number]): boolean => fileHash(layout, t.path) === t.hash;
  // Writes always precede removals (see runWrite). When every written target is already durable
  // the destructive op had been authorised and its replacement copies exist, so a crash between
  // the removals is ROLLED FORWARD: the remaining removals are performed (only for files that
  // still hold the planned content). Without this a half-finished forget/compact/purge could
  // never be retried (the preview_token / NOT_FOUND checks no longer see the original state).
  const writes = intent.targets.filter((t) => t.hash !== null);
  const skipped: SkippedRemoval[] = [];
  if (writes.every(matches)) {
    for (const t of intent.targets) {
      if (t.hash !== null || matches(t)) continue;
      const found = fileHash(layout, t.path);
      if (t.prior !== undefined && found === t.prior) {
        removeDurable(abs(layout, t.path));
      } else if (t.prior !== undefined) {
        // The file changed after the removal was planned: keep it, and make doctor say so (L1).
        skipped.push({
          at: now,
          request_id: intent.request_id,
          op: intent.op,
          path: t.path,
          expected: t.prior,
          found,
        });
      }
    }
  }
  // Recorded BEFORE the intent goes away, so a crash here repeats the whole recovery.
  recordSkipped(layout, now, skipped);
  // index.md is written FIRST in every plan, so a discarded (or otherwise interrupted) intent can
  // leave it describing records that never landed (or missing ones that did). Rebuild it from the
  // records actually on disk BEFORE the intent is removed: if we crash in here the intent is still
  // there and the next lock holder simply repeats this.
  repairIndexMd(layout);
  if (intent.targets.every(matches)) {
    registerDedup(layout, now, intent);
    removeDurable(layout.intent);
    return 'completed';
  }
  removeDurable(layout.intent);
  return 'discarded';
}

/** Rewrite index.md from the record files on disk if it differs (no-op when current). */
function repairIndexMd(layout: Layout): void {
  const content = buildIndexMd(loadAll(layout));
  if (readFileText(layout, 'index.md') !== content) atomicWrite(layout.indexMd, content);
}

export interface LockedSession {
  layout: Layout;
  db: DatabaseSync;
  now: number;
}

/**
 * Run fn holding the project lock: reclaim stale lock, clean `.tmp-*` leftovers, recover intents,
 * bring index.db in line with the files. WAL is checkpointed before the lock is released.
 */
export async function withLock<T>(
  ctx: Ctx,
  waitMs: number | undefined,
  fn: (session: LockedSession) => Promise<T> | T,
): Promise<T> {
  const layout = requireInitialized(ctx);
  const lock = await acquireLock(layout, {
    waitMs: waitOf(ctx, waitMs),
    staleMs: staleOf(ctx),
    now: ctx.now ?? Date.now,
  });
  try {
    failpoint('lock:held');
    removeTempFiles(layout.mwf);
    recoverIntent(layout, nowOf(ctx));
    const { db } = openIndex(layout, nowOf(ctx));
    // Heartbeat while awaiting (sync loops call beat() themselves; timers cannot fire during them).
    const timer = setInterval(() => lock.heartbeat(), Math.max(1, Math.floor(staleOf(ctx) / 4)));
    timer.unref();
    try {
      syncIndex(db, layout);
      const value = await fn({ layout, db, now: nowOf(ctx) });
      checkpoint(db);
      return value;
    } finally {
      clearInterval(timer);
      db.close();
    }
  } finally {
    lock.release();
  }
}

export function resolveRequestId(input: WriteInput): string {
  if (input.request_id === undefined) return newRequestId();
  if (typeof input.request_id !== 'string' || !REQUEST_ID_RE.test(input.request_id)) {
    throw invalid('request_id must match [A-Za-z0-9._:-]{1,128}');
  }
  return input.request_id;
}

export function validateWait(input: WriteInput): number | undefined {
  if (input.wait_ms === undefined) return undefined;
  if (!Number.isFinite(input.wait_ms) || input.wait_ms < 0 || input.wait_ms > 600_000) {
    throw invalid('wait_ms must be between 0 and 600000');
  }
  return input.wait_ms;
}

/**
 * The single write path (everything that mutates .mwf/ goes through here).
 *
 * Inside the lock: dedup lookup -> build plan (hash / version checks happen here) -> write intent
 * (request_id, target paths, content hashes; includes the regenerated index.md) -> atomically apply
 * every target -> sync index.db ->
 * register request_id in dedup.local.toml -> remove intent -> WAL checkpoint (in withLock).
 */
export async function runWrite<R extends object>(
  ctx: Ctx,
  op: string,
  input: WriteInput,
  args: unknown,
  build: (env: WriteEnv) => Plan<R> | Promise<Plan<R>>,
): Promise<WriteResult<R>> {
  const requestId = resolveRequestId(input);
  const waitMs = validateWait(input);
  const fingerprint = sha256(canonicalJson({ op, args }));
  return withLock(ctx, waitMs, async ({ layout, db, now }) => {
    const prior = readDedup(layout)[requestId];
    if (prior && now - prior.at <= 24 * 60 * 60 * 1000) {
      if (prior.op !== op || prior.fingerprint !== fingerprint) {
        throw new MwfError(
          'REQUEST_ID_REUSED',
          'request_id was already used for a different request',
          {
            request_id: requestId,
          },
        );
      }
      return { ...(JSON.parse(prior.result) as R), request_id: requestId, deduped: true };
    }
    const built = await build({ layout, db, now, requestId, ctx });
    // Secret scan: nothing is written (not even the intent) if the plan introduces a likely secret.
    assertNoSecrets(
      built.targets.flatMap((t) =>
        t.content !== null && isScannedPath(t.path)
          ? [{ path: t.path, before: readFileText(layout, t.path), after: t.content }]
          : [],
      ),
    );
    // index.md is part of the same plan (same intent, same recovery) whenever records/handoffs
    // change; it is written FIRST so that no state with the new record present has a stale index.
    const indexTarget = planIndexMd(layout, built.targets);
    // Invariant: every content write is applied before any removal, so a crash never loses data
    // (replacement copies exist before originals go) and recoverIntent can roll removals forward.
    const plan = {
      ...built,
      targets: [
        ...(indexTarget ? [indexTarget] : []),
        ...built.targets.filter((t) => t.content !== null),
        ...built.targets.filter((t) => t.content === null),
      ],
    };
    const intent: Intent = {
      request_id: requestId,
      op,
      fingerprint,
      at: now,
      targets: plan.targets.map((t) =>
        t.content === null
          ? { path: t.path, hash: null, prior: fileHash(layout, t.path) }
          : { path: t.path, hash: sha256(t.content) },
      ),
      result: plan.result,
    };
    if (plan.targets.length) {
      // L4: a lock that was reclaimed from under us (long pause, clock jump, foreign-host
      // staleness) must stop the write before anything touches disk. Checked again before every
      // target and before the index sync / dedup registration; the remains of an aborted write are
      // an intent, which the next lock holder recovers.
      assertLockHeld();
      atomicWrite(layout.intent, JSON.stringify(intent));
      failpoint('write:intent');
      for (const target of plan.targets) {
        assertLockHeld();
        beat();
        if (target.content === null) removeDurable(abs(layout, target.path));
        else atomicWrite(abs(layout, target.path), target.content);
        failpoint('write:target');
      }
      assertLockHeld();
      if (plan.rebuild) rebuildIndex(db, layout);
      else syncIndex(db, layout);
      failpoint('write:indexed');
    }
    assertLockHeld();
    registerDedup(layout, now, intent);
    failpoint('write:dedup');
    if (plan.targets.length) removeDurable(layout.intent);
    failpoint('write:done');
    return { ...plan.result, request_id: requestId, deduped: false };
  });
}

/** index.md as it will be once `targets` are applied; null when unaffected or already current. */
function planIndexMd(layout: Layout, targets: Target[]): Target | null {
  if (targets.some((t) => t.path === 'index.md')) return null; // reindex supplies its own
  if (!targets.some((t) => t.path.startsWith('memory/') || t.path.startsWith('handoff/')))
    return null;
  const overlay = new Map(targets.map((t) => [t.path, t.content] as const));
  const content = buildIndexMd(loadAll(layout, overlay));
  return readFileText(layout, 'index.md') === content ? null : { path: 'index.md', content };
}

function pendingDeadIntent(ctx: Ctx, layout: Layout): boolean {
  if (readBytesIfExists(layout.intent) === null) return false;
  const lock = inspectLock(layout, { staleMs: staleOf(ctx), now: ctx.now ?? Date.now });
  return !lock.held || lock.stale;
}

export interface ReadSession {
  db: DatabaseSync;
  layout: Layout;
  warnings: string[];
}

/**
 * Run a read against the index. If the index is missing or out of step with the record files, try
 * to repair it under the lock (files win); when the lock cannot be had within the wait budget,
 * serve the stale index with a warning.
 */
export async function withIndexRead<T>(
  ctx: Ctx,
  fn: (session: ReadSession) => Promise<T> | T,
  waitMs?: number,
): Promise<T> {
  const layout = requireInitialized(ctx);
  const warnings: string[] = [];
  // A leftover intent (its writer died: nobody holds the lock) must be recovered, which also repairs
  // index.md, even when index.db happens to be in step with the files; so skip the lock-free fast
  // path in that case. A live writer's intent is left alone (its lock is held).
  const ro = pendingDeadIntent(ctx, layout) ? null : openIndexReadOnly(layout);
  if (ro) {
    let fresh = false;
    try {
      const diff = diffIndex(ro, scanFiles(layout));
      fresh = diff.changed.length === 0 && diff.removed.length === 0;
      if (fresh) return await fn({ db: ro, layout, warnings });
    } finally {
      ro.close();
    }
  }
  try {
    return await withLock(ctx, waitMs ?? Math.min(waitOf(ctx), 1500), ({ db }) =>
      fn({ db, layout, warnings }),
    );
  } catch (error) {
    if (error instanceof MwfError && error.code === 'LOCK_TIMEOUT') {
      const stale = openIndexReadOnly(layout);
      if (!stale) {
        throw new MwfError(
          'INDEX_UNAVAILABLE',
          'index.db is missing and the lock is busy; retry or run reindex',
          {},
        );
      }
      try {
        warnings.push('index may be stale: could not take the write lock to refresh it');
        return await fn({ db: stale, layout, warnings });
      } finally {
        stale.close();
      }
    }
    throw error;
  }
}

export function readFileText(layout: Layout, rel: string): string | null {
  try {
    return readFileSync(abs(layout, rel), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export { abs as absPath, fileHash };
