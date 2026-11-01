import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { main, type Io } from '../src/cli/main.ts';
import { lifecycleMain, type LifecycleIo } from '../src/lifecycle/main.ts';
import { sandbox, type Sandbox } from './helpers/fake-codex.ts';

const TTY = { stdin: true, stdout: true };

async function run(
  sb: Sandbox,
  argv: string[],
  extra: Partial<LifecycleIo> = {},
): Promise<{ code: number; out: string; err: string }> {
  const res = { out: '', err: '' };
  const code = await lifecycleMain(argv, {
    stdout: (t) => (res.out += t),
    stderr: (t) => (res.err += t),
    entry: sb.mwfJs,
    env: { ...sb.env, CODEX_HOME: sb.codexHome },
    home: sb.home,
    codexBin: sb.codex,
    ...extra,
  });
  return { code, ...res };
}

describe('mwf install / uninstall command line', () => {
  it('a real run needs a terminal on both stdin and stdout, with no bypass (CONFIRM_REQUIRES_TTY)', async () => {
    for (const tty of [
      undefined,
      { stdin: false, stdout: false },
      { stdin: true, stdout: false },
      { stdin: false, stdout: true },
    ]) {
      for (const cmd of ['install', 'uninstall']) {
        const sb = sandbox();
        const r = await run(sb, [cmd, '--harness', 'codex'], tty ? { tty } : {});
        assert.equal(r.code, 1);
        assert.match(r.err, /CONFIRM_REQUIRES_TTY/);
        assert.equal(existsSync(sb.codexHome), false);
        assert.equal(existsSync(join(sb.home, '.agents')), false);
        assert.deepEqual(sb.calls(), [], 'codex was not even asked for its version');
      }
    }
  });

  it('no flag or environment variable can stand in for the terminal', async () => {
    const sb = sandbox();
    const env = {
      ...sb.env,
      CODEX_HOME: sb.codexHome,
      MWF_ASSUME_TTY: '1',
      MWF_YES: '1',
      CI: '',
      TTY: '1',
    };
    for (const flag of ['--yes', '--force', '--tty', '--confirm']) {
      const r = await run(sb, ['install', '--harness', 'codex', flag], { env });
      assert.equal(r.code, 2, flag);
    }
    const r = await run(sb, ['install', '--harness', 'codex'], { env });
    assert.match(r.err, /CONFIRM_REQUIRES_TTY/);
    assert.equal(existsSync(sb.codexHome), false);
  });

  it('--json reports the refusal as a structured error', async () => {
    const sb = sandbox();
    const r = await run(sb, ['install', '--harness', 'codex', '--json']);
    const body = JSON.parse(r.out);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'CONFIRM_REQUIRES_TTY');
    assert.deepEqual(body.error.details, { stdin_tty: false, stdout_tty: false });
  });

  it('--dry-run works without a terminal and changes nothing', async () => {
    const sb = sandbox();
    const r = await run(sb, ['install', '--harness', 'codex', '--dry-run']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /dry run: nothing was written/);
    assert.match(r.out, /hooks\s+created/);
    assert.match(r.out, /run it yourself: codex mcp add mwf -- /);
    assert.equal(existsSync(sb.codexHome), false);
    const u = await run(sb, ['uninstall', '--harness', 'codex', '--dry-run']);
    assert.equal(u.code, 0, u.err);
  });

  it('a real run in a terminal installs, prints a readable summary and uninstalls', async () => {
    const sb = sandbox();
    const r = await run(sb, ['install', '--harness', 'codex'], { tty: TTY });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /mwf install --harness codex: done \(Codex 0\.166\.0\)/);
    assert.match(r.out, /\/hooks/);
    assert.ok(existsSync(join(sb.codexHome, 'hooks.json')));
    const j = await run(sb, ['install', '--harness', 'codex', '--json'], { tty: TTY });
    assert.equal(JSON.parse(j.out).ok, true);
    assert.equal(JSON.parse(j.out).data.hooks.status, 'unchanged');
    const u = await run(sb, ['uninstall', '--harness', 'codex'], { tty: TTY });
    assert.equal(u.code, 0, u.err);
    assert.equal(existsSync(join(sb.codexHome, 'hooks.json')), false);
  });

  it('a refusal or partial result exits 1 and says what to do', async () => {
    const sb = sandbox();
    const r = await run(sb, ['install', '--harness', 'codex'], {
      tty: TTY,
      codexBin: join(sb.root, 'missing'),
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /CODEX_VERSION_UNKNOWN/);
    assert.match(r.err, /nothing was installed/);
  });

  it('usage errors exit 2: missing or unknown harness, extra arguments', async () => {
    const sb = sandbox();
    for (const [args, re] of [
      [['install'], /needs --harness codex/],
      [['install', '--harness', 'vim'], /unknown harness/],
      [['install', '--harness', 'codex', 'extra'], /Unexpected argument/],
      [['uninstall', '--bogus'], /Unknown option/],
    ] as Array<[string[], RegExp]>) {
      const r = await run(sb, args, { tty: TTY });
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.err, re);
    }
    assert.equal((await run(sb, ['install', '--help'])).code, 0);
    assert.match((await run(sb, ['install', '--help'])).out, /not a security boundary/);
  });

  it('refuses a source-tree run (mwf.ts) because the hooks must point at the built mwf.js', async () => {
    const sb = sandbox();
    const r = await run(sb, ['install', '--harness', 'codex'], {
      tty: TTY,
      entry: join(sb.root, 'src', 'bin', 'mwf.ts'),
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /NOT_INSTALLED_BUILD/);
    assert.equal(existsSync(sb.codexHome), false);
  });

  it('refuses a relative CODEX_HOME', async () => {
    const sb = sandbox();
    const r = await run(sb, ['install', '--harness', 'codex', '--dry-run'], {
      env: { ...sb.env, CODEX_HOME: 'relative/dir' },
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /INVALID_PATH/);
  });

  it('the shell command line itself leaves install / uninstall to the executable; update is not built', async () => {
    const out = { out: '', err: '' };
    const io: Io = {
      stdout: (t) => (out.out += t),
      stderr: (t) => (out.err += t),
      cwd: process.cwd(),
    };
    assert.equal(await main(['install'], io), 2);
    assert.match(out.err, /mwf executable/);
  });
});

