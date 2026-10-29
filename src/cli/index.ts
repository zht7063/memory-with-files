import * as core from '../core/index.ts';
import { COMMANDS, findCommand, type Access, type CliEnv, type Command } from './commands.ts';

export { COMMANDS, findCommand, resolveCtx } from './commands.ts';
export type { Access, CliEnv, Command } from './commands.ts';
export type { ObjectSchema, Schema } from './schema.ts';

export interface CliError {
  /** A core error code, or one of the CLI's own. */
  code: core.MwfErrorCode | 'UNKNOWN_COMMAND' | 'INTERNAL';
  message: string;
  details: Record<string, unknown>;
}

/** What every CLI function returns; it never throws. MCP maps it onto a tool result unchanged. */
export type CliResult<T = unknown> = { ok: true; data: T } | { ok: false; error: CliError };

export function toError(error: unknown): CliError {
  if (error instanceof core.MwfError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  // Anything else is a bug or an environment fault: keep the message, never a stack or file contents.
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

/** Run a CLI function by name. */
export async function run(name: string, input: unknown, env: CliEnv = {}): Promise<CliResult> {
  const command = findCommand(name);
  if (!command) {
    return {
      ok: false,
      error: { code: 'UNKNOWN_COMMAND', message: `unknown command: ${name}`, details: { name } },
    };
  }
  try {
    return { ok: true, data: await command.run((input ?? {}) as Record<string, unknown>, env) };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}

function fn(command: Command) {
  return (input: unknown = {}, env: CliEnv = {}): Promise<CliResult> =>
    run(command.name, input, env);
}
const byName = (name: string): ReturnType<typeof fn> => fn(findCommand(name) as Command);

// One structured function per command, named after it (CLI function `x` <-> MCP tool `mwf_x`).
export const init = byName('init');
export const bootstrap = byName('bootstrap');
export const recall = byName('recall');
export const get = byName('get');
export const add = byName('add');
export const propose = byName('propose');
export const edit = byName('edit');
export const handoff = byName('handoff');
export const status = byName('status');
export const doctor = byName('doctor');
export const inbox = byName('inbox');
export const compact = byName('compact');
export const reindex = byName('reindex');
export const forget = byName('forget');
export const restore = byName('restore');
export const purge = byName('purge');

/** Names of the commands that may be run from a shell: the read-only ones plus add and handoff. */
export const SHELL_COMMANDS: readonly string[] = COMMANDS.filter((c) => c.shell).map((c) => c.name);

export function accessOf(name: string): Access | undefined {
  return findCommand(name)?.access;
}
