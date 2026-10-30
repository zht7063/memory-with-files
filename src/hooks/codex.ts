import {
  HOOK_EVENTS,
  fallbackOutput as hostFallback,
  formatContext,
  handleHost,
  isHookEvent,
  parseHostInput,
  type HandleBase,
  type HookEvent,
  type HostOutput,
  type HostProfile,
} from './json-host.ts';
import type { HookResult } from './handlers.ts';

/**
 * The Codex CLI adapter: `mwf hook <event>` reads the host's JSON from stdin, runs the matching
 * handler and prints the host's JSON. Codex expects JSON on stdout (plain text would be injected as
 * context), so every outcome prints exactly one JSON object; "nothing to say" is `{}`. Shared
 * parts are in ./json-host.ts; Claude Code's differences are in ./claude.ts.
 */

export const CODEX_EVENTS = HOOK_EVENTS;
export type CodexEvent = HookEvent;
export type CodexOutput = HostOutput;

export const isCodexEvent = isHookEvent;
export const parseCodexInput = parseHostInput;
export const fallbackOutput = hostFallback;

export function formatCodex(event: CodexEvent, result: HookResult): CodexOutput {
  if (event === 'stop') {
    return result.block ? { decision: 'block', reason: result.block } : {};
  }
  return formatContext(event, result);
}

export const CODEX_PROFILE: HostProfile = {
  host: 'codex',
  promptIdIsTurn: false,
  format: formatCodex,
};

/**
 * Run one event. `null` means the input could not be understood (the caller prints the fallback).
 * `after` is the optional bookkeeping to run once the output has been written.
 */
export function handleCodex(
  event: CodexEvent,
  stdin: string,
  base: HandleBase = {},
): Promise<{ output: CodexOutput; after?: () => Promise<void> } | null> {
  return handleHost(CODEX_PROFILE, event, stdin, base);
}
