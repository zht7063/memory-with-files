import { isAbsolute } from 'node:path';
import { MAX_STDIN_BYTES } from './budget.ts';
import { sessionStart, stop, userPrompt, type HookContext, type HookResult } from './handlers.ts';

/**
 * What every "JSON command hook" host shares (Codex, Claude Code): the host runs `mwf hook <event>`,
 * sends one JSON object on stdin and reads one JSON object from stdout. The host-specific parts
 * (output format, which stdin field identifies a turn, which prompts to skip) live in a
 * `HostProfile`; ./codex.ts and ./claude.ts each define one. The handlers (./handlers.ts) know
 * nothing about any host.
 */

export const HOOK_EVENTS = ['session-start', 'prompt', 'stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);
}

/** The `hook_event_name` both hosts send for each of our events. */
export const HOST_EVENT_NAME: Record<HookEvent, string> = {
  'session-start': 'SessionStart',
  prompt: 'UserPromptSubmit',
  stop: 'Stop',
};

/** The JSON a host reads back. Both hosts accept exactly these fields from us. */
export type HostOutput = {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  decision?: 'block';
  reason?: string;
};

export interface HostProfile {
  /** Host name when `--host` is not given. */
  host: string;
  /** Whether the Stop input's `prompt_id` identifies the turn (Claude Code has no `turn_id`). */
  promptIdIsTurn: boolean;
  /** A user prompt the host adapter answers with `{}` without running recall. */
  skipPrompt?: (prompt: string) => boolean;
  format: (event: HookEvent, result: HookResult) => HostOutput;
}

/** What a hook that could not run says: a one-liner for SessionStart / prompt, nothing for Stop. */
export function fallbackOutput(event: HookEvent, notice: string): HostOutput {
  return event === 'stop' ? {} : { systemMessage: notice };
}

/** The format both hosts share: context in `hookSpecificOutput`, a notice in `systemMessage`. */
export function formatContext(event: Exclude<HookEvent, 'stop'>, result: HookResult): HostOutput {
  const out: HostOutput = {};
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
export function parseHostInput(text: string): Record<string, unknown> | null {
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

export interface HandleBase extends Pick<HookContext, 'nonce' | 'now'> {
  host?: string;
  cwd?: string;
  started?: number;
}

/**
 * Run one event for `profile`. `null` means the input could not be understood (the caller prints
 * the fallback). `after` is the optional bookkeeping to run once the output has been written.
 */
export async function handleHost(
  profile: HostProfile,
  event: HookEvent,
  stdin: string,
  base: HandleBase = {},
): Promise<{ output: HostOutput; after?: () => Promise<void> } | null> {
  const input = parseHostInput(stdin);
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
    host: base.host ?? profile.host,
    ...(typeof input['session_id'] === 'string' ? { session_id: input['session_id'] } : {}),
    ...(base.started !== undefined ? { started: base.started } : {}),
    ...(base.nonce ? { nonce: base.nonce } : {}),
    ...(base.now ? { now: base.now } : {}),
  };
  let result: HookResult;
  if (event === 'session-start') {
    result = await sessionStart(
      typeof input['source'] === 'string' ? { source: input['source'] } : {},
      hc,
    );
  } else if (event === 'prompt') {
    const prompt = typeof input['prompt'] === 'string' ? input['prompt'] : undefined;
    if (prompt !== undefined && profile.skipPrompt?.(prompt)) return { output: {} };
    result = await userPrompt(prompt !== undefined ? { prompt } : {}, hc);
  } else {
    result = await stop(
      {
        stop_hook_active: input['stop_hook_active'],
        turn_id: input['turn_id'],
        ...(profile.promptIdIsTurn ? { prompt_id: input['prompt_id'] } : {}),
        last_assistant_message: input['last_assistant_message'],
      },
      hc,
    );
  }
  return {
    output: profile.format(event, result),
    ...(result.after ? { after: result.after } : {}),
  };
}
