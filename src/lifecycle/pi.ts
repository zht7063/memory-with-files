// `mwf install|uninstall --harness pi`: what gets written, in what order, and how it is checked.
// It is the Claude Code install (claude.ts) with Pi's own places; the safe-write, json-edit and
// skills-files primitives are shared unchanged. (hooks-doc.ts does not apply: Pi has no hooks file,
// its hooks live in the generated extension, see pi-extension.ts.)
//
// Writes (user level only, never a project's `.pi/` or `.agents/`):
//   <PI_CODING_AGENT_DIR or ~/.pi/agent>/skills/mwf*/SKILL.md   the skills (Pi's own skills directory)
//   <PI_CODING_AGENT_DIR or ~/.pi/agent>/extensions/mwf.js      the generated thin-shell extension
//                                                               (hooks + the /mwf command)
//   <PI_CODING_AGENT_DIR or ~/.pi/agent>/mcp.json               ONLY through `pi mcp add|remove`; mwf
//     never edits it, it only reads it and checks what the CLI changed
// settings.json is neither read nor written. Order: skills -> extension -> MCP. Every file write is
// atomic and backed up; nothing is rolled back across files, and uninstall (stateless: it recognises
// our entries) removes whatever was written.
import { existsSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  execRunner,
  noteSkillCodes,
  type McpStep,
  type Options,
  type Report,
  type Runner,
} from './codex.ts';
import { shellQuote, UnquotableError } from './hooks-doc.ts';
import { JsonSyntaxError, clone, deepEqual, parseStrictJson } from './json-edit.ts';
import { classifyExtension, EXTENSION_NAME, renderExtension } from './pi-extension.ts';
import {
  SafeWriteError,
  backupSnapshot,
  commitFile,
  currentOwner,
  mkdirSafe,
  readSnapshot,
  readSnapshotOrAbsent,
  removeFile,
  type Owner,
  trustRootFor,
  unsafeOr,
  withRoot,
} from './safe-write.ts';
import { installSkills, uninstallSkills } from './skills-files.ts';
import { SKILLS } from '../skills/index.ts';

export { execRunner };

/** The oldest Pi this install supports: the version the plan was verified against. */
export const MIN_PI = { major: 1, minor: 4, patch: 0 } as const;
export const MIN_PI_TEXT = '1.4.0';

export interface PiEnv {
  /** Pi's agent directory (PI_CODING_AGENT_DIR when set, else ~/.pi/agent). */
  piDir: string;
  /** True when PI_CODING_AGENT_DIR was set. */
  customDir: boolean;
  /** The user's home (where the shared ~/.agents/skills lives). */
  home: string;
  /** Absolute path of the node that will run the hooks and the MCP server. */
  node: string;
  /** Absolute path of the installed `mwf.js`. */
  mwfJs: string;
  /** The `pi` program (a name looked up on PATH, or a path). */
  piBin: string;
  version: string;
  run: Runner;
  baseEnv?: NodeJS.ProcessEnv;
  owner?: Owner;
  now?: () => Date;
  beforeRename?: () => void;
}

/** The owner with the trust root: the user's home when the Pi agent directory is inside it. */
const ownerOf = (env: PiEnv): Owner =>
  withRoot(env.owner ?? currentOwner(), trustRootFor(env.piDir, env.home));

const SERVER = 'mwf';
const DESCRIPTION = 'mwf: project memory (the mwf_* tools)';

export const extensionPath = (env: PiEnv): string => join(env.piDir, 'extensions', EXTENSION_NAME);
export const skillsRoot = (env: PiEnv): string => join(env.piDir, 'skills');
/** The file `pi mcp add|remove` writes (A1 backs up and checks THIS file). */
export const mcpJsonPath = (env: PiEnv): string => join(env.piDir, 'mcp.json');

/**
 * The environment the `pi` program runs under: PI_CODING_AGENT_DIR exactly as the user has it (never
 * invented when unset) and HOME as we computed the paths from, so the file we check is the file the
 * CLI writes.
 */
