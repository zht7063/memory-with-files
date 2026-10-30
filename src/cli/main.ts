import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import {
  MWF_VERSION,
  SCOPE_KEYS,
  type DoctorResult,
  type RecallResult,
  type StatusResult,
} from '../core/index.ts';
import { findCommand, run, SHELL_COMMANDS, toError, type CliResult } from './index.ts';
import {
  renderAdd,
  renderDoctor,
  renderHandoff,
  renderMaintenance,
  renderRecall,
  renderStatus,
} from './render.ts';
import { StdinTooLarge } from './stdin.ts';

/** Exit codes: 0 ok, 1 the command ran and failed (or doctor found errors), 2 usage error. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  /**
   * Read standard input as UTF-8 (used by `--body-file -` and `--content-file -`). It must give
   * up with `StdinTooLarge` as soon as more than `maxBytes` bytes have arrived.
   */
  stdin?: (maxBytes: number) => Promise<string>;
  /**
   * Whether standard input and standard output are terminals. Only `src/bin/mwf.ts` sets it, from
   * `process.stdin.isTTY` / `process.stdout.isTTY`; tests pass it as a plain argument. There is
   * deliberately no environment variable or flag that overrides it. Absent means "not a terminal",
   * so a destructive `--confirm` is refused (CONFIRM_REQUIRES_TTY).
   */
  tty?: { stdin: boolean; stdout: boolean };
}

/** Largest body read from a file or stdin; core's own limit (50 000 characters) is stricter. */
export const MAX_INPUT_BYTES = 1_000_000;

const HELP = `mwf ${MWF_VERSION}: project-local file memory

Usage: mwf <command> [options]

Commands:
  status               project overview: counts, index, lock, trash, hints
  recall [query]       search memory, or read one handoff with --task
  doctor               consistency report (exit 1 when it finds errors)
  add                  write a confirmed memory record
  handoff read|save    list / read, or save, a per-task handoff
  forget               move records to trash (preview; --confirm --preview-token executes)
  purge                permanently delete trash entries (same two steps)
  compact              merge exact duplicate records (same two steps)
  inbox [list|accept|discard]  list inbox entries, accept one, or discard (discard: two steps)

Options (all commands):
  --json               print the structured result as JSON
  --cwd <dir>          look for the project from <dir> (default: current directory)
  -h, --help           show this help
  -v, --version        show the version

recall options:
  --type <type>        record type (repeatable): preference, decision, incident, task, knowledge
  --status <s>         active (default), done or all
  --task <name>        read this handoff in full
  --handoffs           also search handoffs (never filtered by --scope)
  --scope <key=value>  only records whose scope matches (repeatable); keys: ${SCOPE_KEYS.join(', ')}
  --limit <n>          max hits (default 8)
  --max-chars <n>      output budget in characters (default 4000)

add options:
  --type <type>        required: preference, decision, incident, task or knowledge
  --title <text>       required: one line, at most 200 characters
  --body <text>        the Markdown body, or
  --body-file <path>   read the body from a file ("-" reads standard input; preferred for long text)
  --scope <key=value>  where the record applies (repeatable); keys: ${SCOPE_KEYS.join(', ')}
  --status <s>         active (default) or done
  --request-id <id>    idempotency key (generated when absent)
  --wait-ms <n>        how long to wait for the project lock

handoff read [--task <name>] [--status active|done|all]
handoff save --task <name> (--content <text> | --content-file <path|->)
             [--summary <line>] [--base-version <n>] [--status active|done]
             [--request-id <id>] [--wait-ms <n>]

Writes (add, handoff save) go through the same secret scan as the MCP tools: a body that looks
like it holds a credential is refused (exit 1) and nothing is written. Prefer --body-file - over
--body for anything sensitive-adjacent: arguments show up in shell history and process lists.
A write prints its request_id. If it fails with LOCK_LOST or LOCK_TIMEOUT, run it again with the
same --request-id: it is applied exactly once, whatever state the first attempt left behind.
A failed write also prints its request_id (in --json: error.details.request_id).

Destructive commands (forget, purge, compact, inbox discard) take two steps, and only the shell
can take the second one: the MCP tools of the same names only preview.
  1. Without --confirm they change nothing: they print what would change and a preview_token.
  2. --confirm --preview-token <token> executes. The token is checked again under the project
     lock against the current content, so anything edited since the preview is refused
     (PREVIEW_MISMATCH). --confirm without --preview-token is refused (CONFIRM_REQUIRES_TOKEN)
     and deletes nothing.
  Only you, in an interactive terminal, can run step 2: --confirm needs both standard input and
  standard output to be a terminal (TTY), otherwise it is refused (CONFIRM_REQUIRES_TTY) and
  deletes nothing. A pipe, a redirect, a script or an agent's shell tool cannot confirm. (This
  stops an agent running it by accident; it does not stop one that deliberately opens a pseudo
  terminal, for example with \`script\`.) Previews work anywhere.

forget  --id <id> (repeatable, required) [--reason <text>]
purge   [--id <id> (repeatable; default: every expired trash entry)]
compact [--type <type> (repeatable)]
inbox   list [--limit <n>]
inbox   accept --entry-id <id> --type <type> --title <text> [--body <text> | --body-file <path|->]
               [--scope <key=value>]
inbox   discard --entry-id <id> (repeatable, required)
  each of them also takes: --confirm --preview-token <token> --request-id <id> --wait-ms <n>

Every other write (init, edit, propose, reindex, restore) is only available as an MCP tool, and
so is creating a project: use the MCP tool mwf_init (it only works at the root of a git
repository), or \`mwf install\` when available. There is no init command in the shell.

Note: "read-only" means status, recall and doctor never change memory, not that they never write
files. status and recall may take the project lock and write under .mwf/: they recover a leftover
intent from a crashed write (finishing or discarding it, and repairing index.md) and refresh a
stale index.db. If another writer holds the lock they wait briefly, then answer from the
existing index with a warning. doctor never takes the lock or writes; it only reports.

Exit codes: 0 ok, 1 the command failed (or doctor found errors), 2 usage error or invalid input.
`;

