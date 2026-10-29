import * as core from '../core/index.ts';
import { validate, type ObjectSchema, type Schema } from './schema.ts';

/** How a command touches the project; MCP uses it for tool annotations, the shell for gating. */
export type Access =
  /** Never writes. */
  | 'read'
  /** Writes, and the change is recoverable (or additive). */
  | 'write'
  /** Writes and can lose data: preview by default, executed only with `confirm` + `preview_token`. */
  | 'destructive';

export interface CliEnv {
  /** Directory the project is looked up from (default process.cwd()). */
  cwd?: string;
  /** Use this project root instead of searching upwards from `cwd`. */
  root?: string;
  /** Core context overrides (lock wait, stale age, clock...). `root` is ignored here. */
  ctx?: Partial<Omit<core.Ctx, 'root'>>;
}

export interface Command {
  /** CLI function name; the MCP tool is `mwf_<name>`. */
  name: string;
  description: string;
  access: Access;
  /** Exposed as a shell command line (`mwf <name>`). Only the read-only diagnostics are. */
  shell: boolean;
  /** JSON-Schema description of the input; validated before core is called. */
  input: ObjectSchema;
  run(input: Record<string, unknown>, env: CliEnv): Promise<unknown>;
}

const str = (
  description: string,
  extra: { maxLength?: number } = {},
): Schema & { description: string } => ({
  type: 'string',
  description,
  ...extra,
});
const int = (
  description: string,
  minimum?: number,
  maximum?: number,
): Schema & { description: string } => ({
  type: 'integer',
  description,
  ...(minimum !== undefined ? { minimum } : {}),
  ...(maximum !== undefined ? { maximum } : {}),
});
const bool = (description: string): Schema & { description: string } => ({
  type: 'boolean',
  description,
});
const oneOf = (
  values: readonly string[],
  description: string,
): Schema & { description: string } => ({
  type: 'string',
  enum: values,
  description,
});
const list = (item: Schema, description: string): Schema & { description: string } => ({
  type: 'array',
  items: item,
  description,
});

const RECORD_TYPE: Schema = { type: 'string', enum: core.RECORD_TYPES };
const STATUS = ['active', 'done'] as const;
const SCOPE: Schema & { description: string } = {
  type: 'object',
  description: `Where the record applies. Keys: ${core.SCOPE_KEYS.join(', ')}.`,
  properties: Object.fromEntries(
    core.SCOPE_KEYS.map((key) => [key, { type: 'array', items: { type: 'string' } } as Schema]),
  ),
  additionalProperties: false,
};

const WRITE_PROPS = {
  request_id: str('Idempotency key; generated when absent. Pass the same one when retrying.'),
  wait_ms: int('Lock wait budget in ms (0-600000).', 0, 600_000),
} as const;

const DESTRUCTIVE_PROPS = {
  confirm: bool('Execute. Without it the call only previews. Requires preview_token.'),
  preview_token: str('Token returned by the preview of the same operation.'),
} as const;

function object(
  properties: ObjectSchema['properties'],
  required: readonly string[] = [],
): ObjectSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** The project a command works on, as a core context. */
export function resolveCtx(env: CliEnv, mode: 'existing' | 'init' = 'existing'): core.Ctx {
  const cwd = env.cwd ?? process.cwd();
  const found = env.root ?? core.findProjectRoot(cwd);
  if (found === null && mode === 'existing') {
    throw new core.MwfError('NOT_INITIALIZED', `no .mwf/ found in ${cwd} or any parent; run init`, {
      cwd,
    });
  }
  // init inside an already initialised project targets that project (never a nested .mwf/).
  return { ...env.ctx, root: found ?? cwd };
}

type Fn = (ctx: core.Ctx, input: never) => Promise<unknown> | unknown;

function command(
  name: string,
  description: string,
  access: Access,
  input: ObjectSchema,
  fn: Fn,
  options: { shell?: boolean; init?: boolean } = {},
): Command {
  return {
    name,
    description,
    access,
    shell: options.shell ?? false,
    input,
    async run(raw, env) {
      const value = validate(input, raw);
      const ctx = resolveCtx(env, options.init ? 'init' : 'existing');
      return await fn(ctx, value as never);
    },
  };
}

