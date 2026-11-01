import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import TOML from '@iarna/toml';
import {
  execRunner,
  installCodex,
  parseCodexVersion,
  uninstallCodex,
  verifyConfigChange,
  type CodexEnv,
  type Report,
} from '../src/lifecycle/codex.ts';
import { classify } from '../src/lifecycle/skills-files.ts';
import { SKILLS } from '../src/skills/index.ts';
import { sandbox, type Sandbox } from './helpers/fake-codex.ts';

const REAL = { dryRun: false, forceSkills: false };
const DRY = { dryRun: true, forceSkills: false };

function envOf(sb: Sandbox, extra: Partial<CodexEnv> = {}, vars: NodeJS.ProcessEnv = {}): CodexEnv {
  return {
    codexHome: sb.codexHome,
    home: sb.home,
    node: process.execPath,
    mwfJs: sb.mwfJs,
    codexBin: sb.codex,
    version: '1.0.0-test',
    run: execRunner,
    baseEnv: { ...sb.env, ...vars },
    ...extra,
  };
}

/** Every file under `dir` (relative path -> mode and content hash), to compare before and after. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        out[p.slice(dir.length) + '/'] = 'dir';
        walk(p);
      } else if (st.isSymbolicLink()) out[p.slice(dir.length)] = 'link';
      else
        out[p.slice(dir.length)] =
          (st.mode & 0o777).toString(8) +
          ':' +
          createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const mode = (p: string): number => statSync(p).mode & 0o777;
const backups = (dir: string, prefix: string): string[] =>
  readdirSync(dir).filter((n) => n.startsWith(prefix) && n.includes('.mwf-bak-'));
const hooksJson = (sb: Sandbox): any =>
  JSON.parse(readFileSync(join(sb.codexHome, 'hooks.json'), 'utf8'));
const config = (sb: Sandbox): any =>
  TOML.parse(readFileSync(join(sb.codexHome, 'config.toml'), 'utf8'));
const skillPath = (sb: Sandbox, name: string): string =>
  join(sb.home, '.agents', 'skills', name, 'SKILL.md');

async function installed(sb: Sandbox, extra: Partial<CodexEnv> = {}): Promise<Report> {
  const r = await installCodex(envOf(sb, extra), REAL);
  assert.equal(r.status, 'done', JSON.stringify(r));
  return r;
}

describe('codex install', () => {
  it('writes the hooks, the skills (user skills directory under HOME) and registers MCP through codex', async () => {
    const sb = sandbox();
    const r = await installed(sb);
    assert.equal(r.codex_version, '0.166.0');
    const h = hooksJson(sb);
    assert.deepEqual(Object.keys(h.hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.equal(h.hooks.SessionStart[0].matcher, 'startup|resume|clear|fork');
    assert.equal(mode(join(sb.codexHome, 'hooks.json')), 0o600);
    for (const e of Object.values(h.hooks) as any[]) assert.equal(e[0].hooks[0].timeout, 5);
    assert.match(h.hooks.Stop[0].hooks[0].command, /mwf\.js' hook stop$/);
    for (const s of SKILLS) {
      const text = readFileSync(skillPath(sb, s.name), 'utf8');
      assert.equal(classify(text).kind, 'intact', s.name);
    }
    assert.equal(
      existsSync(join(sb.codexHome, 'skills')),
      false,
      'the deprecated ~/.codex/skills is not used',
    );
    assert.deepEqual(config(sb).mcp_servers.mwf, {
      command: process.execPath,
      args: [sb.mwfJs, 'mcp'],
    });
    assert.deepEqual(
      sb.calls().filter((c) => c[0] === 'mcp' && c[1] === 'add'),
      [['mcp', 'add', 'mwf', '--', process.execPath, sb.mwfJs, 'mcp']],
    );
    assert.match(r.notes.join('\n'), /\/hooks/);
    assert.match(r.notes.join('\n'), /Next step: .*trust/);
    assert.match(r.notes.join('\n'), /codex exec/);
    assert.match(r.notes.join('\n'), /not a security boundary/);
  });

  it('is idempotent: a second run changes nothing, makes no backup and runs no `mcp add`', async () => {
    const sb = sandbox();
    await installed(sb);
    const before = tree(sb.root);
    const addsBefore = sb.calls().filter((c) => c[1] === 'add').length;
    const r = await installed(sb);
    assert.deepEqual(tree(sb.root), before);
    assert.equal(r.hooks?.status, 'unchanged');
    assert.ok(r.skills.every((s) => s.status === 'unchanged'));
    assert.equal(r.mcp?.status, 'unchanged');
    assert.equal(sb.calls().filter((c) => c[1] === 'add').length, addsBefore);
    assert.deepEqual(r.backups, []);
  });

  it("keeps a user's existing hooks and settings and backs hooks.json and config.toml up as 0600 (A1, A2)", async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    const userHooks =
      '{\n    "hooks": {\n        "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "audit.sh"}]}]\n    },\n    "mine": [1, 2]\n}\n';
    writeFileSync(join(sb.codexHome, 'hooks.json'), userHooks, { mode: 0o644 });
    writeFileSync(
      join(sb.codexHome, 'config.toml'),
      'model = "gpt-x"\n\n[mcp_servers.other]\ncommand = "x"\n',
      { mode: 0o600 },
    );
    const toml = readFileSync(join(sb.codexHome, 'config.toml'), 'utf8');
    const r = await installed(sb);
    const h = hooksJson(sb);
    assert.deepEqual(h.hooks.PreToolUse, JSON.parse(userHooks).hooks.PreToolUse);
    assert.deepEqual(h.mine, [1, 2]);
    assert.match(
      readFileSync(join(sb.codexHome, 'hooks.json'), 'utf8'),
      /^\{\n {4}"hooks"/,
      'indent kept',
    );
    const hb = backups(sb.codexHome, 'hooks.json');
    const cb = backups(sb.codexHome, 'config.toml');
    assert.equal(hb.length, 1);
    assert.equal(cb.length, 1);
    assert.equal(readFileSync(join(sb.codexHome, hb[0]!), 'utf8'), userHooks);
    assert.equal(readFileSync(join(sb.codexHome, cb[0]!), 'utf8'), toml);
    assert.equal(mode(join(sb.codexHome, hb[0]!)), 0o600);
    assert.equal(mode(join(sb.codexHome, cb[0]!)), 0o600);
    assert.equal(mode(join(sb.codexHome, 'hooks.json')), 0o644, 'an existing file keeps its mode');
    assert.equal(config(sb).model, 'gpt-x');
    assert.ok(config(sb).mcp_servers.other && config(sb).mcp_servers.mwf);
    assert.equal(r.backups.length, 2);
  });

  it('replaces a stale mwf registration (moved install) with `mcp add`', async () => {
    const sb = sandbox();
    await installed(sb);
    const moved = join(sb.root, 'pkg2', 'bin');
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, 'mwf.js'), '');
    const r = await installed(sb, { mwfJs: join(moved, 'mwf.js') });
    assert.equal(r.mcp?.status, 'updated');
    assert.deepEqual(config(sb).mcp_servers.mwf.args, [join(moved, 'mwf.js'), 'mcp']);
    assert.match(hooksJson(sb).hooks.Stop[0].hooks[0].command, /pkg2/);
    assert.equal(hooksJson(sb).hooks.Stop.length, 1);
  });

  it('never runs codex through a shell: a hostile path reaches it as one argument and executes nothing', async () => {
    const sb = sandbox();
    const evil = join(sb.root, 'a b; touch PWNED $(touch PWNED2) `touch PWNED3`', 'bin');
    mkdirSync(evil, { recursive: true });
    const mwfJs = join(evil, 'mwf.js');
    writeFileSync(mwfJs, '');
    await installed(sb, { mwfJs });
    const add = sb.calls().find((c) => c[1] === 'add')!;
    assert.deepEqual(add, ['mcp', 'add', 'mwf', '--', process.execPath, mwfJs, 'mcp']);
    for (const f of ['PWNED', 'PWNED2', 'PWNED3']) {
      assert.equal(existsSync(join(sb.root, f)), false);
      assert.equal(existsSync(join(process.cwd(), f)), false);
    }
    // and the hook command, parsed back the way Codex's shell would, is the same three words
    const cmd = hooksJson(sb).hooks.Stop[0].hooks[0].command as string;
    assert.ok(cmd.includes(`'${mwfJs}'`));
  });
});

describe('codex install: A5 version gate', () => {
  async function refusedWith(sb: Sandbox, env: CodexEnv, code: string): Promise<Report> {
    const before = tree(sb.root);
    const r = await installCodex(env, REAL);
    assert.equal(r.status, 'refused');
    assert.equal(r.code, code);
    assert.deepEqual(tree(sb.root), before, 'nothing was written');
    return r;
  }

  it('refuses when codex cannot be run', async () => {
    const sb = sandbox();
    await refusedWith(
      sb,
      envOf(sb, { codexBin: join(sb.root, 'no-such-codex') }),
      'CODEX_VERSION_UNKNOWN',
    );
  });

  it('refuses when the version output cannot be parsed, or the command fails', async () => {
    const sb = sandbox();
    await refusedWith(
      sb,
      envOf(sb, {}, { FAKE_CODEX_VERSION: 'something else entirely' }),
      'CODEX_VERSION_UNKNOWN',
    );
    await refusedWith(
      sb,
      envOf(sb, {}, { FAKE_CODEX_VERSION: 'codex-cli 0.x.y' }),
      'CODEX_VERSION_UNKNOWN',
    );
    await refusedWith(
      sb,
      envOf(sb, { run: async () => ({ code: 3, stdout: 'codex-cli 0.170.0\n', stderr: '' }) }),
      'CODEX_VERSION_UNKNOWN',
    );
  });

  it('refuses a version below 0.165.0 and accepts the floor, newer minors, majors and pre-releases', async () => {
    for (const v of ['0.164.9', '0.100.0', '0.9.99']) {
      const sb = sandbox();
      const r = await refusedWith(
        sb,
        envOf(sb, {}, { FAKE_CODEX_VERSION: `codex-cli ${v}` }),
        'CODEX_TOO_OLD',
      );
      assert.match(r.message!, /0\.165\.0/);
    }
    for (const v of ['0.165.0', '0.165.1', '0.166.0-alpha.1', '0.200.3', '1.0.0']) {
      const sb = sandbox();
      const r = await installCodex(envOf(sb, {}, { FAKE_CODEX_VERSION: `codex-cli ${v}` }), REAL);
      assert.equal(r.status, 'done', v);
    }
  });

  it('parses the version line', () => {
    assert.deepEqual(parseCodexVersion('codex-cli 0.166.0\n'), [0, 166, 0]);
    assert.deepEqual(parseCodexVersion('WARNING: x\ncodex-cli 0.170.2-beta.3\n'), [0, 170, 2]);
    assert.equal(parseCodexVersion('codex 0.166.0'), null);
    assert.equal(parseCodexVersion(''), null);
  });
});

describe('codex install: dry run', () => {
  it('shows the plan and writes nothing at all', async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    writeFileSync(join(sb.codexHome, 'config.toml'), 'model = "m"\n');
    const before = tree(sb.root);
    const r = await installCodex(envOf(sb), DRY);
    assert.deepEqual(tree(sb.root), before);
    assert.equal(r.status, 'done');
    assert.equal(r.hooks?.status, 'created');
    assert.ok(r.skills.every((s) => s.status === 'created'));
    assert.equal(r.mcp?.status, 'planned');
    assert.match(r.mcp!.manual!, /^codex mcp add mwf -- /);
    assert.deepEqual(
      sb.calls().map((c) => c[0]),
      ['--version'],
      'only the version was asked of codex',
    );
  });

  it('works when CODEX_HOME does not exist yet', async () => {
    const sb = sandbox();
    const r = await installCodex(envOf(sb), DRY);
    assert.equal(r.status, 'done');
    assert.equal(existsSync(sb.codexHome), false);
  });
});

describe('codex install: refusals and partial failure', () => {
  it('refuses a hooks.json that is not strict JSON before writing anything', async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    writeFileSync(join(sb.codexHome, 'hooks.json'), '{\n  // mine\n  "hooks": {}\n}\n');
    const before = tree(sb.root);
    const r = await installCodex(envOf(sb), REAL);
    assert.equal(r.status, 'refused');
    assert.equal(r.code, 'HOOKS_JSON_REFUSED');
    assert.match(r.message!, /line 2, column 3/);
    assert.deepEqual(tree(sb.root), before);
    assert.equal(existsSync(join(sb.home, '.agents')), false, 'no skills either');
  });

  it('a hooks.json owned by another user is refused (A3)', async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    writeFileSync(join(sb.codexHome, 'hooks.json'), '{}');
    const r = await installCodex(envOf(sb, { owner: { uid: process.getuid!() + 1 } }), REAL);
    assert.equal(r.status, 'refused');
    assert.match(r.message!, /not owned by the current user/);
  });

  it('a hooks.json that is a symlink into a dotfiles repo is updated in place, the link stays (A3)', async () => {
    const sb = sandbox();
    const dots = join(sb.root, 'dotfiles');
    mkdirSync(dots);
    mkdirSync(sb.codexHome, { recursive: true });
    writeFileSync(join(dots, 'hooks.json'), '{"keep":true}\n');
    symlinkSync(join(dots, 'hooks.json'), join(sb.codexHome, 'hooks.json'));
    await installed(sb);
    assert.ok(lstatSync(join(sb.codexHome, 'hooks.json')).isSymbolicLink());
    const real = JSON.parse(readFileSync(join(dots, 'hooks.json'), 'utf8'));
    assert.equal(real.keep, true);
    assert.ok(real.hooks.Stop);
    assert.equal(backups(sb.codexHome, 'hooks.json').length, 0, 'no stray file beside the link');
    assert.equal(backups(dots, 'hooks.json').length, 1);
    await uninstallCodex(envOf(sb), REAL);
    assert.ok(lstatSync(join(sb.codexHome, 'hooks.json')).isSymbolicLink());
    assert.deepEqual(JSON.parse(readFileSync(join(dots, 'hooks.json'), 'utf8')), { keep: true });
  });

  it('refuses a world-writable CODEX_HOME', async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true, mode: 0o777 });
    (await import('node:fs')).chmodSync(sb.codexHome, 0o777);
    const r = await installCodex(envOf(sb), REAL);
    assert.notEqual(r.status, 'done');
    assert.equal(existsSync(join(sb.codexHome, 'hooks.json')), false);
  });

  it('when `codex mcp add` fails the files stay installed, the status is partial, and the manual command is given', async () => {
    const sb = sandbox();
    const r = await installCodex(envOf(sb, {}, { FAKE_CODEX_MODE: 'fail' }), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.mcp?.status, 'failed');
    assert.match(r.mcp!.manual!, /codex mcp add mwf -- /);
    assert.ok(hooksJson(sb).hooks.Stop);
    assert.ok(existsSync(skillPath(sb, SKILLS[0]!.name)));
    // a re-run after fixing codex completes it without touching the files again
    const r2 = await installCodex(envOf(sb), REAL);
    assert.equal(r2.status, 'done');
    assert.equal(r2.hooks?.status, 'unchanged');
    assert.equal(r2.mcp?.status, 'added');
  });

  it('leaves an mcp server named mwf that is not ours alone', async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    writeFileSync(
      join(sb.codexHome, 'config.toml'),
      '[mcp_servers.mwf]\ncommand = "other-tool"\nargs = ["serve"]\n',
    );
    const r = await installCodex(envOf(sb), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.mcp?.status, 'refused');
    assert.equal(config(sb).mcp_servers.mwf.command, 'other-tool');
    assert.equal(sb.calls().filter((c) => c[1] === 'add').length, 0);
  });

  it("a concurrent change to hooks.json during install aborts that write and keeps the other writer's file", async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    const p = join(sb.codexHome, 'hooks.json');
    writeFileSync(p, '{"hooks":{}}\n');
    const r = await installCodex(
      envOf(sb, { beforeRename: () => writeFileSync(p, '{"hooks":{},"added":"by Codex"}\n') }),
      REAL,
    );
    assert.equal(r.status, 'failed');
    assert.equal(r.code, 'CONCURRENT_MODIFICATION');
    assert.equal(readFileSync(p, 'utf8'), '{"hooks":{},"added":"by Codex"}\n');
    assert.ok(!readdirSync(sb.codexHome).some((n) => n.includes('mwf-tmp')));
  });

  it('warns about config.toml settings that stop hooks, without touching config.toml', async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    const toml = '[features]\nhooks = false\n\n[hooks]\nStop = []\n';
    writeFileSync(join(sb.codexHome, 'config.toml'), toml);
    const r = await installCodex(envOf(sb), REAL);
    assert.match(r.warnings.join('\n'), /hooks = false/);
    assert.match(r.warnings.join('\n'), /inline/);
    const cfg = config(sb);
    assert.equal(cfg.features.hooks, false);
    assert.ok(cfg.mcp_servers.mwf);
  });
});

describe('codex install: A1 config.toml guard', () => {
  it('reports an unexpected change to config.toml by `mcp add`, does not revert it, and names the backup', async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    const original = 'model = "keep"\n';
    writeFileSync(join(sb.codexHome, 'config.toml'), original);
    const r = await installCodex(envOf(sb, {}, { FAKE_CODEX_MODE: 'clobber' }), REAL);
    assert.equal(r.status, 'failed');
    assert.equal(r.code, 'CONFIG_CHANGED_UNEXPECTEDLY');
    assert.equal(r.mcp?.status, 'unexpected_change');
    assert.match(r.mcp!.detail!, /other than the mwf entry/);
    assert.match(r.mcp!.detail!, /NOT reverted/);
    const b = backups(sb.codexHome, 'config.toml');
    assert.equal(b.length, 1);
    assert.equal(r.mcp!.backup, join(sb.codexHome, b[0]!));
    assert.equal(readFileSync(r.mcp!.backup!, 'utf8'), original);
    assert.equal(config(sb).model, 'tampered', 'left as codex wrote it');
  });

  it('also catches a removed section on uninstall', async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    writeFileSync(join(sb.codexHome, 'config.toml'), '[features]\nhooks = true\n');
    await installed(sb);
    const r = await uninstallCodex(envOf(sb, {}, { FAKE_CODEX_MODE: 'delete' }), REAL);
    assert.equal(r.status, 'failed');
    assert.equal(r.mcp?.status, 'unexpected_change');
  });

  it('does not run codex when config.toml cannot be parsed (so a change could not be checked)', async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    writeFileSync(join(sb.codexHome, 'config.toml'), 'this is = = not toml\n');
    // (the fake itself cannot read this file either, so answer `mcp get` with "not found")
    const run: CodexEnv['run'] = (file, args, env) =>
      args[1] === 'get'
        ? Promise.resolve({
            code: 1,
            stdout: '',
            stderr: "Error: No MCP server named 'mwf' found.\n",
          })
        : execRunner(file, args, env);
    const r = await installCodex(envOf(sb, { run }), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.mcp?.status, 'refused');
    assert.match(r.mcp!.detail!, /could not be parsed/);
    assert.equal(sb.calls().filter((c) => c[1] === 'add').length, 0);
    assert.equal(readFileSync(join(sb.codexHome, 'config.toml'), 'utf8'), 'this is = = not toml\n');
  });

  it('verifyConfigChange: only the mwf entry may differ', () => {
    const want = { command: 'node', args: ['/x/mwf.js', 'mcp'] };
    const before = { model: 'a', mcp_servers: { other: { command: 'o' } } };
    const ok = { model: 'a', mcp_servers: { other: { command: 'o' }, mwf: want } };
    assert.equal(verifyConfigChange(before, ok, want), undefined);
    assert.match(verifyConfigChange(before, { ...ok, model: 'b' }, want)!, /other than/);
    assert.match(
      verifyConfigChange(before, { model: 'a', mcp_servers: { mwf: want } }, want)!,
      /other than/,
    );
    assert.match(verifyConfigChange(before, { ...ok, extra: 1 }, want)!, /other than/);
    assert.match(verifyConfigChange(before, before, want)!, /not what was asked/);
    assert.match(
      verifyConfigChange(
        before,
        {
          model: 'a',
          mcp_servers: { other: before.mcp_servers.other, mwf: { command: 'evil', args: [] } },
        },
        want,
      )!,
      /not what was asked/,
    );
    assert.equal(verifyConfigChange(ok, before, null), undefined);
    assert.match(verifyConfigChange(ok, ok, null)!, /still in config\.toml/);
    assert.equal(verifyConfigChange({}, { mcp_servers: {} }, null), undefined);
  });
});

describe('codex skills (A4)', () => {
  it('does not overwrite a skill of the same name that mwf did not write, or one the user edited', async () => {
    const sb = sandbox();
    const [a, b] = SKILLS;
    mkdirSync(join(sb.home, '.agents', 'skills', a!.name), { recursive: true });
    writeFileSync(skillPath(sb, a!.name), 'my own skill\n');
    const r = await installCodex(envOf(sb), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.skills.find((s) => s.name === a!.name)?.status, 'refused');
    assert.equal(readFileSync(skillPath(sb, a!.name), 'utf8'), 'my own skill\n');
    assert.equal(r.skills.find((s) => s.name === b!.name)?.status, 'created');
    // edit one of ours: the next install keeps it too
    writeFileSync(
      skillPath(sb, b!.name),
      readFileSync(skillPath(sb, b!.name), 'utf8').replace('mwf', 'MWF'),
    );
    const edited = readFileSync(skillPath(sb, b!.name), 'utf8');
    const r2 = await installCodex(envOf(sb), REAL);
    assert.equal(r2.skills.find((s) => s.name === b!.name)?.status, 'refused');
    assert.equal(readFileSync(skillPath(sb, b!.name), 'utf8'), edited);
    // --force-skills overwrites after a backup
    const r3 = await installCodex(envOf(sb), { dryRun: false, forceSkills: true });
    assert.equal(r3.status, 'done');
    const step = r3.skills.find((s) => s.name === b!.name)!;
    assert.equal(readFileSync(step.backup!, 'utf8'), edited);
    assert.equal(mode(step.backup!), 0o600);
    assert.equal(classify(readFileSync(skillPath(sb, b!.name), 'utf8')).kind, 'intact');
  });

  it('an older intact mwf skill is upgraded in place', async () => {
    const sb = sandbox();
    await installed(sb, { version: '0.9.0' });
    const r = await installed(sb, { version: '1.0.0-test' });
    assert.ok(r.skills.every((s) => s.status === 'updated'));
    assert.match(readFileSync(skillPath(sb, SKILLS[0]!.name), 'utf8'), /mwf-managed:1\.0\.0-test:/);
  });

  it('a symlinked skill directory is not written into', async () => {
    const sb = sandbox();
    const target = join(sb.root, 'elsewhere');
    mkdirSync(target);
    mkdirSync(join(sb.home, '.agents', 'skills'), { recursive: true });
    symlinkSync(target, join(sb.home, '.agents', 'skills', SKILLS[0]!.name));
    const r = await installCodex(envOf(sb), REAL);
    assert.equal(r.skills[0]?.status, 'refused');
    assert.deepEqual(readdirSync(target), []);
  });
});

describe('codex uninstall', () => {
  it('removes exactly what install wrote, keeps everything else, and backs up what it removes', async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    const userHooks = {
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'audit.sh' }] }] },
    };
    writeFileSync(join(sb.codexHome, 'hooks.json'), JSON.stringify(userHooks, null, 2) + '\n');
    writeFileSync(join(sb.codexHome, 'config.toml'), 'model = "m"\n');
    await installed(sb);
    const r = await uninstallCodex(envOf(sb), REAL);
    assert.equal(r.status, 'done', JSON.stringify(r));
    assert.deepEqual(hooksJson(sb), userHooks);
    assert.deepEqual(config(sb), { model: 'm' });
    for (const s of SKILLS)
      assert.equal(existsSync(join(sb.home, '.agents', 'skills', s.name)), false);
    assert.equal(r.mcp?.status, 'removed');
    assert.ok(readdirSync(sb.codexHome).some((n) => n.startsWith('config.toml.mwf-bak-')));
    for (const f of readdirSync(sb.codexHome).filter((n) => n.includes('.mwf-bak-')))
      assert.equal(mode(join(sb.codexHome, f)), 0o600);
  });

  it('deletes a hooks.json that held only our handlers (after a backup) and is idempotent', async () => {
    const sb = sandbox();
    await installed(sb);
    const r = await uninstallCodex(envOf(sb), REAL);
    assert.equal(r.hooks?.status, 'removed');
    assert.equal(existsSync(join(sb.codexHome, 'hooks.json')), false);
    assert.equal(backups(sb.codexHome, 'hooks.json').length, 1);
    const before = tree(sb.root);
    const again = await uninstallCodex(envOf(sb), REAL);
    assert.equal(again.status, 'done');
    assert.equal(again.hooks?.status, 'unchanged');
    assert.equal(again.mcp?.status, 'absent');
    assert.deepEqual(tree(sb.root), before);
  });

  it('keeps a skill whose hash no longer matches and says so; --force-skills removes it after a backup (A4)', async () => {
    const sb = sandbox();
    await installed(sb);
    const [a, b] = SKILLS;
    const edited =
      readFileSync(skillPath(sb, a!.name), 'utf8') + 'my addition\n'.replace('\n', '\n');
    writeFileSync(
      skillPath(sb, a!.name),
      edited.replace(/<!-- mwf-managed:[^>]*-->\n/, '') +
        '<!-- mwf-managed:1.0.0-test:' +
        '0'.repeat(64) +
        ' -->\n',
    );
    const r = await uninstallCodex(envOf(sb), REAL);
    const kept = r.skills.find((s) => s.name === a!.name)!;
    assert.equal(kept.status, 'kept');
    assert.match(kept.detail!, /hash no longer matches/);
    assert.ok(existsSync(skillPath(sb, a!.name)));
    assert.equal(existsSync(join(sb.home, '.agents', 'skills', b!.name)), false);
    assert.match(r.notes.join('\n'), /kept because/);
    const forced = await uninstallCodex(envOf(sb), { dryRun: false, forceSkills: true });
    const step = forced.skills.find((s) => s.name === a!.name)!;
    assert.equal(step.status, 'removed');
    assert.ok(step.backup && mode(step.backup) === 0o600);
    assert.equal(existsSync(skillPath(sb, a!.name)), false);
  });

  it('never removes a skill that has no mwf marker', async () => {
    const sb = sandbox();
    mkdirSync(join(sb.home, '.agents', 'skills', SKILLS[0]!.name), { recursive: true });
    writeFileSync(skillPath(sb, SKILLS[0]!.name), 'not ours\n');
    await uninstallCodex(envOf(sb), REAL);
    assert.equal(readFileSync(skillPath(sb, SKILLS[0]!.name), 'utf8'), 'not ours\n');
  });

  it('works without a codex program: files go, the MCP removal is handed back as a command', async () => {
    const sb = sandbox();
    await installed(sb);
    const r = await uninstallCodex(envOf(sb, { codexBin: join(sb.root, 'gone') }), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.mcp?.status, 'manual');
    assert.equal(r.mcp?.manual, 'codex mcp remove mwf');
    assert.equal(existsSync(join(sb.codexHome, 'hooks.json')), false);
    assert.ok(config(sb).mcp_servers.mwf, 'config.toml untouched');
  });

  it('leaves an mwf MCP entry that is not ours alone', async () => {
    const sb = sandbox();
    mkdirSync(sb.codexHome, { recursive: true });
    writeFileSync(
      join(sb.codexHome, 'config.toml'),
      '[mcp_servers.mwf]\ncommand = "other"\nargs = ["x"]\n',
    );
    const r = await uninstallCodex(envOf(sb), REAL);
    assert.equal(r.mcp?.status, 'refused');
    assert.equal(config(sb).mcp_servers.mwf.command, 'other');
    assert.equal(sb.calls().filter((c) => c[1] === 'remove').length, 0);
  });

  it('dry run changes nothing and runs no mutating codex command', async () => {
    const sb = sandbox();
    await installed(sb);
    const before = tree(sb.root);
    const r = await uninstallCodex(envOf(sb), DRY);
    assert.deepEqual(tree(sb.root), before);
    assert.equal(r.mcp?.status, 'planned');
    assert.equal(sb.calls().filter((c) => c[1] === 'remove').length, 0);
  });

  it('refuses a malformed hooks.json but still removes the rest', async () => {
    const sb = sandbox();
    await installed(sb);
    writeFileSync(join(sb.codexHome, 'hooks.json'), '{ nope');
    const r = await uninstallCodex(envOf(sb), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.hooks?.status, 'refused');
    assert.equal(readFileSync(join(sb.codexHome, 'hooks.json'), 'utf8'), '{ nope');
    assert.equal(existsSync(skillPath(sb, SKILLS[0]!.name)), false);
  });
});