/** Commands that exist in the design but are not part of this build. */
const LATER: Record<string, string> = {
  hook: 'the hooks layer is not part of this build yet',
  mcp: 'the MCP server is started by the mwf executable itself (`mwf mcp`), not by this command line',
  install: 'lifecycle commands (install / uninstall / update) are not part of this build yet',
  uninstall: 'lifecycle commands (install / uninstall / update) are not part of this build yet',
  update: 'lifecycle commands (install / uninstall / update) are not part of this build yet',
};

class Usage extends Error {}

function exitCode(name: string, result: CliResult): number {
  if (!result.ok) return result.error.code === 'INVALID_ARGUMENT' ? EXIT_USAGE : EXIT_FAILED;
  return name === 'doctor' && !(result.data as DoctorResult).ok ? EXIT_FAILED : EXIT_OK;
}

function number(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Usage(`${flag} must be a non-negative integer`);
  return Number(value);
}

type Values = Record<string, string | boolean | string[] | undefined>;

function scopeInput(values: Values): Record<string, string[]> | undefined {
  const scope: Record<string, string[]> = {};
  for (const pair of (values['scope'] as string[] | undefined) ?? []) {
    const eq = pair.indexOf('=');
    const key = eq < 0 ? '' : pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (!(SCOPE_KEYS as readonly string[]).includes(key) || !value) {
      throw new Usage(`--scope expects <key>=<value> with key one of ${SCOPE_KEYS.join(', ')}`);
    }
    (scope[key] ??= []).push(value);
  }
  return Object.keys(scope).length ? scope : undefined;
}

function recallInput(values: Values, positionals: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (positionals.length) input['query'] = positionals.join(' ');
  if (values['type']) input['types'] = values['type'];
  if (values['status']) input['status'] = values['status'];
  if (values['task']) input['task'] = values['task'];
  if (values['handoffs']) input['include_handoffs'] = true;
  const limit = number(values['limit'] as string | undefined, '--limit');
  if (limit !== undefined) input['limit'] = limit;
  const maxChars = number(values['max-chars'] as string | undefined, '--max-chars');
  if (maxChars !== undefined) input['max_chars'] = maxChars;
  const scope = scopeInput(values);
  if (scope) input['scope'] = scope;
  return input;
}

