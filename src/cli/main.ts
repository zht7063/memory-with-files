import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  MWF_VERSION,
  SCOPE_KEYS,
  type DoctorResult,
  type RecallResult,
  type StatusResult,
} from '../core/index.ts';
import { findCommand, run, SHELL_COMMANDS, toError, type CliResult } from './index.ts';
import { renderDoctor, renderRecall, renderStatus } from './render.ts';

/** Exit codes: 0 ok, 1 the command ran and failed (or doctor found errors), 2 usage error. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
}

const HELP = `mwf ${MWF_VERSION}: project-local file memory

Usage: mwf <command> [options]

Commands (read-only):
  status               project overview: counts, index, lock, trash, hints
  recall [query]       search memory, or read one handoff with --task
  doctor               consistency report (exit 1 when it finds errors)

Options:
  --json               print the structured result as JSON
  --cwd <dir>          look for the project from <dir> (default: current directory)
  -h, --help           show this help
  -v, --version        show the version

recall options:
  --type <type>        record type (repeatable): preference, decision, incident, task, knowledge
  --status <s>         active (default), done or all
  --task <name>        read this handoff in full
  --handoffs           also search handoffs
  --scope <key=value>  scope filter (repeatable); keys: ${SCOPE_KEYS.join(', ')}
  --limit <n>          max hits (default 8)
  --max-chars <n>      output budget in characters (default 4000)

Writing memory is done through the MCP tools, not from the shell.
`;

/** Commands that exist in the design but are not part of this build. */
const LATER: Record<string, string> = {
  hook: 'the hooks layer is not part of this build yet',
  mcp: 'the MCP layer is not part of this build yet',
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

function recallInput(
  values: Record<string, string | boolean | string[] | undefined>,
  positionals: string[],
): Record<string, unknown> {
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
  if (Object.keys(scope).length) input['scope'] = scope;
  return input;
}

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
        allowPositionals: name === 'recall',
        options: {
          json: { type: 'boolean' },
          cwd: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
          ...(name === 'recall'
            ? {
                type: { type: 'string', multiple: true },
                status: { type: 'string' },
                task: { type: 'string' },
                handoffs: { type: 'boolean' },
                scope: { type: 'string', multiple: true },
                limit: { type: 'string' },
                'max-chars': { type: 'string' },
              }
            : {}),
        },
      });
    } catch (error) {
      throw new Usage((error as Error).message);
    }
    if (parsed.values.help) {
      io.stdout(HELP);
      return EXIT_OK;
    }
    const input = name === 'recall' ? recallInput(parsed.values, parsed.positionals) : {};
    const env = { cwd: resolve(io.cwd, parsed.values.cwd ?? '.') };
    const result: CliResult = await run(name, input, env);
    const code = exitCode(name, result);
    if (parsed.values.json) {
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return code;
    }
    if (!result.ok) {
      io.stderr(`mwf: ${result.error.code}: ${result.error.message}\n`);
      return code;
    }
    if (name === 'status') io.stdout(`${renderStatus(result.data as StatusResult)}\n`);
    else if (name === 'recall') io.stdout(`${renderRecall(result.data as RecallResult)}\n`);
    else io.stdout(`${renderDoctor(result.data as DoctorResult)}\n`);
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
