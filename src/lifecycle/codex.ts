// `mwf install|uninstall --harness codex`: what gets written, in what order, and how it is checked.
//
// Writes (user level only, never a project's `.codex/`):
//   <CODEX_HOME>/hooks.json            three command hooks (SessionStart, UserPromptSubmit, Stop)
//   <HOME>/.agents/skills/mwf*/SKILL.md   the skills (Codex's documented user skills directory)
//   Codex's own config.toml            ONLY through `codex mcp add|remove mwf` (never edited by us)
// Order: skills -> hooks -> MCP. Every file write is atomic and backed up; nothing is rolled back
// across files, and uninstall (stateless: it recognises our entries) removes whatever was written.
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import TOML from '@iarna/toml';
import {
  checkOnlyOursChanged,
  HooksDocError,
  HOOK_EVENTS,
  installHooks,
  isEmptyDoc,
  removeHooks,
  shellQuote,
  type EventChange,
  UnquotableError,
} from './hooks-doc.ts';
import {
  JsonSyntaxError,
  clone,
  deepEqual,
  detectStyle,
  parseStrictJson,
  serializeJson,
} from './json-edit.ts';
import {
  SafeWriteError,
  backupSnapshot,
  commitFile,
  currentOwner,
  readSnapshotOrAbsent,
  removeFile,
  type Owner,
  type Snapshot,
} from './safe-write.ts';
import { installSkills, uninstallSkills, type SkillStep } from './skills-files.ts';

/** The oldest Codex this install supports (the version the plan was written against). */
export const MIN_CODEX = { major: 0, minor: 165, patch: 0 } as const;
export const MIN_CODEX_TEXT = '0.165.0';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started or was killed (ENOENT, timeout, ...). */
  spawnError?: string;
}

/** Run a program with an argument array (never through a shell). */
export type Runner = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<RunResult>;

export const execRunner: Runner = (file, args, env) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { env, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        if (typeof e.code === 'number') return resolve({ code: e.code, stdout, stderr });
        resolve({
          code: null,
          stdout,
          stderr,
          spawnError: e.killed ? 'timed out' : String(e.code ?? e.message),
        });
      },
    );
  });

export interface CodexEnv {
  /** Codex's home (CODEX_HOME or ~/.codex). */
  codexHome: string;
  /** The user's home; skills go to `<home>/.agents/skills`. */
  home: string;
  /** Absolute path of the node that will run the hooks and the MCP server. */
  node: string;
  /** Absolute path of the installed `mwf.js`. */
  mwfJs: string;
  /** The `codex` program (a name looked up on PATH, or a path). */
  codexBin: string;
  version: string;
  run: Runner;
  /** The environment given to `codex`; CODEX_HOME is always set to `codexHome`. */
  baseEnv?: NodeJS.ProcessEnv;
  owner?: Owner;
  now?: () => Date;
  /** Test seam passed to the file writer (called just before each rename). */
  beforeRename?: () => void;
}

export interface Options {
  dryRun: boolean;
  forceSkills: boolean;
}

export type Status = 'done' | 'partial' | 'refused' | 'failed';

export interface McpStep {
  status:
    | 'added'
    | 'updated'
    | 'removed'
    | 'unchanged'
    | 'absent'
    | 'manual'
    | 'refused'
    | 'failed'
    | 'unexpected_change'
    | 'planned';
  detail?: string;
  /** The command for the user to run themselves. */
  manual?: string;
  backup?: string;
}

export interface Report {
  harness: 'codex' | 'claude' | 'pi';
  action: 'install' | 'uninstall';
  dry_run: boolean;
  status: Status;
  /** Error code when refused or failed. */
  code?: string;
  message?: string;
  codex_version?: string;
  /** Set by the Claude install (claude.ts), which reuses this report shape. */
  claude_version?: string;
  /** Set by the Pi install (pi.ts), which reuses this report shape. */
  pi_version?: string;
  hooks?: {
    /** hooks.json (Codex), settings.json (Claude Code) or the generated extension file (Pi). */
    path: string;
    status: 'created' | 'updated' | 'unchanged' | 'removed' | 'refused';
    changes: EventChange[];
    backup?: string;
    detail?: string;
  };
  skills: SkillStep[];
  skills_root: string;
  mcp?: McpStep;
  warnings: string[];
  backups: string[];
  notes: string[];
}

