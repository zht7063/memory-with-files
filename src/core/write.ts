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
import { atomicWrite, readBytesIfExists, removeDurable, removeTempFiles } from './fsx.ts';
import { acquireLock } from './lock.ts';
import { REQUEST_ID_RE, type Layout } from './paths.ts';
import { pruneDedup, readState, writeState } from './state.ts';
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
  targets: Array<{ path: string; hash: string | null }>;
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
  const state = readState(layout);
  state.dedup[entry.request_id] = {
    at: now,
    op: entry.op,
    fingerprint: entry.fingerprint,
    result: JSON.stringify(entry.result),
  };
  pruneDedup(state, now);
  writeState(layout, state);
}

/**
 * Recover an intent left behind by a crashed writer. If every target already matches the intended
 * content hash the write completed: finish the dedup registration. Otherwise discard the intent
 * (the caller may retry with the same request_id; ops are written to be re-executable).
 */
function recoverIntent(layout: Layout, now: number): 'none' | 'completed' | 'discarded' {
  const intent = readIntent(layout);
  if (!intent) {
    if (readBytesIfExists(layout.intent) !== null) {
      removeDurable(layout.intent);
      return 'discarded';
    }
    return 'none';
  }
  const complete = intent.targets.every((t) => fileHash(layout, t.path) === t.hash);
  if (complete) {
    registerDedup(layout, now, intent);
    removeDurable(layout.intent);
    return 'completed';
  }
  removeDurable(layout.intent);
  return 'discarded';
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
    try {
      syncIndex(db, layout);
      const value = await fn({ layout, db, now: nowOf(ctx) });
      checkpoint(db);
      return value;
    } finally {
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
 * (request_id, target paths, content hashes) -> atomically apply every target -> sync index.db ->
 * register request_id in state.toml -> remove intent -> WAL checkpoint (in withLock).
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
    const state = readState(layout);
    const prior = state.dedup[requestId];
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
    const plan = await build({ layout, db, now, requestId, ctx });
    const intent: Intent = {
      request_id: requestId,
      op,
      fingerprint,
      at: now,
      targets: plan.targets.map((t) => ({
        path: t.path,
        hash: t.content === null ? null : sha256(t.content),
      })),
      result: plan.result,
    };
    if (plan.targets.length) {
      atomicWrite(layout.intent, JSON.stringify(intent));
      failpoint('write:intent');
      for (const target of plan.targets) {
        if (target.content === null) removeDurable(abs(layout, target.path));
        else atomicWrite(abs(layout, target.path), target.content);
        failpoint('write:target');
      }
      if (plan.rebuild) rebuildIndex(db, layout);
      else syncIndex(db, layout);
      failpoint('write:indexed');
    }
    registerDedup(layout, now, intent);
    failpoint('write:dedup');
    if (plan.targets.length) removeDurable(layout.intent);
    failpoint('write:done');
    return { ...plan.result, request_id: requestId, deduped: false };
  });
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
  const ro = openIndexReadOnly(layout);
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