describe('the mwf executable (type-stripped source)', () => {
  const bin = new URL('../src/bin/mwf.ts', import.meta.url).pathname;
  const spawn = (sb: Sandbox, args: string[]) =>
    spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', bin, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // PATH holds no `codex`: this test must never reach a real one
      env: { PATH: join(sb.root, 'empty'), HOME: sb.home, CODEX_HOME: sb.codexHome },
    });

  it('install without a terminal is refused and writes nothing', () => {
    const sb = sandbox();
    mkdirSync(join(sb.root, 'empty'));
    const r = spawn(sb, ['install', '--harness', 'codex']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CONFIRM_REQUIRES_TTY/);
    assert.deepEqual(readdirSync(sb.home), []);
  });

  it('a source-tree install --dry-run is refused (hooks must point at the built mwf.js); uninstall --dry-run hands the MCP removal back', () => {
    const sb = sandbox();
    mkdirSync(join(sb.root, 'empty'));
    const i = spawn(sb, ['install', '--harness', 'codex', '--dry-run', '--json']);
    assert.equal(i.status, 1, i.stderr);
    assert.equal(JSON.parse(i.stdout).data.code, 'NOT_INSTALLED_BUILD');
    const u = spawn(sb, ['uninstall', '--harness', 'codex', '--dry-run']);
    assert.equal(u.status, 1);
    assert.match(u.stderr, /codex mcp remove mwf/);
    assert.deepEqual(readdirSync(sb.home), []);
  });

  it('--help lists the new commands', () => {
    const sb = sandbox();
    const r = spawn(sb, ['--help']);
    assert.match(r.stdout, /install \| uninstall --harness codex\|claude/);
    assert.ok(readFileSync(bin, 'utf8').includes('lifecycle'));
  });
});