const SERVER = 'mwf';

function newReport(action: Report['action'], env: CodexEnv, options: Options): Report {
  return {
    harness: 'codex',
    action,
    dry_run: options.dryRun,
    status: 'done',
    skills: [],
    skills_root: join(env.home, '.agents', 'skills'),
    warnings: [],
    backups: [],
    notes: [],
  };
}

function refuse(report: Report, code: string, message: string): Report {
  report.status = 'refused';
  report.code = code;
  report.message = message;
  return report;
}

const codexEnv = (env: CodexEnv): NodeJS.ProcessEnv => ({
  ...(env.baseEnv ?? process.env),
  CODEX_HOME: env.codexHome,
});

export function parseCodexVersion(output: string): [number, number, number] | null {
  const m = /codex-cli\s+v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\s*$/m.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const atLeast = (v: [number, number, number]): boolean =>
  v[0] !== MIN_CODEX.major
    ? v[0] > MIN_CODEX.major
    : v[1] !== MIN_CODEX.minor
      ? v[1] > MIN_CODEX.minor
      : v[2] >= MIN_CODEX.patch;

/** A5: no version, no install. */
async function checkVersion(
  env: CodexEnv,
): Promise<{ text: string } | { code: string; message: string }> {
  const r = await env.run(env.codexBin, ['--version'], codexEnv(env));
  const parsed = r.spawnError || r.code !== 0 ? null : parseCodexVersion(r.stdout);
  if (!parsed)
    return {
      code: 'CODEX_VERSION_UNKNOWN',
      message: `could not read the Codex version (\`${env.codexBin} --version\` ${r.spawnError ? `failed: ${r.spawnError}` : r.code !== 0 ? `exited ${r.code}` : 'printed something unrecognised'}); nothing was installed. Install Codex ${MIN_CODEX_TEXT} or newer and make sure \`codex\` is on PATH.`,
    };
  const text = parsed.join('.');
  if (!atLeast(parsed))
    return {
      code: 'CODEX_TOO_OLD',
      message: `Codex ${text} is older than ${MIN_CODEX_TEXT}, the oldest version this install supports; nothing was installed.`,
    };
  return { text };
}

function checkPaths(env: CodexEnv): { code: string; message: string } | undefined {
  if (!isAbsolute(env.node) || !isAbsolute(env.mwfJs))
    return { code: 'INVALID_PATH', message: 'the node and mwf.js paths must be absolute' };
  if (basename(env.mwfJs) !== 'mwf.js')
    return {
      code: 'NOT_INSTALLED_BUILD',
      message: `this is not the built mwf (${basename(env.mwfJs)}); install from the built package (\`npm i -g @zht7063/mwf\`), not from the source tree`,
    };
  try {
    shellQuote(env.node);
    shellQuote(env.mwfJs);
  } catch (error) {
    if (error instanceof UnquotableError)
      return {
        code: 'INVALID_PATH',
        message: 'a path contains a control character and cannot be written into a hook command',
      };
    throw error;
  }
  return undefined;
}

type Obj = Record<string, unknown>;

function parseToml(snap: Snapshot): Obj | { error: string } {
  if (!snap.exists) return {};
  try {
    return JSON.parse(JSON.stringify(TOML.parse(snap.content.toString('utf8')))) as Obj;
  } catch (error) {
    return { error: (error as Error).message };
  }
}

const isErr = (v: Obj | { error: string }): v is { error: string } =>
  typeof (v as { error?: unknown }).error === 'string' && Object.keys(v).length === 1;

/** Read-only warnings about config.toml that make hooks misbehave; never edits it. */
function configWarnings(config: Obj | { error: string }, configPath: string): string[] {
  if (isErr(config))
    return [`${configPath} could not be parsed (${config.error}); mwf did not change it`];
  const out: string[] = [];
  const features = config['features'];
  if (features && typeof features === 'object') {
    const f = features as Obj;
    if (f['hooks'] === false || f['codex_hooks'] === false)
      out.push(
        `${configPath} turns hooks off ([features] hooks = false); the mwf hooks will not run until that is changed`,
      );
  }
  const hooks = config['hooks'];
  if (
    hooks &&
    typeof hooks === 'object' &&
    HOOK_EVENTS.some((e) => (hooks as Obj)[e.event] !== undefined)
  )
    out.push(
      `${configPath} also defines [hooks] inline; Codex merges them with hooks.json and warns at startup (prefer one place)`,
    );
  return out;
}

function manualAdd(env: CodexEnv): string {
  return `codex mcp add ${SERVER} -- ${shellQuote(env.node)} ${shellQuote(env.mwfJs)} mcp`;
}

interface McpServerInfo {
  command: string;
  args: string[];
}

/** What `codex mcp get mwf --json` says: absent, ours (with its command), or someone else's. */
async function getMcp(
  env: CodexEnv,
): Promise<
  | { kind: 'absent' }
  | { kind: 'ours' | 'other'; info: McpServerInfo }
  | { kind: 'error'; detail: string }
> {
  const r = await env.run(env.codexBin, ['mcp', 'get', SERVER, '--json'], codexEnv(env));
  if (r.spawnError) return { kind: 'error', detail: `could not run codex: ${r.spawnError}` };
  if (r.code !== 0) {
    if (/No MCP server named/i.test(r.stderr + r.stdout)) return { kind: 'absent' };
    return { kind: 'error', detail: `codex mcp get exited ${r.code}` };
  }
  try {
    const data = JSON.parse(r.stdout) as {
      transport?: { type?: string; command?: string; args?: unknown };
    };
    const t = data.transport;
    const args = Array.isArray(t?.args) ? t.args.map(String) : [];
    const info = { command: String(t?.command ?? ''), args };
    const ours = t?.type === 'stdio' && basename(args[0] ?? '') === 'mwf.js' && args[1] === 'mcp';
    return { kind: ours ? 'ours' : 'other', info };
  } catch {
    return { kind: 'error', detail: 'codex mcp get printed something that is not JSON' };
  }
}

function pruneEmpty(o: Obj): void {
  const s = o['mcp_servers'];
  if (s && typeof s === 'object' && Object.keys(s as Obj).length === 0) delete o['mcp_servers'];
}

/** A1: after `codex mcp add|remove`, config.toml may differ from before only by the mwf entry. */
export function verifyConfigChange(
  before: Obj,
  after: Obj,
  expect: McpServerInfo | null,
): string | undefined {
  const b = clone(before);
  const a = clone(after);
  const entry = (a['mcp_servers'] as Obj | undefined)?.[SERVER] as Obj | undefined;
  if (b['mcp_servers']) delete (b['mcp_servers'] as Obj)[SERVER];
  if (a['mcp_servers']) delete (a['mcp_servers'] as Obj)[SERVER];
  pruneEmpty(b);
  pruneEmpty(a);
  if (!deepEqual(a, b)) return 'config.toml changed in a way other than the mwf entry';
  if (expect === null)
    return entry === undefined ? undefined : 'the mwf entry is still in config.toml';
  if (!entry || entry['command'] !== expect.command || !deepEqual(entry['args'], expect.args))
    return 'the mwf entry in config.toml is not what was asked for';
  return undefined;
}

/** Back config.toml up, run `codex mcp add|remove`, and check what changed. */
async function mutateMcp(
  env: CodexEnv,
  args: string[],
  expect: McpServerInfo | null,
  success: McpStep['status'],
  report: Report,
): Promise<McpStep> {
  const owner = env.owner ?? currentOwner();
  const configPath = join(env.codexHome, 'config.toml');
  const manual = expect ? manualAdd(env) : `codex mcp remove ${SERVER}`;
  let snap: Snapshot;
  try {
    snap = readSnapshotOrAbsent(configPath, owner);
  } catch (error) {
    return { status: 'refused', detail: (error as Error).message, manual };
  }
  const before = parseToml(snap);
  if (isErr(before))
    return {
      status: 'refused',
      detail: `config.toml could not be parsed (${before.error}), so a change to it could not be checked; codex was not run`,
      manual,
    };
  let backup: string | undefined;
  if (snap.exists) {
    backup = backupSnapshot(configPath, snap, env.now ? { now: env.now() } : {});
    report.backups.push(backup);
  }
  const r = await env.run(env.codexBin, args, codexEnv(env));
  if (r.spawnError || r.code !== 0)
    return {
      status: 'failed',
      detail: r.spawnError ? `could not run codex: ${r.spawnError}` : `codex exited ${r.code}`,
      manual,
      ...(backup ? { backup } : {}),
    };
  let after: Obj | { error: string };
  try {
    after = parseToml(readSnapshotOrAbsent(configPath, owner));
  } catch (error) {
    return {
      status: 'unexpected_change',
      detail: (error as Error).message,
      ...(backup ? { backup } : {}),
    };
  }
  const problem = isErr(after)
    ? `config.toml no longer parses (${after.error})`
    : verifyConfigChange(before, after, expect);
  if (problem)
    return {
      status: 'unexpected_change',
      detail: `${problem}; it was NOT reverted${backup ? `, the previous file is ${backup}` : ''}. Compare the two before using Codex again.`,
      ...(backup ? { backup } : {}),
    };
  return { status: success, ...(backup ? { backup } : {}) };
}

function hooksPath(env: CodexEnv): string {
  return join(env.codexHome, 'hooks.json');
}

function readHooks(env: CodexEnv, owner: Owner): { snap: Snapshot; doc: unknown } {
  const snap = readSnapshotOrAbsent(hooksPath(env), owner);
  if (!snap.exists) return { snap, doc: {} };
  return { snap, doc: parseStrictJson(snap.content.toString('utf8')) };
}

function describeHooksProblem(error: unknown): string {
  if (error instanceof JsonSyntaxError)
    return `hooks.json is not strict JSON: ${error.message}; it was not changed`;
  return (error as Error).message;
}

const writeOpts = (env: CodexEnv) => ({
  ...(env.owner ? { owner: env.owner } : {}),
  ...(env.now ? { now: env.now() } : {}),
  ...(env.beforeRename ? { beforeRename: env.beforeRename } : {}),
});

export async function installCodex(env: CodexEnv, options: Options): Promise<Report> {
  const report = newReport('install', env, options);
  const owner = env.owner ?? currentOwner();
  const bad = checkPaths(env);
  if (bad) return refuse(report, bad.code, bad.message);
  const version = await checkVersion(env);
  if ('code' in version) return refuse(report, version.code, version.message);
  report.codex_version = version.text;

  // Everything that can be checked without writing is checked first.
  let hooksPlan: {
    snap: Snapshot;
    edit: ReturnType<typeof installHooks>;
    text: string;
    before: unknown;
  };
  try {
    const { snap, doc } = readHooks(env, owner);
    const edit = installHooks(doc, env.node, env.mwfJs);
    checkOnlyOursChanged(doc, edit.doc);
    const style = snap.exists
      ? detectStyle(snap.content.toString('utf8'))
      : { indent: '  ', eol: '\n', finalNewline: true };
    hooksPlan = { snap, edit, text: serializeJson(edit.doc, style), before: doc };
  } catch (error) {
    if (
      error instanceof JsonSyntaxError ||
      error instanceof HooksDocError ||
      error instanceof SafeWriteError
    )
      return refuse(report, 'HOOKS_JSON_REFUSED', describeHooksProblem(error));
    throw error;
  }
  const configPath = join(env.codexHome, 'config.toml');
  try {
    report.warnings.push(
      ...configWarnings(parseToml(readSnapshotOrAbsent(configPath, owner)), configPath),
    );
  } catch (error) {
    report.warnings.push(`${configPath}: ${(error as Error).message}`);
  }

  try {
    if (!options.dryRun) {
      mkdirSync(env.codexHome, { recursive: true, mode: 0o700 });
      // the directory may be new: read hooks.json's snapshot again, now with its real path
      if (!hooksPlan.snap.exists) hooksPlan.snap = readSnapshotOrAbsent(hooksPath(env), owner);
    }

    // 1. skills
    report.skills = installSkills({
      skillsRoot: report.skills_root,
      version: env.version,
      host: 'codex',
      dryRun: options.dryRun,
      force: options.forceSkills,
      owner,
      ...(env.now ? { now: env.now() } : {}),
    });
    for (const s of report.skills) if (s.backup) report.backups.push(s.backup);
    if (report.skills.some((s) => s.status === 'refused')) report.status = 'partial';

    // 2. hooks.json
    const unchanged = hooksPlan.snap.exists && deepEqual(hooksPlan.before, hooksPlan.edit.doc);
    if (unchanged) {
      report.hooks = { path: hooksPath(env), status: 'unchanged', changes: hooksPlan.edit.changes };
    } else {
      let backup: string | undefined;
      if (!options.dryRun) {
        const res = commitFile(hooksPath(env), hooksPlan.text, hooksPlan.snap, {
          ...writeOpts(env),
          mode: 0o600,
        });
        backup = res.backup;
        if (backup) report.backups.push(backup);
      }
      report.hooks = {
        path: hooksPath(env),
        status: hooksPlan.snap.exists ? 'updated' : 'created',
        changes: hooksPlan.edit.changes,
        ...(backup ? { backup } : {}),
      };
    }
  } catch (error) {
    if (error instanceof SafeWriteError) {
      report.status = 'failed';
      report.code = error.code;
      report.message = error.message;
      return report;
    }
    throw error;
  }

  // 3. MCP, only through codex
  const manual = manualAdd(env);
  if (options.dryRun) {
    report.mcp = {
      status: 'planned',
      detail: 'would run it (after backing config.toml up)',
      manual,
    };
  } else {
    const current = await getMcp(env);
    const want: McpServerInfo = { command: env.node, args: [env.mwfJs, 'mcp'] };
    if (current.kind === 'error') report.mcp = { status: 'failed', detail: current.detail, manual };
    else if (current.kind === 'other')
      report.mcp = {
        status: 'refused',
        detail: `an MCP server named "${SERVER}" that is not mwf is already registered; left alone`,
        manual,
      };
    else if (current.kind === 'ours' && deepEqual(current.info, want))
      report.mcp = { status: 'unchanged' };
    else
      report.mcp = await mutateMcp(
        env,
        ['mcp', 'add', SERVER, '--', env.node, env.mwfJs, 'mcp'],
        want,
        current.kind === 'ours' ? 'updated' : 'added',
        report,
      );
  }
  if (report.mcp && !['added', 'updated', 'unchanged', 'planned'].includes(report.mcp.status)) {
    report.status = report.mcp.status === 'unexpected_change' ? 'failed' : 'partial';
    if (report.mcp.status === 'unexpected_change') report.code = 'CONFIG_CHANGED_UNEXPECTEDLY';
  }

  report.notes.push(
    'Codex will not run the new hooks until you review and trust them: open Codex and run /hooks (trust is recorded against each hook definition, so a changed hook needs trusting again). mwf does not touch Codex trust settings.',
    'Memory is per project: run the mwf init tool (/mwf init) in a project to start using it.',
    'The terminal check for install and uninstall only stops accidents; it is not a security boundary (a pseudo-terminal such as `script` provides a terminal).',
  );
  return report;
}

export async function uninstallCodex(env: CodexEnv, options: Options): Promise<Report> {
  const report = newReport('uninstall', env, options);
  const owner = env.owner ?? currentOwner();

  // hooks.json
  try {
    const { snap, doc } = readHooks(env, owner);
    if (!snap.exists) {
      report.hooks = { path: hooksPath(env), status: 'unchanged', changes: [] };
    } else {
      const edit = removeHooks(doc);
      checkOnlyOursChanged(doc, edit.doc);
      if (deepEqual(doc, edit.doc)) {
        report.hooks = { path: hooksPath(env), status: 'unchanged', changes: edit.changes };
      } else if (isEmptyDoc(edit.doc)) {
        let backup: string | undefined;
        let status: 'removed' | 'updated' = 'removed';
        if (!options.dryRun) {
          try {
            backup = removeFile(hooksPath(env), snap, writeOpts(env)).backup;
          } catch (error) {
            if (!(error instanceof SafeWriteError) || error.code !== 'UNSAFE_TARGET') throw error;
            // a symbolic link: keep the link, leave an empty document behind
            backup = commitFile(
              hooksPath(env),
              serializeJson({}, detectStyle(snap.content.toString('utf8'))),
              snap,
              writeOpts(env),
            ).backup;
            status = 'updated';
          }
          if (backup) report.backups.push(backup);
        }
        report.hooks = {
          path: hooksPath(env),
          status,
          changes: edit.changes,
          ...(backup ? { backup } : {}),
        };
      } else {
        let backup: string | undefined;
        if (!options.dryRun) {
          backup = commitFile(
            hooksPath(env),
            serializeJson(edit.doc, detectStyle(snap.content.toString('utf8'))),
            snap,
            writeOpts(env),
          ).backup;
          if (backup) report.backups.push(backup);
        }
        report.hooks = {
          path: hooksPath(env),
          status: 'updated',
          changes: edit.changes,
          ...(backup ? { backup } : {}),
        };
      }
    }
  } catch (error) {
    if (
      error instanceof JsonSyntaxError ||
      error instanceof HooksDocError ||
      error instanceof SafeWriteError
    ) {
      report.hooks = {
        path: hooksPath(env),
        status: 'refused',
        changes: [],
        detail: describeHooksProblem(error),
      };
      report.status = 'partial';
    } else throw error;
  }

  // skills
  report.skills = uninstallSkills({
    skillsRoot: report.skills_root,
    version: env.version,
    host: 'codex',
    dryRun: options.dryRun,
    force: options.forceSkills,
    owner,
    ...(env.now ? { now: env.now() } : {}),
  });
  for (const s of report.skills) if (s.backup) report.backups.push(s.backup);
  if (
    report.skills.some(
      (s) => s.status === 'kept' && s.detail && !/not installed|no SKILL.md/.test(s.detail),
    )
  )
    report.notes.push(
      'Some skills were kept because they are not exactly what mwf wrote; see the list above.',
    );

  // MCP
  const current = await getMcp(env);
  const manual = `codex mcp remove ${SERVER}`;
  if (current.kind === 'error') report.mcp = { status: 'manual', detail: current.detail, manual };
  else if (current.kind === 'absent') report.mcp = { status: 'absent' };
  else if (current.kind === 'other')
    report.mcp = {
      status: 'refused',
      detail: `the MCP server named "${SERVER}" is not mwf; left alone`,
    };
  else if (options.dryRun)
    report.mcp = {
      status: 'planned',
      detail: 'would run it (after backing config.toml up)',
      manual,
    };
  else report.mcp = await mutateMcp(env, ['mcp', 'remove', SERVER], null, 'removed', report);
  if (
    report.mcp &&
    ['manual', 'failed', 'refused', 'unexpected_change'].includes(report.mcp.status)
  ) {
    report.status = report.mcp.status === 'unexpected_change' ? 'failed' : 'partial';
    if (report.mcp.status === 'unexpected_change') report.code = 'CONFIG_CHANGED_UNEXPECTEDLY';
  }
  report.notes.push('Project memory (.mwf/) and backup files (*.mwf-bak-*) are never deleted.');
  return report;
}
