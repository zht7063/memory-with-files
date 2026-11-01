// A stand-in for the `claude` program, so no test ever runs (or reads the config of) a real Claude Code.
// It understands exactly what mwf calls: --version, `mcp add --transport stdio --scope <s> <name> -- cmd args…`
// and `mcp remove <name> --scope <s>`, and it mimics where the real CLI writes:
//   user scope   -> top-level `mcpServers` of the .claude.json file
//   local scope  -> `projects[<cwd>].mcpServers` of the same file (the default when --scope is missing)
// and that file is $CLAUDE_CONFIG_DIR/.claude.json when CLAUDE_CONFIG_DIR is set, else $HOME/.claude.json
// (beside ~/.claude, not in it). Like the real one it refuses to add a name that already exists in the scope.
// Every call is appended to $FAKE_CLAUDE_LOG (one JSON array of argv per line). Environment:
//   FAKE_CLAUDE_VERSION   what `--version` prints (default "2.1.314 (Claude Code)"; empty prints nothing)
//   FAKE_CLAUDE_EXIT      `--version` exits with this code
//   FAKE_CLAUDE_MODE      fail     `mcp add|remove` exits 1 and changes nothing
//                         clobber  `mcp add|remove` also rewrites an unrelated top-level setting
//                         delete   `mcp add|remove` also drops `projects`
//                         breakjson `mcp add|remove` leaves .claude.json as invalid JSON
//                         settings `mcp add|remove` does its job but also rewrites an unrelated key ("model")
//                                  in <config dir>/settings.json, which the real CLI has no business touching
//                         settingsbreak  same, but leaves settings.json as invalid JSON
// Claude Code's own first-run writes (F4), independent of the mode:
//   FAKE_CLAUDE_FIRSTRUN  1  adds, to every key that is absent, the nine top-level keys the real 2.1.314
//                            adds on its first run, and writes <config dir>/backups/.claude.json.backup.<ms>
//   FAKE_CLAUDE_EXTRA     1  also adds a top-level key that is NOT one of them
//   FAKE_CLAUDE_CHANGE    <key>  changes the value of that top-level key
//   FAKE_CLAUDE_DELETE    <key>  deletes that top-level key
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './util.ts';

