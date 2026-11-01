// `mwf install|uninstall --harness claude`: what gets written, in what order, and how it is checked.
// It is the Codex install (codex.ts) with Claude Code's own places; the safe-write, json-edit and
// skills-files primitives are shared unchanged.
//
// Writes (user level only, never a project's `.claude/` or `.mcp.json`):
//   <CLAUDE_CONFIG_DIR or ~/.claude>/settings.json     three exec-form command hooks ("hooks" key)
//   <CLAUDE_CONFIG_DIR or ~/.claude>/skills/mwf*/SKILL.md   the skills (personal skills directory)
//   Claude Code's .claude.json                          ONLY through `claude mcp add|remove --scope user`
//     (<CLAUDE_CONFIG_DIR>/.claude.json when CLAUDE_CONFIG_DIR is set, else ~/.claude.json: the file the
//     CLI really writes; mwf never edits it, it only reads it and checks what the CLI changed)
// Order: skills -> settings.json hooks -> MCP. Every file write is atomic and backed up; nothing is
// rolled back across files, and uninstall (stateless: it recognises our entries) removes whatever was
// written. Unlike Codex's hooks.json, settings.json is never deleted, even when nothing is left in it.
import { mkdirSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { execRunner, type McpStep, type Options, type Report, type Runner } from './codex.ts';
import {
  checkOnlyOursChanged,
  HooksDocError,
  installHooks,
  removeHooks,
  shellQuote,
  UnquotableError,
} from './hooks-doc.ts';
import { CLAUDE_FLAVOR } from './hooks-settings.ts';
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
  type Owner,
  type Snapshot,
} from './safe-write.ts';
import { installSkills, uninstallSkills } from './skills-files.ts';

export { execRunner };

/** The oldest Claude Code this install supports: the version the plan was verified against. */
export const MIN_CLAUDE = { major: 2, minor: 1, patch: 314 } as const;
export const MIN_CLAUDE_TEXT = '2.1.314';

export interface ClaudeEnv {
  /** Claude Code's config directory (CLAUDE_CONFIG_DIR when set, else ~/.claude). */
  claudeDir: string;
  /** True when CLAUDE_CONFIG_DIR was set (then .claude.json lives inside claudeDir). */
  customDir: boolean;
  /** The user's home (where ~/.claude.json lives when CLAUDE_CONFIG_DIR is not set). */
  home: string;
  /** Absolute path of the node that will run the hooks and the MCP server. */
  node: string;
  /** Absolute path of the installed `mwf.js`. */
  mwfJs: string;
  /** The `claude` program (a name looked up on PATH, or a path). */
  claudeBin: string;
  version: string;
  run: Runner;
  baseEnv?: NodeJS.ProcessEnv;
  owner?: Owner;
  now?: () => Date;
  beforeRename?: () => void;
}

const SERVER = 'mwf';

/** settings.json: where Claude Code reads user-level hooks. */
export const settingsPath = (env: ClaudeEnv): string => join(env.claudeDir, 'settings.json');

/**
 * The file `claude mcp add|remove --scope user` writes (A1 backs up and checks THIS file):
 * `$CLAUDE_CONFIG_DIR/.claude.json` when CLAUDE_CONFIG_DIR is set, else `~/.claude.json`
 * (beside ~/.claude, not inside it).
 */
export const claudeJsonPath = (env: ClaudeEnv): string =>
  env.customDir ? join(env.claudeDir, '.claude.json') : join(env.home, '.claude.json');

export const skillsRoot = (env: ClaudeEnv): string => join(env.claudeDir, 'skills');

/**
 * The environment the `claude` program runs under: CLAUDE_CONFIG_DIR exactly as the user has it
 * (never invented when unset, because that would move the file the CLI writes) and HOME as we
 * computed the paths from, so the file we check is the file the CLI writes.
 */
const claudeEnvVars = (env: ClaudeEnv): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...(env.baseEnv ?? process.env), HOME: env.home };
  if (env.customDir) e['CLAUDE_CONFIG_DIR'] = env.claudeDir;
  else delete e['CLAUDE_CONFIG_DIR'];
  return e;
};

