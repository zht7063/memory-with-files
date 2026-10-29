import { randomUUID } from 'node:crypto';
import { COMMANDS, findCommand, type Access, type CliEnv, type Command } from './commands.ts';
import { toError, type CliResult } from './result.ts';

export { COMMANDS, findCommand, resolveCtx } from './commands.ts';
export { confirmHost } from './host.ts';
export type { ConfirmHostArgs } from './host.ts';
export { shellCommandFor } from './shellcmd.ts';
export type { Access, CliEnv, Command } from './commands.ts';
export type { ObjectSchema, Schema } from './schema.ts';
export { toError } from './result.ts';
export type { CliError, CliResult } from './result.ts';

/**
 * Run a CLI function by name.
 *
 * Every call that changes the project carries a request_id (the caller's, or `cli-<uuid>`), and a
 * failure reports it in `error.details.request_id`: whatever state a failed first attempt left
 * behind, repeating the call with the same id applies it exactly once. Shell, MCP and hooks all
 * get this from here.
 */
export async function run(name: string, input: unknown, env: CliEnv = {}): Promise<CliResult> {
  const command = findCommand(name);
  if (!command) {
    return {
      ok: false,
      error: { code: 'UNKNOWN_COMMAND', message: `unknown command: ${name}`, details: { name } },
    };
  }
  let args = (input ?? {}) as Record<string, unknown>;
  const plain = typeof args === 'object' && !Array.isArray(args);
  if (plain && 'request_id' in command.input.properties && command.writes(args)) {
    args = { ...args, request_id: args['request_id'] ?? `cli-${randomUUID()}` };
  }
  try {
    return { ok: true, data: await command.run(args, env) };
  } catch (error) {
    const failure = toError(error);
    const requestId = plain ? args['request_id'] : undefined;
    if (typeof requestId === 'string') {
      failure.details = { ...failure.details, request_id: requestId };
    }
    return { ok: false, error: failure };
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

/** Names of the commands that may be run from a shell (the read-only ones, add, handoff, and the destructive ones). */
export const SHELL_COMMANDS: readonly string[] = COMMANDS.filter((c) => c.shell).map((c) => c.name);

export function accessOf(name: string): Access | undefined {
  return findCommand(name)?.access;
}
