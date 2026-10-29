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
  updated: string;
}

export interface State {
  schema: number;
  sessions: Record<string, SessionEntry>;
  dedup: Record<string, DedupEntry>;
}

export function emptyState(): State {
  return { schema: 1, sessions: {}, dedup: {} };
}

export function parseState(text: string | null): State {
  if (text === null || !text.trim()) return emptyState();
  const raw = TOML.parse(text) as unknown as Partial<State>;
  const state = emptyState();
  for (const [key, value] of Object.entries(raw.sessions ?? {})) {
    state.sessions[key] = { ...(value as SessionEntry) };
  }
  for (const [key, value] of Object.entries(raw.dedup ?? {})) {
    const e = value as DedupEntry;
    state.dedup[key] = {
      at: Number(e.at),
      op: String(e.op),
      fingerprint: String(e.fingerprint),
      result: String(e.result),
    };
  }
  return state;
}

export function readState(layout: Layout): State {
  return parseState(readTextIfExists(layout.state));
}

export function stringifyState(state: State): string {
  const sessions: Record<string, unknown> = {};
  for (const key of Object.keys(state.sessions).sort()) {
    const s = state.sessions[key] as SessionEntry;
    sessions[key] = {
      ...(s.handoff !== undefined ? { handoff: s.handoff } : {}),
      ...(s.injected ? { injected: s.injected } : {}),
      updated: s.updated,
    };
  }
  const dedup: Record<string, unknown> = {};
  for (const key of Object.keys(state.dedup).sort()) dedup[key] = state.dedup[key];
  return TOML.stringify({ schema: state.schema, sessions, dedup } as unknown as TOML.JsonMap);
}

export function writeState(layout: Layout, state: State): void {
  atomicWrite(layout.state, stringifyState(state));
}

/** Drop expired entries (24h) and enforce the 1000-entry cap (oldest first). */
export function pruneDedup(state: State, now: number): void {
  for (const [key, entry] of Object.entries(state.dedup)) {
    if (now - entry.at > DEDUP_RETENTION_MS) delete state.dedup[key];
  }
  const keys = Object.keys(state.dedup);
  if (keys.length > DEDUP_MAX_ENTRIES) {
    keys
      .sort(
        (a, b) =>
          (state.dedup[a] as DedupEntry).at - (state.dedup[b] as DedupEntry).at ||
          a.localeCompare(b),
      )
      .slice(0, keys.length - DEDUP_MAX_ENTRIES)
      .forEach((key) => delete state.dedup[key]);
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
