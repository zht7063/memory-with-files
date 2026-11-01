import type { HookResult } from './handlers.ts';
import {
  formatContext,
  handleHost,
  type HandleBase,
  type HookEvent,
  type HostOutput,
  type HostProfile,
} from './json-host.ts';

/**
 * The Pi adapter (`mwf hook <event> --host pi`). Pi has no hooks file: `mwf install --harness pi`
 * writes a thin extension (see ../lifecycle/pi-extension.ts) that runs this command, exactly as
 * Codex and Claude Code run it, so the supervisor, the worker, the time budgets and the fence all
 * apply unchanged. The extension sends the same JSON object the other hosts do:
 *
 *   { hook_event_name: "SessionStart" | "UserPromptSubmit" | "Stop", session_id, cwd,
 *     source?, prompt?, prompt_id?, stop_hook_active? }
 *
 * and reads one JSON object back, in the format Codex and Claude Code share (`systemMessage`,
 * `hookSpecificOutput.additionalContext`, `decision: "block"` + `reason` for Stop), then turns it into
 * Pi's own result (a custom message from `before_agent_start`; a custom message entry plus
 * `continue: true` from `agent_before_settle`).
 *
 *  - `session_id` is Pi's `ctx.sessionManager.getSessionId()`. The extension sends no `session_id` when
 *    Pi has none, and then the handlers keep no per-session state and Stop never continues.
 *  - `prompt_id` is `<session id>:<n>`, one per user prompt; it is the Stop turn key (the extension
 *    asks for at most one continuation per prompt, and the atomic claim in `.mwf/state.toml` allows
 *    one per turn key besides).
 *  - Tool names are `mcp__mwf__mwf_<tool>`; the handlers render them for host `pi`.
 */

/** The user's own `/mwf` and `/skill:mwf…` lines: the command or skill handles memory itself. */
const OWN_COMMAND = /^\s*\/(?:mwf(?:[\s:-]|$)|skill:mwf)/;

export function formatPi(event: HookEvent, result: HookResult): HostOutput {
  if (event === 'stop') return result.block ? { decision: 'block', reason: result.block } : {};
  return formatContext(event, result);
}

export const PI_PROFILE: HostProfile = {
  host: 'pi',
  promptIdIsTurn: true,
  skipPrompt: (prompt) => OWN_COMMAND.test(prompt),
  format: formatPi,
};

export function handlePi(
  event: HookEvent,
  stdin: string,
  base: HandleBase = {},
): Promise<{ output: HostOutput; after?: () => Promise<void> } | null> {
  return handleHost(PI_PROFILE, event, stdin, base);
}
