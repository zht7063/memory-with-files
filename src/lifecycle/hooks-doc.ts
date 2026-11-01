// Editing a hooks document (Codex `hooks.json`, Claude Code `settings.json`): add, replace and
// remove only mwf's own handlers.
//
// What makes a handler "ours" is a HookFlavor. Codex: a command hook whose command parses (POSIX
// quoting, no expansion) into exactly `<node> <path>/mwf.js hook <event>`. Claude Code (see
// hooks-settings.ts): an exec-form hook (`command` + `args`) whose args are exactly
// `[<path>/mwf.js, hook, <event>, --host, claude]`. Nothing user-visible (statusMessage) is used
// to recognise a handler. Everything else in the document (other tools' hooks, unknown events,
// other top-level fields) is left exactly as it was; `checkOnlyOursChanged` proves it.
import { basename } from 'node:path';
import { clone, deepEqual } from './json-edit.ts';

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'Stop';

/** Our three events, the `mwf hook` argument for each, and the matcher Codex applies (if any). */
export const HOOK_EVENTS: ReadonlyArray<{ event: HookEvent; arg: string; matcher?: string }> = [
  // `compact` is deliberately absent: nothing is injected after a compaction.
  { event: 'SessionStart', arg: 'session-start', matcher: 'startup|resume|clear|fork' },
  { event: 'UserPromptSubmit', arg: 'prompt' },
  { event: 'Stop', arg: 'stop' },
];

/** The host timeout, in seconds (HOST_TIMEOUT_S in the hooks layer; Codex defaults to 600). */
export const HOOK_TIMEOUT_S = 5;

export class HooksDocError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export class UnquotableError extends Error {}