function newReport(action: Report['action'], env: ClaudeEnv, options: Options): Report {
  return {
    harness: 'claude',
    action,
    dry_run: options.dryRun,
    status: 'done',
    skills: [],
    skills_root: skillsRoot(env),
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

/** `claude --version` prints e.g. `2.1.314 (Claude Code)`; anything else is not a version. */
export function parseClaudeVersion(output: string): [number, number, number] | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\s+\(Claude Code\)\s*$/m.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const atLeast = (v: [number, number, number]): boolean =>
  v[0] !== MIN_CLAUDE.major
    ? v[0] > MIN_CLAUDE.major
    : v[1] !== MIN_CLAUDE.minor
      ? v[1] > MIN_CLAUDE.minor
      : v[2] >= MIN_CLAUDE.patch;

/** A5: no version, no install. */
async function checkVersion(
  env: ClaudeEnv,
): Promise<{ text: string } | { code: string; message: string }> {
  const r = await env.run(env.claudeBin, ['--version'], claudeEnvVars(env));
  const parsed = r.spawnError || r.code !== 0 ? null : parseClaudeVersion(r.stdout);
  if (!parsed)
    return {
      code: 'CLAUDE_VERSION_UNKNOWN',
      message: `could not read the Claude Code version (\`${env.claudeBin} --version\` ${r.spawnError ? `failed: ${r.spawnError}` : r.code !== 0 ? `exited ${r.code}` : 'printed something unrecognised'}); nothing was installed. Install Claude Code ${MIN_CLAUDE_TEXT} or newer and make sure \`claude\` is on PATH.`,
    };
  const text = parsed.join('.');
  if (!atLeast(parsed))
    return {
      code: 'CLAUDE_TOO_OLD',
      message: `Claude Code ${text} is older than ${MIN_CLAUDE_TEXT}, the oldest version this install supports; nothing was installed.`,
    };
  return { text };
}

function checkPaths(env: ClaudeEnv): { code: string; message: string } | undefined {
  if (!isAbsolute(env.node) || !isAbsolute(env.mwfJs) || !isAbsolute(env.claudeDir))
    return {
      code: 'INVALID_PATH',
      message: 'the node and mwf.js paths and the Claude config directory must be absolute',
    };
  if (basename(env.mwfJs) !== 'mwf.js')
    return {
      code: 'NOT_INSTALLED_BUILD',
      message: `this is not the built mwf (${basename(env.mwfJs)}); install from the built package (\`npm i -g @zht7063/mwf\`), not from the source tree`,
    };
  try {
    // the hooks need no quoting (exec form), but the command we print for you to run yourself does
    shellQuote(env.node);
    shellQuote(env.mwfJs);
  } catch (error) {
    if (error instanceof UnquotableError)
      return {
        code: 'INVALID_PATH',
        message: 'a path contains a control character and cannot be used in a command',
      };
    throw error;
  }
  return undefined;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

interface McpServerInfo {
  command: string;
  args: string[];
}

function manualAdd(env: ClaudeEnv): string {
  return `claude mcp add --transport stdio --scope user ${SERVER} -- ${shellQuote(env.node)} ${shellQuote(env.mwfJs)} mcp`;
}
const MANUAL_REMOVE = `claude mcp remove ${SERVER} --scope user`;

/** The parsed .claude.json (read only), or the reason it cannot be trusted. */
function readClaudeJson(
  env: ClaudeEnv,
  owner: Owner,
): { snap: Snapshot; doc: Obj } | { error: string } {
  let snap: Snapshot;
  try {
    snap = readSnapshotOrAbsent(claudeJsonPath(env), owner);
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (!snap.exists) return { snap, doc: {} };
  try {
    const doc = parseStrictJson(snap.content.toString('utf8'));
    if (!isObj(doc)) return { error: `${claudeJsonPath(env)} does not hold a JSON object` };
    return { snap, doc };
  } catch (error) {
    return {
      error:
        error instanceof JsonSyntaxError
          ? `${claudeJsonPath(env)} is not strict JSON: ${error.message}`
          : (error as Error).message,
    };
  }
}

/** What the user-scope `mcpServers.mwf` entry in .claude.json is: absent, ours, or someone else's. */
function userMcpState(
  doc: Obj,
): { kind: 'absent' } | { kind: 'ours' | 'other'; info: McpServerInfo } {
  const servers = doc['mcpServers'];
  const entry = isObj(servers) ? servers[SERVER] : undefined;
  if (entry === undefined) return { kind: 'absent' };
  if (!isObj(entry)) return { kind: 'other', info: { command: '', args: [] } };
  const args = Array.isArray(entry['args']) ? entry['args'].map(String) : [];
  const info = { command: String(entry['command'] ?? ''), args };
  const stdio = entry['type'] === undefined || entry['type'] === 'stdio';
  const ours = stdio && basename(args[0] ?? '') === 'mwf.js' && args[1] === 'mcp';
  return { kind: ours ? 'ours' : 'other', info };
}

function pruneEmpty(o: Obj): void {
  const s = o['mcpServers'];
  if (isObj(s) && Object.keys(s).length === 0) delete o['mcpServers'];
}

/**
 * A1: after `claude mcp add|remove --scope user`, .claude.json may differ from before only by the
 * user-scope `mcpServers.mwf` entry (everything else in it, the projects, history and settings the
 * CLI keeps there, must be exactly as it was).
 */
export function verifyClaudeJsonChange(
  before: Obj,
  after: Obj,
  expect: McpServerInfo | null,
): string | undefined {
  const b = clone(before);
  const a = clone(after);
  const entry = isObj(a['mcpServers']) ? a['mcpServers'][SERVER] : undefined;
  if (isObj(b['mcpServers'])) delete b['mcpServers'][SERVER];
  if (isObj(a['mcpServers'])) delete a['mcpServers'][SERVER];
  pruneEmpty(b);
  pruneEmpty(a);
  if (!deepEqual(a, b)) return '.claude.json changed in a way other than the mwf entry';
  if (expect === null)
    return entry === undefined ? undefined : 'the mwf entry is still in .claude.json';
  if (
    !isObj(entry) ||
    entry['command'] !== expect.command ||
    !deepEqual(entry['args'], expect.args) ||
    (entry['type'] !== undefined && entry['type'] !== 'stdio')
  )
    return 'the mwf entry in .claude.json is not what was asked for';
  return undefined;
}

/** Back .claude.json up, run the claude command(s), and check what changed. */
async function mutateMcp(
  env: ClaudeEnv,
  commands: string[][],
  expect: McpServerInfo | null,
  success: McpStep['status'],
  report: Report,
): Promise<McpStep> {
  const owner = env.owner ?? currentOwner();
  const file = claudeJsonPath(env);
  const manual = expect ? manualAdd(env) : MANUAL_REMOVE;
  const first = readClaudeJson(env, owner);
  if ('error' in first)
    return {
      status: 'refused',
      detail: `${first.error}, so a change to it could not be checked; claude was not run`,
      manual,
    };
  let backup: string | undefined;
  if (first.snap.exists) {
    // the backup is of the file the CLI really writes, taken (mode 0600) before the CLI runs
    backup = backupSnapshot(file, first.snap, env.now ? { now: env.now() } : {});
    report.backups.push(backup);
  }
  for (const args of commands) {
    const r = await env.run(env.claudeBin, args, claudeEnvVars(env));
    if (r.spawnError || r.code !== 0)
      return {
        status: 'failed',
        detail: r.spawnError
          ? `could not run claude: ${r.spawnError}`
          : `claude ${args.slice(0, 2).join(' ')} exited ${r.code}`,
        manual,
        ...(backup ? { backup } : {}),
      };
  }
  const after = readClaudeJson(env, owner);
  const problem =
    'error' in after
      ? `.claude.json can no longer be read as strict JSON (${after.error})`
      : verifyClaudeJsonChange(first.doc, after.doc, expect);
  if (problem)
    return {
      status: 'unexpected_change',
      detail: `${problem}; it was NOT reverted${backup ? `, the previous file is ${backup}` : ''}. A running Claude Code session also rewrites this file: close every session and compare the two before using Claude Code again.`,
      ...(backup ? { backup } : {}),
    };
  return { status: success, ...(backup ? { backup } : {}) };
}

const writeOpts = (env: ClaudeEnv) => ({
  ...(env.owner ? { owner: env.owner } : {}),
  ...(env.now ? { now: env.now() } : {}),
  ...(env.beforeRename ? { beforeRename: env.beforeRename } : {}),
});

function readSettings(env: ClaudeEnv, owner: Owner): { snap: Snapshot; doc: unknown } {
  const snap = readSnapshotOrAbsent(settingsPath(env), owner);
  if (!snap.exists) return { snap, doc: {} };
  return { snap, doc: parseStrictJson(snap.content.toString('utf8')) };
}

function describeSettingsProblem(error: unknown): string {
  if (error instanceof JsonSyntaxError)
    return `settings.json is not strict JSON: ${error.message}; it was not changed`;
  return (error as Error).message;
}

/** Read-only warnings about settings.json that make the hooks not run. */
function settingsWarnings(doc: unknown, path: string): string[] {
  const out: string[] = [];
  if (isObj(doc) && doc['disableAllHooks'] === true)
    out.push(
      `${path} sets "disableAllHooks": true; the mwf hooks will not run until that is changed (mwf did not change it)`,
    );
  return out;
}

const COMMON_NOTES = [
  'The terminal check for install and uninstall only stops accidents; it is not a security boundary (a pseudo-terminal such as `script` provides a terminal).',
];

export async function installClaude(env: ClaudeEnv, options: Options): Promise<Report> {
  const report = newReport('install', env, options);
  const owner = env.owner ?? currentOwner();
  const bad = checkPaths(env);
  if (bad) return refuse(report, bad.code, bad.message);
  const version = await checkVersion(env);
  if ('code' in version) return refuse(report, version.code, version.message);
  report.claude_version = version.text;

  // Everything that can be checked without writing is checked first.
  let plan: {
    snap: Snapshot;
    edit: ReturnType<typeof installHooks>;
    text: string;
    before: unknown;
  };
  try {
    const { snap, doc } = readSettings(env, owner);
    const edit = installHooks(doc, env.node, env.mwfJs, CLAUDE_FLAVOR);
    checkOnlyOursChanged(doc, edit.doc, CLAUDE_FLAVOR);
    const style = snap.exists
      ? detectStyle(snap.content.toString('utf8'))
      : { indent: '  ', eol: '\n', finalNewline: true };
    plan = { snap, edit, text: serializeJson(edit.doc, style), before: doc };
    report.warnings.push(...settingsWarnings(doc, settingsPath(env)));
  } catch (error) {
    if (
      error instanceof JsonSyntaxError ||
      error instanceof HooksDocError ||
      error instanceof SafeWriteError
    )
      return refuse(report, 'SETTINGS_JSON_REFUSED', describeSettingsProblem(error));
    throw error;
  }
  if (env.customDir)
    report.warnings.push(
      `CLAUDE_CONFIG_DIR is set (${env.claudeDir}): everything is written there, including .claude.json. Open Claude Code issue #48448 reports that user-scope MCP servers may not start under a custom CLAUDE_CONFIG_DIR; check \`/mcp\` in Claude Code after installing.`,
    );

  try {
    if (!options.dryRun) {
      mkdirSync(env.claudeDir, { recursive: true, mode: 0o700 });
      if (!plan.snap.exists) plan.snap = readSnapshotOrAbsent(settingsPath(env), owner);
    }

    // 1. skills
    report.skills = installSkills({
      skillsRoot: report.skills_root,
      version: env.version,
      host: 'claude',
      dryRun: options.dryRun,
      force: options.forceSkills,
      owner,
      ...(env.now ? { now: env.now() } : {}),
    });
    for (const s of report.skills) if (s.backup) report.backups.push(s.backup);
    if (report.skills.some((s) => s.status === 'refused')) report.status = 'partial';

    // 2. settings.json hooks
    if (plan.snap.exists && deepEqual(plan.before, plan.edit.doc)) {
      report.hooks = { path: settingsPath(env), status: 'unchanged', changes: plan.edit.changes };
    } else {
      let backup: string | undefined;
      if (!options.dryRun) {
        const res = commitFile(settingsPath(env), plan.text, plan.snap, {
          ...writeOpts(env),
          mode: 0o600,
        });
        backup = res.backup;
        if (backup) report.backups.push(backup);
      }
      report.hooks = {
        path: settingsPath(env),
        status: plan.snap.exists ? 'updated' : 'created',
        changes: plan.edit.changes,
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

  // 3. MCP, only through claude
  const manual = manualAdd(env);
  if (options.dryRun) {
    report.mcp = {
      status: 'planned',
      detail: `would run it (after backing ${claudeJsonPath(env)} up)`,
      manual,
    };
  } else {
    const cj = readClaudeJson(env, owner);
    const want: McpServerInfo = { command: env.node, args: [env.mwfJs, 'mcp'] };
    if ('error' in cj)
      report.mcp = {
        status: 'refused',
        detail: `${cj.error}; claude was not run`,
        manual,
      };
    else {
      const current = userMcpState(cj.doc);
      if (current.kind === 'other')
        report.mcp = {
          status: 'refused',
          detail: `a user-scope MCP server named "${SERVER}" that is not mwf is already registered; left alone`,
          manual,
        };
      else if (current.kind === 'ours' && deepEqual(current.info, want))
        report.mcp = { status: 'unchanged' };
      else {
        const add = [
          'mcp',
          'add',
          '--transport',
          'stdio',
          '--scope',
          'user',
          SERVER,
          '--',
          env.node,
          env.mwfJs,
          'mcp',
        ];
        report.mcp = await mutateMcp(
          env,
          current.kind === 'ours' ? [['mcp', 'remove', SERVER, '--scope', 'user'], add] : [add],
          want,
          current.kind === 'ours' ? 'updated' : 'added',
          report,
        );
      }
    }
  }
  if (report.mcp && !['added', 'updated', 'unchanged', 'planned'].includes(report.mcp.status)) {
    report.status = report.mcp.status === 'unexpected_change' ? 'failed' : 'partial';
    if (report.mcp.status === 'unexpected_change') report.code = 'CONFIG_CHANGED_UNEXPECTEDLY';
  }

  report.notes.push(
    'Claude Code runs user-level hooks in a project only after you accept its workspace trust prompt (the first time you open it there); start a new Claude Code session after installing. mwf does not touch any Claude Code trust or permission setting, and never writes permissions.allow.',
    'Memory is per project: run /mwf init in a project to start using it.',
    ...COMMON_NOTES,
  );
  return report;
}

export async function uninstallClaude(env: ClaudeEnv, options: Options): Promise<Report> {
  const report = newReport('uninstall', env, options);
  const owner = env.owner ?? currentOwner();

  // settings.json: only our hooks go; the file stays even when nothing is left in it
  try {
    const { snap, doc } = readSettings(env, owner);
    if (!snap.exists) {
      report.hooks = { path: settingsPath(env), status: 'unchanged', changes: [] };
    } else {
      const edit = removeHooks(doc, CLAUDE_FLAVOR);
      checkOnlyOursChanged(doc, edit.doc, CLAUDE_FLAVOR);
      if (deepEqual(doc, edit.doc)) {
        report.hooks = { path: settingsPath(env), status: 'unchanged', changes: edit.changes };
      } else {
        let backup: string | undefined;
        if (!options.dryRun) {
          backup = commitFile(
            settingsPath(env),
            serializeJson(edit.doc, detectStyle(snap.content.toString('utf8'))),
            snap,
            writeOpts(env),
          ).backup;
          if (backup) report.backups.push(backup);
        }
        report.hooks = {
          path: settingsPath(env),
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
        path: settingsPath(env),
        status: 'refused',
        changes: [],
        detail: describeSettingsProblem(error),
      };
      report.status = 'partial';
    } else throw error;
  }

  report.skills = uninstallSkills({
    skillsRoot: report.skills_root,
    version: env.version,
    host: 'claude',
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

  // MCP (no version gate on uninstall: removing must work on any Claude Code)
  const cj = readClaudeJson(env, owner);
  if ('error' in cj) report.mcp = { status: 'manual', detail: cj.error, manual: MANUAL_REMOVE };
  else {
    const current = userMcpState(cj.doc);
    if (current.kind === 'absent') report.mcp = { status: 'absent' };
    else if (current.kind === 'other')
      report.mcp = {
        status: 'refused',
        detail: `the user-scope MCP server named "${SERVER}" is not mwf; left alone`,
      };
    else if (options.dryRun)
      report.mcp = {
        status: 'planned',
        detail: `would run it (after backing ${claudeJsonPath(env)} up)`,
        manual: MANUAL_REMOVE,
      };
    else
      report.mcp = await mutateMcp(
        env,
        [['mcp', 'remove', SERVER, '--scope', 'user']],
        null,
        'removed',
        report,
      );
  }
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
