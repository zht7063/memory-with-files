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
 * The Claude Code adapter (`mwf hook <event> --host claude`). The wire format is the same JSON
 * shape as Codex's (see ./json-host.ts); what differs, from the official hooks reference
 * (https://code.claude.com/docs/en/hooks):
 *
 *  - Stop input has NO `turn_id`; it has `prompt_id` (the user prompt being processed) and
 *    `last_assistant_message`. The turn key is prompt_id, else the last message (see turnKey).
 *    `stop_hook_active` is documented: true while Claude Code is already continuing because of a
 *    stop hook; we continue only when it is exactly `false` (unchanged), and Claude Code adds its
 *    own cap of 8 consecutive continuations.
 *  - Stop output: the default is `hookSpecificOutput.additionalContext` (guidance, no hook-error
 *    notice, same loop protections). `--stop-style block` selects `{decision:"block",reason}`.
 *  - SessionStart `source` is startup | resume | clear | compact | fork; the handler injects for
 *    all but `compact` (no compaction hook, by decision). `resume` (Claude Code re-runs
 *    SessionStart, but its transcript already holds the overview) injects only when the overview
 *    content changed since the last injection for that session (a hash in state.toml; any doubt
 *    injects) and keeps the session's already-injected recall list.
 *  - UserPromptSubmit also fires for scheduled tasks and for `/skill args` typed by the user (the
 *    raw line, not the expanded skill): `/mwf…` lines are skipped, their skill calls the tools.
 *  - additionalContext / systemMessage are capped by Claude Code at 10,000 characters each; ours
 *    stay below CLAUDE_CONTEXT_MAX (tests prove the worst case).
 *  - Tool names are `mcp__mwf__mwf_<tool>`; the handlers render them for host `claude`.
 */

export type ClaudeStopStyle = 'additional-context' | 'block';
export const CLAUDE_STOP_STYLES: readonly ClaudeStopStyle[] = ['additional-context', 'block'];
export const DEFAULT_CLAUDE_STOP_STYLE: ClaudeStopStyle = 'additional-context';

/** Claude Code replaces any additionalContext / systemMessage over 10,000 characters with a file path. */
export const CLAUDE_CONTEXT_LIMIT = 10_000;
/** Our own ceiling for what one hook answers, below the host limit. */
export const CLAUDE_CONTEXT_MAX = 9_800;

export const isClaudeStopStyle = (value: unknown): value is ClaudeStopStyle =>
  typeof value === 'string' && (CLAUDE_STOP_STYLES as readonly string[]).includes(value);

/** The user's own `/mwf`, `/mwf-save`, `/mwf:…` command lines: the skill handles memory itself. */
const OWN_COMMAND = /^\s*\/mwf(?:[\s:-]|$)/;

export function formatClaude(
  event: HookEvent,
  result: HookResult,
  stopStyle: ClaudeStopStyle = DEFAULT_CLAUDE_STOP_STYLE,
): HostOutput {
  if (event === 'stop') {
    if (!result.block) return {};
    return stopStyle === 'block'
      ? { decision: 'block', reason: result.block }
      : { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: result.block } };
  }
  return formatContext(event, result);
}

export function claudeProfile(stopStyle: ClaudeStopStyle = DEFAULT_CLAUDE_STOP_STYLE): HostProfile {
  return {
    host: 'claude',
    promptIdIsTurn: true,
    skipPrompt: (prompt) => OWN_COMMAND.test(prompt),
    format: (event, result) => formatClaude(event, result, stopStyle),
  };
}

export function handleClaude(
  event: HookEvent,
  stdin: string,
  base: HandleBase & { stopStyle?: ClaudeStopStyle } = {},
): Promise<{ output: HostOutput; after?: () => Promise<void> } | null> {
  const { stopStyle, ...rest } = base;
  return handleHost(claudeProfile(stopStyle), event, stdin, rest);
}
