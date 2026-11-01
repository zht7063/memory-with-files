// A stand-in for the `pi` program, so no test ever runs (or reads the config of) a real Pi.
// It understands exactly what mwf calls: --version and `mcp add <name> [--exposure x] [--description d]
// -- cmd args…` / `mcp remove <name>`, and it mimics Pi 1.4.0 (extensions/mcp/cli.js, config.js):
//   the file is $PI_CODING_AGENT_DIR/mcp.json when set, else $HOME/.pi/agent/mcp.json;
//   `add` writes mcpServers.<name> = {command, args?, exposure?, description?} and REPLACES an entry
//   of the same name; other content is kept; the file is rewritten with JSON.stringify(…, null, 2).
// Every call is appended to $FAKE_PI_LOG (one JSON array of argv per line). Environment:
//   FAKE_PI_VERSION   what `--version` prints (default "1.4.0"; empty prints nothing)
//   FAKE_PI_EXIT      `--version` exits with this code
//   FAKE_PI_MODE      fail      `mcp add|remove` exits 1 and changes nothing
//                     clobber   `mcp add|remove` also rewrites an unrelated top-level key
//                     delete    `mcp add|remove` also drops every other server
//                     breakjson `mcp add|remove` leaves mcp.json as invalid JSON
//                     noexposure `mcp add` forgets the exposure (the entry is not in our form)
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from './util.ts';

const SCRIPT = (node: string): string => `#!${node}
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
if (process.env.FAKE_PI_LOG) fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(argv) + '\\n');
const dir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME, '.pi', 'agent');
const file = path.join(dir, 'mcp.json');
if (argv[0] === '--version') {
  const v = process.env.FAKE_PI_VERSION ?? '1.4.0';
  if (v) process.stdout.write(v + '\\n');
  process.exit(Number(process.env.FAKE_PI_EXIT ?? 0));
}
if (argv[0] !== 'mcp') process.exit(64);
const mode = process.env.FAKE_PI_MODE ?? '';
if (mode === 'fail') { process.stderr.write('boom\\n'); process.exit(1); }
const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
if (argv[1] === 'add') {
  const dash = argv.indexOf('--');
  const name = argv[2];
  if (dash < 0 || !name) process.exit(2);
  const entry = { command: argv[dash + 1] };
  if (argv.length > dash + 2) entry.args = argv.slice(dash + 2);
  if (mode !== 'noexposure' && flag('--exposure') !== undefined) entry.exposure = flag('--exposure');
  if (flag('--description') !== undefined) entry.description = flag('--description');
  cfg.mcpServers = cfg.mcpServers ?? {};
  cfg.mcpServers[name] = entry;
} else if (argv[1] === 'remove') {
  const name = argv[2];
  if (!cfg.mcpServers || cfg.mcpServers[name] === undefined) { process.stderr.write('No global MCP server named "' + name + '"\\n'); process.exit(1); }
  delete cfg.mcpServers[name];
} else process.exit(64);
if (mode === 'clobber') cfg.theme = 'tampered';
if (mode === 'delete') for (const k of Object.keys(cfg.mcpServers ?? {})) if (k !== argv[2]) delete cfg.mcpServers[k];
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\\n');
if (mode === 'breakjson') fs.writeFileSync(file, '{ broken');
process.exit(0);
`;

export interface PiSandbox {
  root: string;
  home: string;
  /** Pi's agent directory: ~/.pi/agent, or a separate directory when `customDir`. */
  piDir: string;
  /** The file `pi mcp add|remove` writes. */
  mcpJson: string;
  customDir: boolean;
  /** Path of the fake `pi`. */
  pi: string;
  log: string;
  mwfJs: string;
  /** The environment the fake runs under (fed to PiEnv.baseEnv). Never the real one. */
  env: NodeJS.ProcessEnv;
  calls(): string[][];
}

export function piSandbox(customDir = false): PiSandbox {
  const root = tmpDir('mwf-pi-');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const piDir = customDir ? join(root, 'agent') : join(home, '.pi', 'agent');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const pi = join(bin, 'pi');
  writeFileSync(pi, SCRIPT(process.execPath));
  chmodSync(pi, 0o755);
  const log = join(tmpDir('mwf-pilog-'), 'pi.log');
  const mwfDir = join(root, 'pkg', 'bin');
  mkdirSync(mwfDir, { recursive: true });
  const mwfJs = join(mwfDir, 'mwf.js');
  writeFileSync(mwfJs, '// not run\n');
  const env: NodeJS.ProcessEnv = { PATH: bin, FAKE_PI_LOG: log, HOME: home };
  if (customDir) env['PI_CODING_AGENT_DIR'] = piDir;
  return {
    root,
    home,
    piDir,
    mcpJson: join(piDir, 'mcp.json'),
    customDir,
    pi,
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