export const COMMANDS: readonly Command[] = [
  command(
    'init',
    'Create .mwf/ in the project. git_mode: "track" keeps memory in git, "local" ignores .mwf/ entirely.',
    'write',
    object(
      { git_mode: oneOf(['track', 'local'], 'Whether .mwf/ goes into git.'), ...WRITE_PROPS },
      ['git_mode'],
    ),
    core.init,
    { init: true },
  ),
  command(
    'bootstrap',
    'Project overview: memory index, open handoffs (full text when only one is open), trash expiry notice.',
    'read',
    object({ max_entries: int('Max memory index entries (default 40).', 1, 200) }),
    core.bootstrap,
  ),
  command(
    'recall',
    'Search memory (active records by default); also reads one handoff in full via `task`.',
    'read',
    object({
      query: str('Free-text query.'),
      scope: SCOPE,
      types: list(RECORD_TYPE, 'Restrict to these record types.'),
      status: oneOf([...STATUS, 'all'], 'Which statuses to search (default active).'),
      task: str('Read this handoff in full instead of searching.'),
      include_handoffs: bool('Also search handoffs.'),
      limit: int('Max hits (default 8).', 1, 50),
      max_chars: int('Output budget in characters (default 4000).', 100, 20_000),
    }),
    core.recall,
    { shell: true },
  ),
  command(
    'get',
    'Full record by id.',
    'read',
    object({ id: str('Record id, e.g. dec_abcdefghij.') }, ['id']),
    core.get,
  ),
  command(
    'add',
    'Write a confirmed long-term memory record.',
    'write',
    object(
      {
        type: oneOf(core.RECORD_TYPES, 'Record type.'),
        title: str('One-line title.'),
        body: str('Markdown body.'),
        scope: SCOPE,
        status: oneOf(STATUS, 'Initial status (default active).'),
        ...WRITE_PROPS,
      },
      ['type', 'title', 'body'],
    ),
    core.add,
  ),
  command(
    'propose',
    'Append an uncertain item to inbox.md, to be tidied later.',
    'write',
    object(
      {
        text: str('The item.'),
        source: str('Short label for where it came from.'),
        ...WRITE_PROPS,
      },
      ['text'],
    ),
    core.propose,
  ),
  command(
    'edit',
    'Change title, body, status or scope of a record; expected_hash (from get/recall) guards against overwriting someone else’s edit.',
    'write',
    object(
      {
        id: str('Record id.'),
        expected_hash: str('Hash of the record as last read.'),
        title: str('New title.'),
        body: str('New body.'),
        status: oneOf(STATUS, 'New status.'),
        scope: SCOPE,
        ...WRITE_PROPS,
      },
      ['id', 'expected_hash'],
    ),
    core.edit,
  ),
  command(
    'handoff',
    'Read (list or one task) or save a per-task handoff; a conflicting save appends a parallel-update section, never overwrites.',
    'write',
    object(
      {
        action: oneOf(['read', 'save'], 'read or save.'),
        task: str('Task name (required for save; read without it lists open handoffs).'),
        status: oneOf([...STATUS, 'all'], 'read: which handoffs to list; save: new status.'),
        content: str('save: handoff text.'),
        summary: str('save: one-line status.'),
        base_version: int('save: the version the content was based on.', 0),
        ...WRITE_PROPS,
      },
      ['action'],
    ),
    core.handoff,
  ),
  command(
    'status',
    'Read-only project status: counts, index sync, lock, trash, hints.',
    'read',
    object({}),
    core.status,
    { shell: true },
  ),
  command(
    'doctor',
    'Read-only consistency report (never repairs).',
    'read',
    object({}),
    core.doctor,
    { shell: true },
  ),
  command(
    'inbox',
    'List inbox entries, accept one as a record, or discard entries (discard previews first).',
    'destructive',
    object({
      action: oneOf(['list', 'accept', 'discard'], 'Default list.'),
      limit: int('list: max entries.', 1, 500),
      entry_id: str('accept: inbox entry id.'),
      type: oneOf(core.RECORD_TYPES, 'accept: record type.'),
      title: str('accept: record title.'),
      body: str('accept: record body (default: the entry text).'),
      scope: SCOPE,
      entry_ids: list({ type: 'string' }, 'discard: entry ids.'),
      ...DESTRUCTIVE_PROPS,
      ...WRITE_PROPS,
    }),
    core.inbox,
  ),
  command(
    'compact',
    'Merge exact duplicate records; the merged originals go to trash. Preview unless confirmed.',
    'destructive',
    object({
      types: list(RECORD_TYPE, 'Restrict to these record types.'),
      ...DESTRUCTIVE_PROPS,
      ...WRITE_PROPS,
    }),
    core.compact,
  ),
  command(
    'reindex',
    'Rebuild index.md and index.db from the record files.',
    'write',
    object({ ...WRITE_PROPS }),
    core.reindex,
  ),
  command(
    'forget',
    'Move records to trash (recoverable for 30 days). Preview unless confirmed.',
    'destructive',
    object(
      {
        ids: list({ type: 'string' }, 'Record ids.'),
        reason: str('Why.'),
        ...DESTRUCTIVE_PROPS,
        ...WRITE_PROPS,
      },
      ['ids'],
    ),
    core.forget,
  ),
  command(
    'restore',
    'List the trash, or put a record back at its original path (never overwrites).',
    'write',
    object({ id: str('Record id or trash id; omit to list the trash.'), ...WRITE_PROPS }),
    core.restore,
  ),
  command(
    'purge',
    'Permanently delete trash entries (ids, or every expired one). Preview unless confirmed.',
    'destructive',
    object({
      ids: list({ type: 'string' }, 'Record ids or trash ids; omit for all expired.'),
      ...DESTRUCTIVE_PROPS,
      ...WRITE_PROPS,
    }),
    core.purge,
  ),
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}