/** Text given inline (`--flag`) or read from a file / stdin (`--flag-file`, "-" = stdin). */
async function textInput(
  values: Values,
  io: Io,
  flag: 'body' | 'content',
  required: boolean,
): Promise<string | undefined> {
  const inline = values[flag] as string | undefined;
  const file = values[`${flag}-file`] as string | undefined;
  if (inline !== undefined && file !== undefined) {
    throw new Usage(`give --${flag} or --${flag}-file, not both`);
  }
  if (inline !== undefined) return inline;
  if (file === undefined) {
    if (required)
      throw new Usage(`--${flag} or --${flag}-file is required (--${flag}-file - reads stdin)`);
    return undefined;
  }
  if (file === '-') {
    if (!io.stdin) throw new Usage(`--${flag}-file -: standard input is not available`);
    let text: string;
    try {
      text = await io.stdin(MAX_INPUT_BYTES);
    } catch (error) {
      if (error instanceof StdinTooLarge) throw new Usage(error.message);
      throw error;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
      throw new Usage(`standard input is larger than ${MAX_INPUT_BYTES} bytes`);
    }
    return text;
  }
  const path = resolve(io.cwd, file);
  try {
    if (statSync(path).size > MAX_INPUT_BYTES) {
      throw new Usage(`${file} is larger than ${MAX_INPUT_BYTES} bytes`);
    }
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Usage) throw error;
    throw new Usage(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
  }
}

function writeProps(values: Values, input: Record<string, unknown>): void {
  const wait = number(values['wait-ms'] as string | undefined, '--wait-ms');
  if (wait !== undefined) input['wait_ms'] = wait;
  // run() adds a request_id when none is given and reports it on failure (exactly-once retries).
  if (values['request-id'] !== undefined) input['request_id'] = values['request-id'];
}

/** The two-step flags shared by every destructive command. */
function confirmProps(values: Values, input: Record<string, unknown>): void {
  if (values['confirm']) input['confirm'] = true;
  if (values['preview-token'] !== undefined) input['preview_token'] = values['preview-token'];
  if (!values['confirm'] && values['preview-token'] !== undefined) {
    throw new Usage('--preview-token only makes sense together with --confirm');
  }
  writeProps(values, input);
}

function forgetInput(values: Values): Record<string, unknown> {
  const ids = (values['id'] as string[] | undefined) ?? [];
  if (!ids.length) throw new Usage('forget: --id <id> is required (repeatable)');
  const input: Record<string, unknown> = { ids };
  if (values['reason'] !== undefined) input['reason'] = values['reason'];
  confirmProps(values, input);
  return input;
}

function purgeInput(values: Values): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const ids = (values['id'] as string[] | undefined) ?? [];
  if (ids.length) input['ids'] = ids;
  confirmProps(values, input);
  return input;
}

function compactInput(values: Values): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (values['type']) input['types'] = values['type'];
  confirmProps(values, input);
  return input;
}

async function inboxInput(
  action: string | undefined,
  values: Values,
  io: Io,
): Promise<Record<string, unknown>> {
  const act = action ?? 'list';
  if (act !== 'list' && act !== 'accept' && act !== 'discard') {
    throw new Usage('inbox: say list, accept or discard');
  }
  const input: Record<string, unknown> = { action: act };
  const entries = (values['entry-id'] as string[] | undefined) ?? [];
  if (act === 'list') {
    const limit = number(values['limit'] as string | undefined, '--limit');
    if (limit !== undefined) input['limit'] = limit;
    return input;
  }
  if (act === 'discard') {
    if (!entries.length) throw new Usage('inbox discard: --entry-id <id> is required (repeatable)');
    input['entry_ids'] = entries;
    confirmProps(values, input);
    return input;
  }
  if (entries.length !== 1) throw new Usage('inbox accept: give exactly one --entry-id');
  input['entry_id'] = entries[0];
  for (const key of ['type', 'title'] as const) {
    if (values[key] !== undefined) input[key] = values[key];
  }
  const body = await textInput(values, io, 'body', false);
  if (body !== undefined) input['body'] = body;
  const scope = scopeInput(values);
  if (scope) input['scope'] = scope;
  writeProps(values, input);
  return input;
}

