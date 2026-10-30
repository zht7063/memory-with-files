import * as core from '../core/index.ts';
import { resolveCtx, type CliEnv } from './commands.ts';
import { toError, type CliResult } from './result.ts';

export interface ConfirmHostArgs {
  /** Host name: lowercase letters, digits, `_` or `-`, starting with a letter (e.g. `codex`, `pi`). */
  host: string;
  channel: 'hook' | 'mcp' | 'extension';
}

/**
 * Host registration, not a command and not a tool: record (once) that a host loaded mwf through
 * `channel`, in the machine-local host.local.toml. Used by the MCP server on its first tool call
 * and by hooks; it never fails the caller's real work, so callers may ignore a failed result.
 */
export async function confirmHost(args: ConfirmHostArgs, env: CliEnv = {}): Promise<CliResult> {
  try {
    const ctx = resolveCtx(env);
    return { ok: true, data: await core.confirmHost(ctx, args) };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}

export interface GetSessionData {
  /** Null when the session has no entry yet. */
  session: { handoff?: string; injected?: string[]; stop_turn?: string; updated: string } | null;
}

/**
 * Read one session's mapping from state.toml (no lock, no write). Like `confirmHost` it is a
 * helper for hooks, not a command: it never throws, and `ok: false` (no `.mwf/`, unreadable or
 * malformed state.toml) means "unknown", which hooks must treat as "do nothing".
 */
export async function getSession(sessionId: string, env: CliEnv = {}): Promise<CliResult> {
  try {
    const ctx = resolveCtx(env);
    const session = core.getSession(ctx, sessionId);
    return { ok: true, data: { session } satisfies GetSessionData };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}

export interface SetSessionArgs {
  session_id: string;
  /** Task whose handoff this session continues. */
  handoff?: string;
  /** Ids already injected into this session (the last 200 are kept). */
  injected?: string[];
  /** Stop-hook guard marker: the turn the Stop hook already continued once. */
  stop_turn?: string;
  /** With `stop_turn`: claim atomically; `data.claimed` is false when the turn was already claimed. */
  claim_stop_turn?: boolean;
  request_id?: string;
  /** Lock wait budget in ms; hooks pass a very small one. */
  wait_ms?: number;
}

/**
 * Update a session's mapping in state.toml through the single MWF write path (lock, intent,
 * atomic write, request_id dedup). Never throws; `ok: false` is for the caller to ignore or act on.
 */
export async function setSession(args: SetSessionArgs, env: CliEnv = {}): Promise<CliResult> {
  try {
    const ctx = resolveCtx(env);
    return { ok: true, data: await core.setSession(ctx, args) };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}