/** Quote one word for a POSIX shell. Refuses anything that cannot be quoted safely. */
export function shellQuote(word: string): string {
  // eslint-disable-next-line no-control-regex
  if (word === '' || /[\u0000-\u001f\u007f]/.test(word))
    throw new UnquotableError(`cannot quote ${JSON.stringify(word)}`);
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Split a shell command into words, or null when it uses anything but plain quoting. */
export function splitCommand(command: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      for (;;) {
        const d = command[i];
        if (d === undefined) return null;
        if (d === '"') break;
        if (d === '$' || d === '`') return null;
        if (d === '\\') {
          const n = command[i + 1];
          if (n === undefined || !'"\\$`'.includes(n)) return null;
          cur += n;
          i += 2;
        } else {
          cur += d;
          i++;
        }
      }
      inWord = true;
      i++;
    } else if (c === '\\') {
      const n = command[i + 1];
      if (n === undefined || n === '\n') return null;
      cur += n;
      inWord = true;
      i += 2;
    } else if (c === ' ' || c === '\t') {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
      i++;
    } else if (';&|<>()$`\n\r*?[]{}~#!'.includes(c)) {
      return null;
    } else {
      cur += c;
      inWord = true;
      i++;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

/** The command line for one of our events. */
export function hookCommand(node: string, mwfJs: string, arg: string): string {
  return `${shellQuote(node)} ${shellQuote(mwfJs)} hook ${arg}`;
}

const ARGS = new Set(HOOK_EVENTS.map((e) => e.arg));

/** Codex's recogniser (kept under its original name for existing callers and tests). */
export const isOurs = (handler: unknown): boolean => codexIsOurs(handler);

export function codexIsOurs(handler: unknown): boolean {
  if (!isObj(handler) || handler['type'] !== 'command' || typeof handler['command'] !== 'string')
    return false;
  const argv = splitCommand(handler['command']);
  return (
    argv !== null &&
    argv.length === 4 &&
    basename(argv[1]!) === 'mwf.js' &&
    argv[2] === 'hook' &&
    ARGS.has(argv[3]!)
  );
}

/** How a document flavour builds and recognises mwf's handlers. */
export interface HookFlavor {
  /** Name of the file, for error messages. */
  file: string;
  isOurs(handler: unknown): boolean;
  handler(node: string, mwfJs: string, arg: string): Obj;
}

export const CODEX_FLAVOR: HookFlavor = {
  file: 'hooks.json',
  isOurs: (h) => codexIsOurs(h),
  handler: (node, mwfJs, arg) => desiredHandler(hookCommand(node, mwfJs, arg)),
};

function ourEventArrays(
  doc: unknown,
  flavor: HookFlavor = CODEX_FLAVOR,
): Array<{ event: HookEvent; groups: Obj[] }> {
  if (!isObj(doc)) throw new HooksDocError(`${flavor.file} must contain a JSON object`);
  const hooks = doc['hooks'];
  if (hooks === undefined) return [];
  if (!isObj(hooks)) throw new HooksDocError(`"hooks" in ${flavor.file} must be an object`);
  const out: Array<{ event: HookEvent; groups: Obj[] }> = [];
  for (const { event } of HOOK_EVENTS) {
    const groups = hooks[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) throw new HooksDocError(`"hooks.${event}" must be an array`);
    for (const group of groups) {
      if (!isObj(group) || !Array.isArray(group['hooks']))
        throw new HooksDocError(`"hooks.${event}" holds an entry that is not a matcher group`);
    }
    out.push({ event, groups: groups as Obj[] });
  }
  return out;
}

export function desiredHandler(command: string): Obj {
  return { type: 'command', command, timeout: HOOK_TIMEOUT_S, statusMessage: 'mwf' };
}

export interface EventChange {
  event: HookEvent;
  action: 'add' | 'replace' | 'unchanged' | 'remove';
}

export interface HooksEdit {
  doc: Obj;
  changes: EventChange[];
}

/** Add (or update in place) our three handlers. Idempotent. */
export function installHooks(
  doc: unknown,
  node: string,
  mwfJs: string,
  flavor: HookFlavor = CODEX_FLAVOR,
): HooksEdit {
  ourEventArrays(doc, flavor); // validates the shape
  const next = clone(doc) as Obj;
  const hooks = (isObj(next['hooks']) ? next['hooks'] : (next['hooks'] = {})) as Obj;
  const changes: EventChange[] = [];
  for (const { event, arg, matcher } of HOOK_EVENTS) {
    const want = flavor.handler(node, mwfJs, arg);
    const groups = (hooks[event] ?? (hooks[event] = [])) as Obj[];
    let found = false;
    let action: EventChange['action'] = 'unchanged';
    for (const group of groups) {
      const list = group['hooks'] as unknown[];
      for (let k = 0; k < list.length; k++) {
        if (!flavor.isOurs(list[k])) continue;
        if (!found) {
          found = true;
          if (!deepEqual(list[k], want)) {
            list[k] = want;
            action = 'replace';
          }
        } else {
          list.splice(k--, 1); // a duplicate of ours
          action = 'replace';
        }
      }
    }
    if (!found) {
      groups.push(matcher === undefined ? { hooks: [want] } : { matcher, hooks: [want] });
      action = 'add';
    }
    changes.push({ event, action });
  }
  return { doc: next, changes };
}

/** Remove our handlers; groups and events we emptied go too, nothing else. */
export function removeHooks(doc: unknown, flavor: HookFlavor = CODEX_FLAVOR): HooksEdit {
  const arrays = ourEventArrays(doc, flavor);
  const next = clone(doc) as Obj;
  const changes: EventChange[] = [];
  const hooks = next['hooks'] as Obj | undefined;
  let emptiedAny = false;
  for (const { event } of arrays) {
    const groups = (hooks as Obj)[event] as Obj[];
    let removed = 0;
    const kept: Obj[] = [];
    for (const group of groups) {
      const list = group['hooks'] as unknown[];
      const left = list.filter((h) => !flavor.isOurs(h));
      removed += list.length - left.length;
      if (left.length === 0 && list.length > 0) continue; // emptied by us
      group['hooks'] = left;
      kept.push(group);
    }
    if (removed === 0) {
      changes.push({ event, action: 'unchanged' });
      continue;
    }
    changes.push({ event, action: 'remove' });
    if (kept.length === 0) {
      delete (hooks as Obj)[event];
      emptiedAny = true;
    } else (hooks as Obj)[event] = kept;
  }
  if (emptiedAny && hooks && Object.keys(hooks).length === 0) delete next['hooks'];
  return { doc: next, changes };
}

/** Strip our handlers and empty containers, so two documents can be compared "without ours". */
function normalized(doc: unknown, flavor: HookFlavor): unknown {
  const copy = clone(doc);
  if (!isObj(copy) || !isObj(copy['hooks'])) return copy;
  const hooks = copy['hooks'];
  for (const { event } of HOOK_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) =>
        isObj(g) && Array.isArray(g['hooks'])
          ? { ...g, hooks: g['hooks'].filter((h) => !flavor.isOurs(h)) }
          : g,
      )
      .filter((g) => !(isObj(g) && Array.isArray(g['hooks']) && g['hooks'].length === 0));
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (Object.keys(hooks).length === 0) delete copy['hooks'];
  return copy;
}

/** The difference guard: apart from our handlers, the new document must equal the old one. */
export function checkOnlyOursChanged(
  before: unknown,
  after: unknown,
  flavor: HookFlavor = CODEX_FLAVOR,
): void {
  if (!deepEqual(normalized(before, flavor), normalized(after, flavor)))
    throw new HooksDocError(
      'internal check failed: the edit would change something other than the mwf handlers; nothing was written',
    );
}

/** Whether a document is empty enough to delete the file after an uninstall. */
export function isEmptyDoc(doc: unknown): boolean {
  return isObj(doc) && Object.keys(doc).length === 0;
}
