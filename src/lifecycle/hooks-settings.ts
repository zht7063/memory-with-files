// The Claude Code flavour of the hooks document: `<config dir>/settings.json`, "hooks" key.
//
// Claude Code supports an exec form for a command hook: `command` is the program and `args` its
// argument vector, so nothing goes through a shell (no quoting to get wrong, no expansion). Ours is
//   { "type": "command", "command": "<node>", "args": ["<mwf.js>", "hook", "<event>", "--host", "claude"],
//     "timeout": 5, "statusMessage": "mwf" }
// A handler is ours only when `args` is EXACTLY `[<path>/mwf.js, hook, <event>, --host, claude]`
// (the `--host claude` pair is a hard condition, so a Codex shell-form hook, or anything of
// someone else's that merely mentions mwf.js, is never recognised and never touched).
import { basename } from 'node:path';
import { HOOK_EVENTS, HOOK_TIMEOUT_S, type HookFlavor } from './hooks-doc.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const ARGS = new Set(HOOK_EVENTS.map((e) => e.arg));

export function claudeIsOurs(handler: unknown): boolean {
  if (!isObj(handler) || handler['type'] !== 'command' || typeof handler['command'] !== 'string')
    return false;
  const args = handler['args'];
  return (
    Array.isArray(args) &&
    args.length === 5 &&
    args.every((a) => typeof a === 'string') &&
    basename(args[0] as string) === 'mwf.js' &&
    args[1] === 'hook' &&
    ARGS.has(args[2] as string) &&
    args[3] === '--host' &&
    args[4] === 'claude'
  );
}

export const CLAUDE_FLAVOR: HookFlavor = {
  file: 'settings.json',
  isOurs: claudeIsOurs,
  handler: (node, mwfJs, arg) => ({
    type: 'command',
    command: node,
    args: [mwfJs, 'hook', arg, '--host', 'claude'],
    timeout: HOOK_TIMEOUT_S,
    statusMessage: 'mwf',
  }),
};
