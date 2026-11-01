// The `mwf install` / `mwf uninstall` command line (the lifecycle layer; bin dispatches here).
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { MWF_VERSION } from '../core/index.ts';
import {
  execRunner,
  installCodex,
  MIN_CODEX_TEXT,
  uninstallCodex,
  type CodexEnv,
  type Report,
  type Runner,
} from './codex.ts';
import type { Owner } from './safe-write.ts';

export interface LifecycleIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Set only by src/bin/mwf.ts (from isTTY) and by tests; no environment variable overrides it. */
  tty?: { stdin: boolean; stdout: boolean };
  /** process.argv[1]: the script being run (resolved through symlinks to find mwf.js). */
  entry: string;
  /** Test seams; the bin leaves them unset. */
  env?: NodeJS.ProcessEnv;
  home?: string;
  node?: string;
  codexBin?: string;
  run?: Runner;
  owner?: Owner;
  now?: () => Date;
  beforeRename?: () => void;
}

const USAGE = `Usage: mwf install   --harness codex [--dry-run] [--json] [--force-skills]
       mwf uninstall --harness codex [--dry-run] [--json] [--force-skills]

Connects mwf to a host, at user level only (never a project's own config):
  codex: <CODEX_HOME or ~/.codex>/hooks.json (three hooks), the skills in ~/.agents/skills, and the MCP
         server through \`codex mcp add\` (Codex's config.toml is never edited by mwf directly).
         Needs Codex ${MIN_CODEX_TEXT} or newer. Afterwards run /hooks in Codex to trust the hooks.

  --dry-run       show what would change; writes nothing, runs no codex command that changes anything,
                  and works without a terminal
  --json          print the result as JSON
  --force-skills  overwrite (after a backup) or remove skills mwf did not write or that you edited

A real install or uninstall runs only for a person at an interactive terminal: standard input and
standard output must both be terminals (CONFIRM_REQUIRES_TTY), so a pipe, a script or an agent's shell
tool cannot run it by accident. A pseudo-terminal (for example \`script\`) provides a terminal, so
this prevents accidents only, it is not a security boundary.
Every file is backed up before it is changed (<name>.mwf-bak-<time>-<id>, mode 0600) and backups are
never deleted. Uninstall removes only what mwf wrote and keeps project memory (.mwf/).
Exit codes: 0 done, 1 refused / partial / failed, 2 usage error.
`;

class Usage extends Error {}

function fail(
  io: LifecycleIo,
  json: boolean,
  code: string,
  message: string,
  details: object = {},
): number {
  if (json)
    io.stdout(`${JSON.stringify({ ok: false, error: { code, message, details } }, null, 2)}\n`);
  else io.stderr(`mwf: ${code}: ${message}\n`);
  return 1;
}

export function renderReport(r: Report): string {
  const lines: string[] = [];
  const verb = r.action === 'install' ? 'install' : 'uninstall';
  lines.push(
    `mwf ${verb} --harness codex${r.dry_run ? ' (dry run: nothing was written)' : ''}: ${r.status}` +
      (r.codex_version ? ` (Codex ${r.codex_version})` : ''),
  );
  if (r.message) lines.push(`  ${r.code ?? ''}: ${r.message}`);
  if (r.hooks)
    lines.push(
      `  hooks      ${r.hooks.status}  ${r.hooks.path}` +
        (r.hooks.detail ? `\n             ${r.hooks.detail}` : '') +
        (r.hooks.backup ? `\n             backup: ${r.hooks.backup}` : ''),
    );
  if (r.skills.length > 0) lines.push(`  skills     (${r.skills_root})`);
  for (const s of r.skills)
    lines.push(
      `    ${s.name}: ${s.status}${s.detail ? ` - ${s.detail}` : ''}${s.backup ? ` (backup: ${s.backup})` : ''}`,
    );
  if (r.mcp) {
    lines.push(`  mcp        ${r.mcp.status}${r.mcp.detail ? ` - ${r.mcp.detail}` : ''}`);
    if (r.mcp.backup) lines.push(`             config.toml backup: ${r.mcp.backup}`);
    if (
      r.mcp.manual &&
      !['added', 'updated', 'removed', 'unchanged', 'absent'].includes(r.mcp.status)
    )
      lines.push(`             run it yourself: ${r.mcp.manual}`);
  }
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  return `${lines.join('\n')}\n`;
}