async function addInput(values: Values, io: Io): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = {};
  if (values['type'] !== undefined) input['type'] = values['type'];
  if (values['title'] !== undefined) input['title'] = values['title'];
  const body = await textInput(values, io, 'body', true);
  if (body !== undefined) input['body'] = body;
  if (values['status'] !== undefined) input['status'] = values['status'];
  const scope = scopeInput(values);
  if (scope) input['scope'] = scope;
  writeProps(values, input);
  for (const key of ['type', 'title'] as const) {
    if (input[key] === undefined) throw new Usage(`add: --${key} is required`);
  }
  return input;
}

async function handoffInput(
  action: string | undefined,
  values: Values,
  io: Io,
): Promise<Record<string, unknown>> {
  if (action !== 'read' && action !== 'save') {
    throw new Usage(
      'handoff: say "read" or "save" (mwf handoff read | mwf handoff save --task <name> …)',
    );
  }
  const input: Record<string, unknown> = { action };
  if (values['task'] !== undefined) input['task'] = values['task'];
  if (values['status'] !== undefined) input['status'] = values['status'];
  if (action === 'read') {
    for (const flag of [
      'content',
      'content-file',
      'summary',
      'base-version',
      'request-id',
      'wait-ms',
    ]) {
      if (values[flag] !== undefined) throw new Usage(`handoff read does not take --${flag}`);
    }
    return input;
  }
  if (values['task'] === undefined) throw new Usage('handoff save: --task is required');
  input['content'] = await textInput(values, io, 'content', true);
  if (values['summary'] !== undefined) input['summary'] = values['summary'];
  const base = number(values['base-version'] as string | undefined, '--base-version');
  if (base !== undefined) input['base_version'] = base;
  writeProps(values, input);
  return input;
}

const WRITE_FLAGS = {
  'request-id': { type: 'string' },
  'wait-ms': { type: 'string' },
} as const;

const CONFIRM_FLAGS = {
  confirm: { type: 'boolean' },
  'preview-token': { type: 'string' },
  ...WRITE_FLAGS,
} as const;

function optionsFor(name: string): ParseArgsOptionsConfig {
  switch (name) {
    case 'recall':
      return {
        type: { type: 'string', multiple: true },
        status: { type: 'string' },
        task: { type: 'string' },
        handoffs: { type: 'boolean' },
        scope: { type: 'string', multiple: true },
        limit: { type: 'string' },
        'max-chars': { type: 'string' },
      } as const;
    case 'add':
      return {
        type: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        'body-file': { type: 'string' },
        scope: { type: 'string', multiple: true },
        status: { type: 'string' },
        ...WRITE_FLAGS,
      } as const;
    case 'handoff':
      return {
        task: { type: 'string' },
        status: { type: 'string' },
        content: { type: 'string' },
        'content-file': { type: 'string' },
        summary: { type: 'string' },
        'base-version': { type: 'string' },
        ...WRITE_FLAGS,
      } as const;
    case 'forget':
      return {
        id: { type: 'string', multiple: true },
        reason: { type: 'string' },
        ...CONFIRM_FLAGS,
      } as const;
    case 'purge':
      return { id: { type: 'string', multiple: true }, ...CONFIRM_FLAGS } as const;
    case 'compact':
      return { type: { type: 'string', multiple: true }, ...CONFIRM_FLAGS } as const;
    case 'inbox':
      return {
        'entry-id': { type: 'string', multiple: true },
        limit: { type: 'string' },
        type: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        'body-file': { type: 'string' },
        scope: { type: 'string', multiple: true },
        ...CONFIRM_FLAGS,
      } as const;
    default:
      return {};
  }
}

/**
 * A destructive `--confirm` runs only for a person at an interactive terminal: standard input AND
 * standard output must both be terminals. The check sits in the shell, before anything reaches
 * core, so a refused run never takes the lock or reads memory. Previews have no `confirm` and are
 * unaffected.
 */
function confirmNeedsTerminal(input: Record<string, unknown>, io: Io): boolean {
  return input['confirm'] === true && !(io.tty?.stdin === true && io.tty?.stdout === true);
}