const piEnvVars = (env: PiEnv): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...(env.baseEnv ?? process.env), HOME: env.home };
  if (env.customDir) e['PI_CODING_AGENT_DIR'] = env.piDir;
  else delete e['PI_CODING_AGENT_DIR'];
  return e;
};

function newReport(action: Report['action'], env: PiEnv, options: Options): Report {
  return {
    harness: 'pi',
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

/**
 * `pi --version` prints the bare version on one line (`1.4.0`). The WHOLE output must be that line
 * (one trailing newline allowed): no prefix, no suffix such as `-rc.1`, no second line.
 */
export function parsePiVersion(output: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(output.replace(/\r?\n$/, ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const atLeast = (v: [number, number, number]): boolean =>
  v[0] !== MIN_PI.major
    ? v[0] > MIN_PI.major
    : v[1] !== MIN_PI.minor
      ? v[1] > MIN_PI.minor
      : v[2] >= MIN_PI.patch;

/** A5: no version, no install. */
async function checkVersion(
  env: PiEnv,
): Promise<{ text: string } | { code: string; message: string }> {
  const r = await env.run(env.piBin, ['--version'], piEnvVars(env));
  const parsed = r.spawnError || r.code !== 0 ? null : parsePiVersion(r.stdout);
  if (!parsed)
    return {
      code: 'PI_VERSION_UNPARSEABLE',
      message: `could not read the Pi version (\`${env.piBin} --version\` ${r.spawnError ? `failed: ${r.spawnError}` : r.code !== 0 ? `exited ${r.code}` : 'did not print exactly one bare version such as 1.4.0'}); nothing was installed. Install Pi ${MIN_PI_TEXT} or newer and make sure \`pi\` is on PATH.`,
    };
  const text = parsed.join('.');
  if (!atLeast(parsed))
    return {
      code: 'PI_VERSION_TOO_OLD',
      message: `Pi ${text} is older than ${MIN_PI_TEXT}, the oldest version this install supports; nothing was installed.`,
    };
  return { text };
}

function checkPaths(env: PiEnv): { code: string; message: string } | undefined {
  if (!isAbsolute(env.node) || !isAbsolute(env.mwfJs) || !isAbsolute(env.piDir))
    return {
      code: 'INVALID_PATH',
      message: 'the node and mwf.js paths and the Pi agent directory must be absolute',
    };
  if (basename(env.mwfJs) !== 'mwf.js')
    return {
      code: 'NOT_INSTALLED_BUILD',
      message: `this is not the built mwf (${basename(env.mwfJs)}); install from the built package (\`npm i -g @zht7063/mwf\`), not from the source tree`,
    };
  try {
    // the extension and the MCP entry need no quoting (JSON / exec form), but the command we print does
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
  exposure: string | undefined;
}

function manualAdd(env: PiEnv): string {
  return `pi mcp add ${SERVER} --exposure direct --description ${shellQuote(DESCRIPTION)} -- ${shellQuote(env.node)} ${shellQuote(env.mwfJs)} mcp`;
}
const MANUAL_REMOVE = `pi mcp remove ${SERVER}`;

/** The parsed mcp.json (read only; a missing file is an empty document), or the reason it cannot be trusted. */
function readMcpJson(env: PiEnv, owner: Owner): { doc: Obj; exists: boolean } | { error: string } {
  const file = mcpJsonPath(env);
  let snap;
  try {
    snap = readSnapshotOrAbsent(file, owner);
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (!snap.exists) return { doc: {}, exists: false };
  try {
    const doc = parseStrictJson(snap.content.toString('utf8'));
    if (!isObj(doc)) return { error: `${file} does not hold a JSON object` };
    if (doc['mcpServers'] !== undefined && !isObj(doc['mcpServers']))
      return { error: `${file} has an "mcpServers" that is not an object` };
    return { doc, exists: true };
  } catch (error) {
    return {
      error:
        error instanceof JsonSyntaxError
          ? `${file} is not strict JSON: ${error.message}`
          : (error as Error).message,
    };
  }
}

/**
 * What the `mcpServers.mwf` entry in mcp.json is.
 *  - `current`: ours, in the form this install writes: a stdio entry whose `args[0]` has the basename
 *    `mwf.js`, `args[1]` is `mcp`, and `exposure` is explicitly `"direct"` (the same shape test as
 *    claudeIsOurs, plus the exposure that makes the tools visible to the model);
 *  - `stale`: ours by args, but `exposure` is missing (read by Pi as `codemode`: the tools are not
 *    declared to the model) or something else: not our form, replaced through `pi mcp add`;
 *  - `other`: anything else, left alone.
 */
export function mcpState(
  doc: Obj,
): { kind: 'absent' } | { kind: 'current' | 'stale' | 'other'; info: McpServerInfo } {
  const servers = doc['mcpServers'];
  const entry = isObj(servers) ? servers[SERVER] : undefined;
  if (entry === undefined) return { kind: 'absent' };
  if (!isObj(entry)) return { kind: 'other', info: { command: '', args: [], exposure: undefined } };
  const args = Array.isArray(entry['args']) ? entry['args'].map(String) : [];
  const exposure = typeof entry['exposure'] === 'string' ? entry['exposure'] : undefined;
  const info: McpServerInfo = { command: String(entry['command'] ?? ''), args, exposure };
  const stdio = typeof entry['command'] === 'string' && entry['url'] === undefined;
  const byArgs = stdio && basename(args[0] ?? '') === 'mwf.js' && args[1] === 'mcp';
  if (!byArgs) return { kind: 'other', info };
  return { kind: entry['exposure'] === 'direct' ? 'current' : 'stale', info };
}

function pruneEmpty(o: Obj): void {
  const s = o['mcpServers'];
  if (isObj(s) && Object.keys(s).length === 0) delete o['mcpServers'];
}

/**
 * A1: after `pi mcp add|remove`, mcp.json may differ from before only by the `mcpServers.mwf` entry
 * (every other server and key must be exactly as it was).
 */
export function verifyMcpJsonChange(
  before: Obj,
  after: Obj,
  expect: { command: string; args: string[] } | null,
): string | undefined {
  const b = clone(before);
  const a = clone(after);
  const entry = isObj(a['mcpServers']) ? a['mcpServers'][SERVER] : undefined;
  if (isObj(b['mcpServers'])) delete b['mcpServers'][SERVER];
  if (isObj(a['mcpServers'])) delete a['mcpServers'][SERVER];
  pruneEmpty(b);
  pruneEmpty(a);
  if (!deepEqual(a, b)) return 'mcp.json changed in a way other than the mwf entry';
  if (expect === null)
    return entry === undefined ? undefined : 'the mwf entry is still in mcp.json';
  if (
    !isObj(entry) ||
    entry['command'] !== expect.command ||
    !deepEqual(entry['args'], expect.args) ||
    entry['exposure'] !== 'direct' ||
    entry['url'] !== undefined
  )
    return 'the mwf entry in mcp.json is not what was asked for';
  return undefined;
}

/** Appended to every CONFIG_CHANGED_UNEXPECTEDLY message: an open session is the usual cause. */
export const CLOSE_SESSIONS_HINT =
  'Close every running Pi session first: an open session may also rewrite its configuration and can cause CONFIG_CHANGED_UNEXPECTEDLY. Then compare the backup with the current file before using Pi again.';

/** Back mcp.json up, run the pi command, and check what changed. */
async function mutateMcp(
  env: PiEnv,
  args: string[],
  expect: { command: string; args: string[] } | null,
  success: McpStep['status'],
  report: Report,
): Promise<McpStep> {
  const owner = ownerOf(env);
  const file = mcpJsonPath(env);
  const manual = expect ? manualAdd(env) : MANUAL_REMOVE;
  const first = readMcpJson(env, owner);
  if ('error' in first)
    return {
      status: 'refused',
      detail: `${first.error}, so a change to it could not be checked; pi was not run`,
      manual,
    };
  let backup: string | undefined;
  if (first.exists) {
    // the backup is of the file the CLI really writes, taken (mode 0600) before the CLI runs
    const snap = readSnapshot(file, owner);
    // beside the real file: a symlinked mcp.json (dotfiles) is backed up where it lives, as with commitFile
    backup = backupSnapshot(file, snap, {
      dir: dirname(snap.real),
      ...(env.now ? { now: env.now() } : {}),
    });
    report.backups.push(backup);
  }
  const r = await env.run(env.piBin, args, piEnvVars(env));
  if (r.spawnError || r.code !== 0)
    return {
      status: 'failed',
      detail: r.spawnError
        ? `could not run pi: ${r.spawnError}`
        : `pi ${args.slice(0, 2).join(' ')} exited ${r.code}`,
      manual,
      ...(backup ? { backup } : {}),
    };
  const after = readMcpJson(env, owner);
  const problem =
    'error' in after
      ? `mcp.json can no longer be read as strict JSON (${after.error})`
      : verifyMcpJsonChange(first.doc, after.doc, expect);
  if (problem)
    return {
      status: 'unexpected_change',
      detail: `${problem}; it was NOT reverted${backup ? `, the previous file is ${backup}` : ''}. ${CLOSE_SESSIONS_HINT}`,
      ...(backup ? { backup } : {}),
    };
  return { status: success, ...(backup ? { backup } : {}) };
}

const writeOpts = (env: PiEnv, owner: Owner) => ({
  owner,
  ...(env.now ? { now: env.now() } : {}),
  ...(env.beforeRename ? { beforeRename: env.beforeRename } : {}),
});

/** A same-named mwf skill in the shared ~/.agents/skills (Codex's), which install never touches. */
function codexSkillWarnings(env: PiEnv): string[] {
  const found: string[] = [];
  for (const skill of SKILLS) {
    const file = join(env.home, '.agents', 'skills', skill.name, 'SKILL.md');
    try {
      lstatSync(file);
      found.push(file);
    } catch {
      /* not there */
    }
  }
  if (found.length === 0) return [];
  return [
    `mwf skills for another tool are in ${join(env.home, '.agents', 'skills')} (${found.length} found, e.g. ${found[0]}); mwf left them untouched and will not change them. Pi reads ${skillsRoot(env)} before ~/.agents/skills, so Pi uses the mwf skills installed here, and the text there (bare tool names) is not used by Pi. A same-named mwf skill in a project's own .agents/skills (or in any ancestor directory's .agents/skills) or in its .pi/skills has HIGHER priority than ${skillsRoot(env)} and would override the skills installed here; mwf does not scan projects for those.`,
  ];
}

const COMMON_NOTES = [
  'The terminal check for install and uninstall only stops accidents; it is not a security boundary (a pseudo-terminal such as `script` provides a terminal).',
];

export async function installPi(env: PiEnv, options: Options): Promise<Report> {
  const report = newReport('install', env, options);
  const owner = ownerOf(env);
  const bad = checkPaths(env);
  if (bad) return refuse(report, bad.code, bad.message);
  const version = await checkVersion(env);
  if ('code' in version) return refuse(report, version.code, version.message);
  report.pi_version = version.text;

  const want = renderExtension({ node: env.node, mwfJs: env.mwfJs, version: env.version });
  report.warnings.push(...codexSkillWarnings(env));
  if (env.customDir)
    report.warnings.push(
      `PI_CODING_AGENT_DIR is set (${env.piDir}): everything is written there, including mcp.json.`,
    );

  try {
    if (!options.dryRun) mkdirSafe(env.piDir, owner, 0o700);

    // 1. skills
    report.skills = installSkills({
      skillsRoot: report.skills_root,
      version: env.version,
      host: 'pi',
      dryRun: options.dryRun,
      force: options.forceSkills,
      owner,
      ...(env.now ? { now: env.now() } : {}),
    });
    for (const s of report.skills) if (s.backup) report.backups.push(s.backup);
    if (report.skills.some((s) => s.status === 'refused')) report.status = 'partial';
    noteSkillCodes(report);

    // 2. the extension (hooks + /mwf)
    const path = extensionPath(env);
    let step: NonNullable<Report['hooks']>;
    try {
      if (!options.dryRun) mkdirSafe(join(env.piDir, 'extensions'), owner, 0o755);
      const snap = readSnapshotOrAbsent(path, owner);
      const text = snap.exists ? snap.content.toString('utf8') : '';
      const state = snap.exists ? classifyExtension(text) : undefined;
      if (!snap.exists) {
        if (!options.dryRun)
          commitFile(path, want, snap, { ...writeOpts(env, owner), mode: 0o644, backup: false });
        step = { path, status: 'created', changes: [] };
      } else if (state!.kind === 'none' && !options.forceSkills) {
        step = {
          path,
          status: 'refused',
          changes: [],
          detail:
            'an extension that mwf did not write is already there; kept (--force-skills overwrites it, after a backup)',
        };
      } else if (state!.kind === 'modified' && !options.forceSkills) {
        step = {
          path,
          status: 'refused',
          changes: [],
          detail:
            'you have edited this extension since mwf wrote it; kept (--force-skills overwrites it, after a backup)',
        };
      } else if (text === want) {
        step = { path, status: 'unchanged', changes: [] };
      } else {
        // an intact file is mwf's own older version: replace it without a backup; anything else
        // (only with --force-skills) is the user's text and is backed up first
        const ours = state!.kind === 'intact';
        let backup: string | undefined;
        if (!options.dryRun) {
          backup = commitFile(path, want, snap, {
            ...writeOpts(env, owner),
            mode: 0o644,
            backup: !ours,
          }).backup;
          if (backup) report.backups.push(backup);
        }
        step = { path, status: 'updated', changes: [], ...(backup ? { backup } : {}) };
      }
    } catch (error) {
      if (!(error instanceof SafeWriteError)) throw error;
      step = {
        path,
        status: 'refused',
        changes: [],
        detail: error.message,
        ...(unsafeOr(error, '') ? { code: 'UNSAFE_TARGET' } : {}),
      };
      if (unsafeOr(error, '')) report.code ??= 'UNSAFE_TARGET';
    }
    report.hooks = step;
    if (step.status === 'refused') report.status = 'partial';
  } catch (error) {
    if (error instanceof SafeWriteError) {
      report.status = 'failed';
      report.code = error.code;
      report.message = error.message;
      return report;
    }
    throw error;
  }

  // 3. MCP, only through pi
  const manual = manualAdd(env);
  if (options.dryRun) {
    report.mcp = {
      status: 'planned',
      detail: `would run it (after backing ${mcpJsonPath(env)} up)`,
      manual,
    };
  } else {
    const mj = readMcpJson(env, owner);
    const wanted = { command: env.node, args: [env.mwfJs, 'mcp'] };
    if ('error' in mj)
      report.mcp = { status: 'refused', detail: `${mj.error}; pi was not run`, manual };
    else {
      const current = mcpState(mj.doc);
      if (current.kind === 'other')
        report.mcp = {
          status: 'refused',
          detail: `an MCP server named "${SERVER}" that is not mwf is already registered in ${mcpJsonPath(env)}; left alone`,
          manual,
        };
      else if (
        current.kind === 'current' &&
        current.info.command === wanted.command &&
        deepEqual(current.info.args, wanted.args)
      )
        report.mcp = { status: 'unchanged' };
      else {
        // `pi mcp add` replaces an entry of the same name, so an update is the same command
        const add = [
          'mcp',
          'add',
          SERVER,
          '--exposure',
          'direct',
          '--description',
          DESCRIPTION,
          '--',
          env.node,
          env.mwfJs,
          'mcp',
        ];
        report.mcp = await mutateMcp(
          env,
          add,
          wanted,
          current.kind === 'absent' ? 'added' : 'updated',
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
    `The extension ${extensionPath(env)} runs inside Pi with Pi's full permissions (that is how Pi extensions work); it only starts the mwf program named in it (${env.node} ${env.mwfJs}). Start a new Pi session or run /reload after installing, and check the MCP server with \`pi mcp list\` (it starts the server).`,
    "A same-named mwf skill in a project's own .agents/skills (or an ancestor directory's .agents/skills) or .pi/skills has higher priority than the skills installed here and overrides them.",
    'Memory is per project: run /mwf init in a project to start using it.',
    ...COMMON_NOTES,
  );
  return report;
}

export async function uninstallPi(env: PiEnv, options: Options): Promise<Report> {
  const report = newReport('uninstall', env, options);
  const owner = ownerOf(env);
  const bad = checkPaths(env);
  // uninstall needs no mwf.js/node check (a moved package must still be removable), only an absolute directory
  if (bad && !isAbsolute(env.piDir)) return refuse(report, bad.code, bad.message);

  // the extension: only a file that is still exactly what mwf wrote goes
  const path = extensionPath(env);
  try {
    // a Pi that never had an extensions directory has nothing of ours in it
    const snap = existsSync(dirname(path)) ? readSnapshot(path, owner) : { exists: false as const };
    if (!snap.exists) {
      report.hooks = { path, status: 'unchanged', changes: [] };
    } else {
      const state = classifyExtension(snap.content.toString('utf8'));
      if (state.kind !== 'intact' && !options.forceSkills) {
        report.hooks = {
          path,
          status: 'refused',
          changes: [],
          detail:
            state.kind === 'none'
              ? 'not written by mwf; kept'
              : 'edited since mwf wrote it (its hash no longer matches); kept (--force-skills removes it, after a backup)',
        };
        report.status = 'partial';
      } else {
        let backup: string | undefined;
        if (!options.dryRun) {
          backup = removeFile(path, snap, {
            owner,
            backup: state.kind !== 'intact',
            ...(env.now ? { now: env.now() } : {}),
            ...(env.beforeRename ? { beforeRename: env.beforeRename } : {}),
          }).backup;
          if (backup) report.backups.push(backup);
        }
        report.hooks = { path, status: 'removed', changes: [], ...(backup ? { backup } : {}) };
      }
    }
  } catch (error) {
    if (!(error instanceof SafeWriteError)) throw error;
    report.hooks = {
      path,
      status: 'refused',
      changes: [],
      detail: error.message,
      ...(unsafeOr(error, '') ? { code: 'UNSAFE_TARGET' } : {}),
    };
    report.status = 'partial';
    if (unsafeOr(error, '')) report.code ??= 'UNSAFE_TARGET';
  }

  report.skills = uninstallSkills({
    skillsRoot: report.skills_root,
    version: env.version,
    host: 'pi',
    dryRun: options.dryRun,
    force: options.forceSkills,
    owner,
    ...(env.now ? { now: env.now() } : {}),
  });
  for (const s of report.skills) if (s.backup) report.backups.push(s.backup);
  noteSkillCodes(report);
  if (
    report.skills.some(
      (s) => s.status === 'kept' && s.detail && !/not installed|no SKILL.md/.test(s.detail),
    )
  )
    report.notes.push(
      'Some skills were kept because they are not exactly what mwf wrote; see the list above.',
    );

  // MCP (no version gate on uninstall: removing must work on any Pi). The entry counts as ours by
  // its args alone here: an older entry without `exposure` must be removable too.
  const mj = readMcpJson(env, owner);
  if ('error' in mj) report.mcp = { status: 'manual', detail: mj.error, manual: MANUAL_REMOVE };
  else {
    const current = mcpState(mj.doc);
    if (current.kind === 'absent') report.mcp = { status: 'absent' };
    else if (current.kind === 'other')
      report.mcp = {
        status: 'refused',
        detail: `the MCP server named "${SERVER}" in ${mcpJsonPath(env)} is not mwf; left alone`,
      };
    else if (options.dryRun)
      report.mcp = {
        status: 'planned',
        detail: `would run it (after backing ${mcpJsonPath(env)} up)`,
        manual: MANUAL_REMOVE,
      };
    else report.mcp = await mutateMcp(env, ['mcp', 'remove', SERVER], null, 'removed', report);
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