/** Runs `install` or `uninstall`; `argv[0]` is the command. Returns the exit code. */
export async function lifecycleMain(argv: readonly string[], io: LifecycleIo): Promise<number> {
  const [name, ...rest] = argv;
  const wantJson = rest.includes('--json');
  try {
    if (name !== 'install' && name !== 'uninstall')
      throw new Usage(`unknown command: ${name ?? ''}`);
    let parsed;
    try {
      parsed = parseArgs({
        args: [...rest],
        allowPositionals: false,
        options: {
          harness: { type: 'string' },
          'dry-run': { type: 'boolean' },
          json: { type: 'boolean' },
          'force-skills': { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
        },
      });
    } catch (error) {
      throw new Usage((error as Error).message);
    }
    if (parsed.values.help) {
      io.stdout(USAGE);
      return 0;
    }
    const harness = parsed.values.harness;
    if (harness === undefined) throw new Usage(`${name} needs --harness codex`);
    if (harness !== 'codex')
      throw new Usage(
        harness === 'claude'
          ? `--harness claude is not available yet in this build; only --harness codex is`
          : `unknown harness: ${harness} (only codex is available)`,
      );
    const dryRun = parsed.values['dry-run'] === true;
    if (!dryRun && !(io.tty?.stdin === true && io.tty?.stdout === true)) {
      const stdin = io.tty?.stdin === true;
      const stdout = io.tty?.stdout === true;
      const lacking = [!stdin ? 'standard input' : '', !stdout ? 'standard output' : ''].filter(
        Boolean,
      );
      return fail(
        io,
        wantJson,
        'CONFIRM_REQUIRES_TTY',
        `${name} changes files in your home directory, so it only runs for you in an interactive terminal: ${lacking.join(' and ')} ${lacking.length > 1 ? 'are' : 'is'} not a terminal. Nothing was changed. Run it yourself in a terminal without pipes or redirects (or add --dry-run to see what it would do).`,
        { stdin_tty: stdin, stdout_tty: stdout },
      );
    }

    const processEnv = io.env ?? process.env;
    const home = io.home ?? homedir();
    const rawCodexHome = processEnv['CODEX_HOME'];
    const codexHome = rawCodexHome ? rawCodexHome : join(home, '.codex');
    if (!isAbsolute(codexHome) || !isAbsolute(home))
      return fail(
        io,
        wantJson,
        'INVALID_PATH',
        'CODEX_HOME and the home directory must be absolute paths',
      );
    let mwfJs: string;
    try {
      mwfJs = realpathSync(io.entry);
    } catch {
      mwfJs = io.entry;
    }
    const env: CodexEnv = {
      codexHome,
      home,
      node: io.node ?? process.execPath,
      mwfJs,
      codexBin: io.codexBin ?? 'codex',
      version: MWF_VERSION,
      run: io.run ?? execRunner,
      baseEnv: processEnv,
      ...(io.owner ? { owner: io.owner } : {}),
      ...(io.now ? { now: io.now } : {}),
      ...(io.beforeRename ? { beforeRename: io.beforeRename } : {}),
    };
    const options = { dryRun, forceSkills: parsed.values['force-skills'] === true };
    const report = await (name === 'install'
      ? installCodex(env, options)
      : uninstallCodex(env, options));
    if (parsed.values.json)
      io.stdout(`${JSON.stringify({ ok: report.status === 'done', data: report }, null, 2)}\n`);
    else (report.status === 'done' ? io.stdout : io.stderr)(renderReport(report));
    return report.status === 'done' ? 0 : 1;
  } catch (error) {
    if (error instanceof Usage) {
      io.stderr(`mwf: ${error.message}\nRun "mwf install --help" for usage.\n`);
      return 2;
    }
    io.stderr(`mwf: ${(error as Error).message}\n`);
    return 1;
  }
}