function ttyRefusal(io: Io): CliResult {
  const stdin = io.tty?.stdin === true;
  const stdout = io.tty?.stdout === true;
  const lacking = [!stdin ? 'standard input' : '', !stdout ? 'standard output' : ''].filter(
    Boolean,
  );
  return {
    ok: false,
    error: {
      code: 'CONFIRM_REQUIRES_TTY',
      message:
        `--confirm only runs for you, in an interactive terminal: ${lacking.join(' and ')} ` +
        `${lacking.length > 1 ? 'are' : 'is'} not a terminal. Nothing was changed. ` +
        'Run this command yourself in a terminal, without pipes or redirects; ' +
        'an agent, a script or a pipe cannot confirm it.',
      details: { stdin_tty: stdin, stdout_tty: stdout },
    },
  };
}

/** The failures worth repeating with the same request_id. */
const RETRYABLE = new Set(['LOCK_LOST', 'LOCK_TIMEOUT', 'INTERNAL']);

/** The `mwf` command line. Returns the exit code; never calls process.exit. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '-h' || name === '--help' || name === 'help') {
    io.stdout(HELP);
    return name === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (name === '-v' || name === '--version') {
    io.stdout(`${MWF_VERSION}\n`);
    return EXIT_OK;
  }
  try {
    const later = LATER[name];
    if (later) throw new Usage(`${name}: ${later}`);
    if (!SHELL_COMMANDS.includes(name)) {
      const writes = findCommand(name) !== undefined;
      throw new Usage(
        writes
          ? `${name} writes to the project; it is only available as an MCP tool, not from the shell`
          : `unknown command: ${name}`,
      );
    }
    let parsed;
    try {
      parsed = parseArgs({
        args: [...rest],
        allowPositionals: name === 'recall' || name === 'handoff' || name === 'inbox',
        options: {
          json: { type: 'boolean' },
          cwd: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
          ...optionsFor(name),
        },
      });
    } catch (error) {
      throw new Usage((error as Error).message);
    }
    if (parsed.values.help) {
      io.stdout(HELP);
      return EXIT_OK;
    }
    const values = parsed.values as Values;
    let input: Record<string, unknown> = {};
    if (name === 'recall') input = recallInput(values, parsed.positionals);
    else if (name === 'add') input = await addInput(values, io);
    else if (name === 'handoff') {
      if (parsed.positionals.length > 1) throw new Usage('handoff takes one action: read or save');
      input = await handoffInput(parsed.positionals[0], values, io);
    } else if (name === 'forget') input = forgetInput(values);
    else if (name === 'purge') input = purgeInput(values);
    else if (name === 'compact') input = compactInput(values);
    else if (name === 'inbox') {
      if (parsed.positionals.length > 1) throw new Usage('inbox takes one action');
      input = await inboxInput(parsed.positionals[0], values, io);
    }
    const env = { cwd: resolve(io.cwd, (values['cwd'] as string | undefined) ?? '.') };
    const result: CliResult = confirmNeedsTerminal(input, io)
      ? ttyRefusal(io)
      : await run(name, input, env);
    const code = exitCode(name, result);
    const requestId = result.ok
      ? (result.data as { request_id?: unknown } | null)?.request_id
      : result.error.details['request_id'];
    if (parsed.values.json) {
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return code;
    }
    if (!result.ok) {
      io.stderr(`mwf: ${result.error.code}: ${result.error.message}\n`);
      if (typeof requestId === 'string') {
        io.stderr(
          RETRYABLE.has(result.error.code)
            ? `request_id: ${requestId} (repeat the command with --request-id ${requestId}: it is applied exactly once)\n`
            : `request_id: ${requestId}\n`,
        );
      }
      return code;
    }
    if (name === 'status') io.stdout(`${renderStatus(result.data as StatusResult)}\n`);
    else if (name === 'recall') io.stdout(`${renderRecall(result.data as RecallResult)}\n`);
    else if (name === 'add') io.stdout(`${renderAdd(result.data as never)}\n`);
    else if (name === 'handoff') io.stdout(`${renderHandoff(result.data as never)}\n`);
    else if (['forget', 'purge', 'compact', 'inbox'].includes(name)) {
      io.stdout(`${renderMaintenance(name, input, result.data)}\n`);
    } else io.stdout(`${renderDoctor(result.data as DoctorResult)}\n`);
    return code;
  } catch (error) {
    if (error instanceof Usage) {
      io.stderr(`mwf: ${error.message}\nRun "mwf --help" for usage.\n`);
      return EXIT_USAGE;
    }
    io.stderr(`mwf: ${toError(error).message}\n`);
    return EXIT_FAILED;
  }
}