const SCRIPT = (node: string): string => `#!${node}
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(argv) + '\\n');
const dir = process.env.CLAUDE_CONFIG_DIR;
const file = dir ? path.join(dir, '.claude.json') : path.join(process.env.HOME, '.claude.json');
const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
const save = (o) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(o, null, 2), { mode: 0o600 }); };
if (argv[0] === '--version') {
  const v = process.env.FAKE_CLAUDE_VERSION ?? '2.1.314 (Claude Code)';
  if (v) process.stdout.write(v + '\\n');
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
}
if (argv[0] !== 'mcp') process.exit(64);
const mode = process.env.FAKE_CLAUDE_MODE ?? '';
if (mode === 'fail') { process.stderr.write('boom\\n'); process.exit(1); }
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
const scope = flag('--scope') ?? 'local';
const cfg = load();
const holder = () => {
  if (scope === 'user') return cfg;
  cfg.projects = cfg.projects ?? {};
  cfg.projects[process.cwd()] = cfg.projects[process.cwd()] ?? {};
  return cfg.projects[process.cwd()];
};
const FIRST = ['firstStartTime','firstStartVersion','hasResetAutoModeOptInForDefaultOffer','machineID','migrationVersion','opusProMigrationComplete','seenNotifications','sonnet1m45MigrationComplete','userID'];
if (process.env.FAKE_CLAUDE_FIRSTRUN) {
  const v = { firstStartTime: '2026-11-01T00:00:00.000Z', firstStartVersion: '2.1.314', hasResetAutoModeOptInForDefaultOffer: true, machineID: 'm-1', migrationVersion: 11, opusProMigrationComplete: true, seenNotifications: {}, sonnet1m45MigrationComplete: true, userID: 'u-1' };
  for (const k of FIRST) if (!(k in cfg)) cfg[k] = v[k];
  const bdir = path.join(dir ?? path.join(process.env.HOME, '.claude'), 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, '.claude.json.backup.' + Date.now()), '{}', { mode: 0o600 });
}
if (process.env.FAKE_CLAUDE_EXTRA) cfg.someNewKey = 1;
if (process.env.FAKE_CLAUDE_CHANGE) cfg[process.env.FAKE_CLAUDE_CHANGE] = 'changed-by-claude';
if (process.env.FAKE_CLAUDE_DELETE) delete cfg[process.env.FAKE_CLAUDE_DELETE];
if (argv[1] === 'add') {
  const dash = argv.indexOf('--');
  const name = argv[dash - 1];
  const h = holder();
  h.mcpServers = h.mcpServers ?? {};
  if (h.mcpServers[name]) { process.stderr.write('MCP server ' + name + ' already exists in ' + scope + ' config\\n'); process.exit(1); }
  h.mcpServers[name] = { type: flag('--transport') ?? 'stdio', command: argv[dash + 1], args: argv.slice(dash + 2), env: {} };
} else if (argv[1] === 'remove') {
  const name = argv[2];
  const h = holder();
  if (!h.mcpServers || !h.mcpServers[name]) { process.stderr.write('No MCP server found with name: ' + name + '\\n'); process.exit(1); }
  delete h.mcpServers[name];
} else process.exit(64);
if (mode === 'clobber') cfg.theme = 'tampered';
if (mode === 'delete') delete cfg.projects;
save(cfg);
if (mode === 'breakjson') fs.writeFileSync(file, '{ broken');
if (mode === 'settings' || mode === 'settingsbreak') {
  const sf = path.join(dir ?? path.join(process.env.HOME, '.claude'), 'settings.json');
  const cur = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : {};
  cur.model = 'tampered-by-claude';
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  fs.writeFileSync(sf, mode === 'settings' ? JSON.stringify(cur, null, 2) : '{ broken', { mode: 0o600 });
}
process.exit(0);
`;

export interface ClaudeSandbox {
  root: string;
  home: string;
  /** Claude Code's config directory: ~/.claude, or a separate directory when `customDir`. */
  claudeDir: string;
  /** The file `claude mcp --scope user` writes. */
  claudeJson: string;
  customDir: boolean;
  /** Path of the fake `claude`. */
  claude: string;
  log: string;
  mwfJs: string;
  /** The environment the fake runs under (fed to ClaudeEnv.baseEnv). Never the real one. */
  env: NodeJS.ProcessEnv;
  calls(): string[][];
}

export function claudeSandbox(customDir = false): ClaudeSandbox {
  const root = tmpDir('mwf-claude-');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const claudeDir = customDir ? join(root, 'cfg') : join(home, '.claude');
  const claudeJson = customDir ? join(claudeDir, '.claude.json') : join(home, '.claude.json');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const claude = join(bin, 'claude');
  writeFileSync(claude, SCRIPT(process.execPath));
  chmodSync(claude, 0o755);
  const log = join(tmpDir('mwf-claudelog-'), 'claude.log');
  const mwfDir = join(root, 'pkg', 'bin');
  mkdirSync(mwfDir, { recursive: true });
  const mwfJs = join(mwfDir, 'mwf.js');
  writeFileSync(mwfJs, '// not run\n');
  const env: NodeJS.ProcessEnv = { PATH: bin, FAKE_CLAUDE_LOG: log, HOME: home };
  if (customDir) env['CLAUDE_CONFIG_DIR'] = claudeDir;
  return {
    root,
    home,
    claudeDir,
    claudeJson,
    customDir,
    claude,
    log,
    mwfJs,
    env,
    calls: () => {
      try {
        return readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[]);
      } catch {
        return [];
      }
    },
  };
}
