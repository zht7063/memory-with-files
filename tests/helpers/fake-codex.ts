// A stand-in for the `codex` program, so no test ever runs (or reads the config of) a real Codex.
// It understands exactly what mwf calls: --version, `mcp get <name> --json`, `mcp add <name> -- cmd args…`,
// `mcp remove <name>`, and keeps its servers in $CODEX_HOME/config.toml like the real one. Every call
// is appended to $FAKE_CODEX_LOG (one JSON array of argv per line). Modes (FAKE_CODEX_MODE):
//   fail     `mcp add|remove` exits 1 and changes nothing
//   clobber  `mcp add|remove` also rewrites an unrelated setting in config.toml
//   delete   `mcp add|remove` also drops [features] from config.toml
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './util.ts';

const TOML = new URL('../../node_modules/@iarna/toml/toml.js', import.meta.url).pathname;

const SCRIPT = (node: string): string => `#!${node}
const fs = require('node:fs');
const path = require('node:path');
const TOML = require(${JSON.stringify(TOML)});
const argv = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(argv) + '\\n');
const home = process.env.CODEX_HOME;
const file = home ? path.join(home, 'config.toml') : null;
const load = () => (file && fs.existsSync(file) ? TOML.parse(fs.readFileSync(file, 'utf8')) : {});
const save = (o) => fs.writeFileSync(file, TOML.stringify(o));
if (argv[0] === '--version') {
  process.stdout.write((process.env.FAKE_CODEX_VERSION ?? 'codex-cli 0.166.0') + '\\n');
  process.exit(0);
}
if (argv[0] !== 'mcp') process.exit(64);
const mode = process.env.FAKE_CODEX_MODE ?? '';
const name = argv[2];
if (argv[1] === 'get') {
  const s = (load().mcp_servers ?? {})[name];
  if (!s) { process.stderr.write("Error: No MCP server named '" + name + "' found.\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({ name, enabled: true, transport: { type: 'stdio', command: s.command, args: s.args ?? [], env: null } }));
  process.exit(0);
}
if (argv[1] === 'add' || argv[1] === 'remove') {
  if (mode === 'fail') { process.stderr.write('boom\\n'); process.exit(1); }
  const cfg = load();
  cfg.mcp_servers = cfg.mcp_servers ?? {};
  if (argv[1] === 'add') {
    const dash = argv.indexOf('--');
    cfg.mcp_servers[name] = { command: argv[dash + 1], args: argv.slice(dash + 2) };
  } else delete cfg.mcp_servers[name];
  if (Object.keys(cfg.mcp_servers).length === 0) delete cfg.mcp_servers;
  if (mode === 'clobber') cfg.model = 'tampered';
  if (mode === 'delete') delete cfg.features;
  fs.mkdirSync(home, { recursive: true });
  save(cfg);
  process.exit(0);
}
process.exit(64);
`;

export interface Sandbox {
  root: string;
  home: string;
  codexHome: string;
  /** Path of the fake `codex`. */
  codex: string;
  log: string;
  mwfJs: string;
  /** The environment the fake runs under (fed to CodexEnv.baseEnv). */
  env: NodeJS.ProcessEnv;
  calls(): string[][];
}

export function sandbox(): Sandbox {
  const root = tmpDir('mwf-codex-');
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const codex = join(bin, 'codex');
  writeFileSync(codex, SCRIPT(process.execPath));
  chmodSync(codex, 0o755);
  const log = join(tmpDir('mwf-codexlog-'), 'codex.log');
  const mwfDir = join(root, 'pkg', 'bin');
  mkdirSync(mwfDir, { recursive: true });
  const mwfJs = join(mwfDir, 'mwf.js');
  writeFileSync(mwfJs, '// not run\n');
  const env: NodeJS.ProcessEnv = { PATH: bin, FAKE_CODEX_LOG: log, HOME: home };
  return {
    root,
    home,
    codexHome,
    codex,
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
