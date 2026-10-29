import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MwfError } from './errors.ts';
import { layoutOf, type Layout } from './paths.ts';
import { DEFAULT_LOCK_HELD_WARN_MS, DEFAULT_LOCK_STALE_MS, DEFAULT_WAIT_MS } from './lock.ts';

export interface Ctx {
  /** Project root: the directory that contains (or will contain) `.mwf/`. */
  root: string;
  /** Clock injection for tests (epoch ms). */
  now?: () => number;
  /** Default lock wait budget. MCP: 5000 (default). Hooks: 2000, then caller proceeds/gives up. */
  waitMs?: number;
  /** Heartbeat age after which a lock held from ANOTHER host is reclaimable (default 30s). Same-host locks (same hostname and pid namespace) are never reclaimed while the holder is alive. */
  lockStaleMs?: number;
  /** doctor reports a live lock held for longer than this many ms (default 120000). */
  lockHeldWarnMs?: number;
}

/** Options accepted by every write operation. */
export interface WriteInput {
  /** Idempotency key. Auto-generated when absent. */
  request_id?: string;
  /** Per-call lock wait budget (ms); overrides ctx.waitMs. */
  wait_ms?: number;
}

export function nowOf(ctx: Ctx): number {
  return (ctx.now ?? Date.now)();
}

export function layoutFor(ctx: Ctx): Layout {
  return layoutOf(resolve(ctx.root));
}

export function waitOf(ctx: Ctx, override?: number): number {
  return override ?? ctx.waitMs ?? DEFAULT_WAIT_MS;
}

export function staleOf(ctx: Ctx): number {
  return ctx.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
}

export function heldWarnOf(ctx: Ctx): number {
  return ctx.lockHeldWarnMs ?? DEFAULT_LOCK_HELD_WARN_MS;
}

export function requireInitialized(ctx: Ctx): Layout {
  const layout = layoutFor(ctx);
  if (!existsSync(layout.config)) {
    throw new MwfError('NOT_INITIALIZED', `no .mwf/ in ${layout.root}; run init first`, {
      root: layout.root,
    });
  }
  return layout;
}

/** Nearest ancestor of `start` that contains `.mwf/config.toml`, or null. */
export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.mwf', 'config.toml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
