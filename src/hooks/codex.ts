import { isAbsolute } from 'node:path';
import { MAX_STDIN_BYTES } from './budget.ts';
import { sessionStart, stop, userPrompt, type HookContext, type HookResult } from './handlers.ts';

/**
 * The Codex CLI adapter: `mwf hook <event>` reads the host's JSON from stdin, runs the matching
 * handler and prints the host's JSON. Codex expects JSON on stdout (plain text would be injected as
 * context), so every outcome prints exactly one JSON object; "nothing to say" is `{}`.
 */

export const CODEX_EVENTS = ['session-start', 'prompt', 'stop'] as const;
export type CodexEvent = (typeof CODEX_EVENTS)[number];

const HOST_EVENT_NAME: Record<CodexEvent, string> = {
  'session-start': 'SessionStart',
  prompt: 'UserPromptSubmit',
  stop: 'Stop',
};

export type CodexOutput = {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  decision?: 'block';
  reason?: string;
};

export function isCodexEvent(value: unknown): value is CodexEvent {
  return typeof value === 'string' && (CODEX_EVENTS as readonly string[]).includes(value);
}

/** What a hook that could not run says: a one-liner for SessionStart / prompt, nothing for Stop. */
export function fallbackOutput(event: CodexEvent, notice: string): CodexOutput {
  return event === 'stop' ? {} : { systemMessage: notice };
}

export function formatCodex(event: CodexEvent, result: HookResult): CodexOutput {
  if (event === 'stop') {
    return result.block ? { decision: 'block', reason: result.block } : {};
  }
  const out: CodexOutput = {};
  if (result.notice) out.systemMessage = result.notice;
  if (result.inject) {
    out.hookSpecificOutput = {
      hookEventName: HOST_EVENT_NAME[event],
      additionalContext: result.inject,
    };
  }
  return out;
}

/** Parse the host's stdin. Returns null when it is not a JSON object (the caller falls back). */
export function parseCodexInput(text: string): Record<string, unknown> | null {
  if (Buffer.byteLength(text) > MAX_STDIN_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Run one event. `null` means the input could not be understood (the caller prints the fallback).
 * `after` is the optional bookkeeping to run once the output has been written.
 */
export async function handleCodex(
  event: CodexEvent,
  stdin: string,
  base: { host?: string; cwd?: string; started?: number } & Pick<HookContext, 'nonce' | 'now'> = {},
): Promise<{ output: CodexOutput; after?: () => Promise<void> } | null> {
  const input = parseCodexInput(stdin);
  if (input === null) return null;
  // A hook_event_name that disagrees with the command line means a wrong hooks file: do nothing.
  const name = input['hook_event_name'];
  if (name !== undefined && name !== HOST_EVENT_NAME[event]) return { output: {} };
  const cwd =
    typeof input['cwd'] === 'string' && isAbsolute(input['cwd'])
      ? input['cwd']
      : (base.cwd ?? process.cwd());
  const hc: HookContext = {
    cwd,
    host: base.host ?? 'codex',
    ...(typeof input['session_id'] === 'string' ? { session_id: input['session_id'] } : {}),
    ...(base.started !== undefined ? { started: base.started } : {}),
    ...(base.nonce ? { nonce: base.nonce } : {}),
    ...(base.now ? { now: base.now } : {}),
  };
  const result =
    event === 'session-start'
      ? await sessionStart(
          typeof input['source'] === 'string' ? { source: input['source'] } : {},
          hc,
        )
      : event === 'prompt'
        ? await userPrompt(
            typeof input['prompt'] === 'string' ? { prompt: input['prompt'] } : {},
            hc,
          )
        : await stop(
            {
              stop_hook_active: input['stop_hook_active'],
              turn_id: input['turn_id'],
              last_assistant_message: input['last_assistant_message'],
            },
            hc,
          );
  return {
    output: formatCodex(event, result),
    ...(result.after ? { after: result.after } : {}),
  };
}
