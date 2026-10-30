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
