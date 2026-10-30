import TOML from '@iarna/toml';
import { atomicWrite, readTextIfExists } from './fsx.ts';
import type { Layout } from './paths.ts';
import { DAY_MS } from './util.ts';

export const DEDUP_RETENTION_MS = DAY_MS;
export const DEDUP_MAX_ENTRIES = 1000;
export const MAX_SESSIONS = 200;

export interface DedupEntry {
  at: number;
  op: string;
  fingerprint: string;
  /** JSON-encoded result of the original call. */
  result: string;
}

export interface SessionEntry {
  handoff?: string;
  injected?: string[];
  /** Stop-hook guard: the turn the Stop hook already continued once (see src/hooks). */
  stop_turn?: string;
  updated: string;
}

/** state.toml: session mapping only (the request_id dedup table lives in dedup.local.toml). */
export interface State {
  schema: number;
  sessions: Record<string, SessionEntry>;
}

export function emptyState(): State {
  return { schema: 1, sessions: {} };
}

export type DedupTable = Record<string, DedupEntry>;

export function parseState(text: string | null): State {
  if (text === null || !text.trim()) return emptyState();
  const raw = TOML.parse(text) as unknown as Partial<State>;
  const state = emptyState();
  for (const [key, value] of Object.entries(raw.sessions ?? {})) {
    state.sessions[key] = { ...(value as SessionEntry) };
  }
  return state;
}

/** Parse dedup.local.toml. Throws on malformed TOML; callers decide how to degrade. */
export function parseDedup(text: string | null): DedupTable {
  const table: DedupTable = {};
  if (text === null || !text.trim()) return table;
  const raw = TOML.parse(text) as unknown as { dedup?: Record<string, DedupEntry> };
  for (const [key, e] of Object.entries(raw.dedup ?? {})) {
    table[key] = {
      at: Number(e.at),
      op: String(e.op),
      fingerprint: String(e.fingerprint),
      result: String(e.result),
    };
  }
  return table;
}

/**
 * The dedup table is a local cache of recently executed request_ids: if the file is unreadable it
 * is treated as empty (doctor reports it; the next write replaces it) rather than blocking writes.
 */
export function readDedup(layout: Layout): DedupTable {
  try {
    return parseDedup(readTextIfExists(layout.dedup));
  } catch {
    return {};
  }
}

export function stringifyDedup(table: DedupTable): string {
  const dedup: Record<string, unknown> = {};
  for (const key of Object.keys(table).sort()) dedup[key] = table[key];
  return TOML.stringify({ schema: 1, dedup } as unknown as TOML.JsonMap);
}

export function writeDedup(layout: Layout, table: DedupTable): void {
  atomicWrite(layout.dedup, stringifyDedup(table));
}

export function readState(layout: Layout): State {
  return parseState(readTextIfExists(layout.state));
}

export function stringifyState(state: State): string {
  const sessions: Record<string, unknown> = {};
  for (const key of Object.keys(state.sessions).sort()) {
    // Fields this version does not know (written by a newer mwf) are kept as they are.
    const { handoff, injected, stop_turn, updated, ...unknown } = state.sessions[
      key
    ] as SessionEntry;
    sessions[key] = {
      ...unknown,
      ...(handoff !== undefined ? { handoff } : {}),
      ...(injected ? { injected } : {}),
      ...(stop_turn !== undefined ? { stop_turn } : {}),
      updated,
    };
  }
  return TOML.stringify({ schema: state.schema, sessions } as unknown as TOML.JsonMap);
}

export function writeState(layout: Layout, state: State): void {
  atomicWrite(layout.state, stringifyState(state));
}

/** Drop expired entries (24h) and enforce the 1000-entry cap (oldest first). */
export function pruneDedup(table: DedupTable, now: number): void {
  for (const [key, entry] of Object.entries(table)) {
    if (now - entry.at > DEDUP_RETENTION_MS) delete table[key];
  }
  const keys = Object.keys(table);
  if (keys.length > DEDUP_MAX_ENTRIES) {
    keys
      .sort(
        (a, b) => (table[a] as DedupEntry).at - (table[b] as DedupEntry).at || a.localeCompare(b),
      )
      .slice(0, keys.length - DEDUP_MAX_ENTRIES)
      .forEach((key) => delete table[key]);
  }
}

export function pruneSessions(state: State): void {
  const keys = Object.keys(state.sessions);
  if (keys.length <= MAX_SESSIONS) return;
  keys
    .sort((a, b) =>
      (state.sessions[a] as SessionEntry).updated.localeCompare(
        (state.sessions[b] as SessionEntry).updated,
      ),
    )
    .slice(0, keys.length - MAX_SESSIONS)
    .forEach((key) => delete state.sessions[key]);
}
