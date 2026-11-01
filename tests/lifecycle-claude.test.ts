import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  claudeJsonPath,
  installClaude,
  parseClaudeVersion,
  uninstallClaude,
  verifyClaudeJsonChange,
  type ClaudeEnv,
} from '../src/lifecycle/claude.ts';
import { execRunner, type Report } from '../src/lifecycle/codex.ts';
import { lifecycleMain, type LifecycleIo } from '../src/lifecycle/main.ts';
import { checkOnlyOursChanged, HooksDocError, removeHooks } from '../src/lifecycle/hooks-doc.ts';
import { CLAUDE_FLAVOR, claudeIsOurs } from '../src/lifecycle/hooks-settings.ts';
import { classify } from '../src/lifecycle/skills-files.ts';
import { SKILLS } from '../src/skills/index.ts';
import { claudeSandbox, type ClaudeSandbox } from './helpers/fake-claude.ts';

const REAL = { dryRun: false, forceSkills: false };
const DRY = { dryRun: true, forceSkills: false };

// the hint a user must see when mwf reports CONFIG_CHANGED_UNEXPECTEDLY (written out here on purpose)
const CLOSE_HINT =
  /Close every running Claude Code session first: an open session also rewrites these files and can cause CONFIG_CHANGED_UNEXPECTEDLY/;

function envOf(
  sb: ClaudeSandbox,
  extra: Partial<ClaudeEnv> = {},
  vars: NodeJS.ProcessEnv = {},
): ClaudeEnv {
  return {
    claudeDir: sb.claudeDir,
    customDir: sb.customDir,
    home: sb.home,
    node: process.execPath,
    mwfJs: sb.mwfJs,
    claudeBin: sb.claude,
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
const settingsFile = (sb: ClaudeSandbox): string => join(sb.claudeDir, 'settings.json');
const settings = (sb: ClaudeSandbox): any => JSON.parse(readFileSync(settingsFile(sb), 'utf8'));
const claudeJson = (sb: ClaudeSandbox): any => JSON.parse(readFileSync(sb.claudeJson, 'utf8'));
const skillPath = (sb: ClaudeSandbox, name: string): string =>
  join(sb.claudeDir, 'skills', name, 'SKILL.md');
const adds = (sb: ClaudeSandbox): string[][] => sb.calls().filter((c) => c[1] === 'add');

async function installed(sb: ClaudeSandbox, extra: Partial<ClaudeEnv> = {}): Promise<Report> {
  const r = await installClaude(envOf(sb, extra), REAL);
  assert.equal(r.status, 'done', JSON.stringify(r));
  return r;
}

/** The documents have the same content once mwf's own handlers are taken out of the new one. */
const withoutOurs = (doc: any): any => removeHooks(doc, CLAUDE_FLAVOR).doc;

const SECRET_JSON = {
  numStartups: 7,
  oauthAccount: { emailAddress: 'someone@example.invalid' },
  projects: { '/some/project': { allowedTools: [], mcpServers: { local1: { command: 'x' } } } },
  mcpServers: { other: { type: 'stdio', command: 'other-server', args: [], env: {} } },
};

describe('claude install', () => {
  it('writes exec-form hooks to settings.json, the skills to ~/.claude/skills and registers MCP through claude', async () => {
    const sb = claudeSandbox();
    const r = await installed(sb);
    assert.equal(r.harness, 'claude');
    assert.equal(r.claude_version, '2.1.314');
    const h = settings(sb).hooks;
    assert.deepEqual(Object.keys(h).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.equal(h.SessionStart[0].matcher, 'startup|resume|clear|fork');
    assert.equal(h.UserPromptSubmit[0].matcher, undefined);
    assert.equal(mode(settingsFile(sb)), 0o600);
    const want: Record<string, string> = {
      SessionStart: 'session-start',
      UserPromptSubmit: 'prompt',
      Stop: 'stop',
    };
    for (const [event, arg] of Object.entries(want)) {
      assert.deepEqual(h[event][0].hooks, [
        {
          type: 'command',
          command: process.execPath,
          args: [sb.mwfJs, 'hook', arg, '--host', 'claude'],
          timeout: 5,
          statusMessage: 'mwf',
        },
      ]);
    }
    for (const s of SKILLS) {
      const text = readFileSync(skillPath(sb, s.name), 'utf8');
      assert.equal(classify(text).kind, 'intact', s.name);
    }
    assert.match(readFileSync(skillPath(sb, 'mwf'), 'utf8'), /mcp__mwf__mwf_/);
    assert.equal(existsSync(join(sb.home, '.agents')), false, '~/.agents/skills is Codex only');
    assert.deepEqual(claudeJson(sb).mcpServers.mwf, {
      type: 'stdio',
      command: process.execPath,
      args: [sb.mwfJs, 'mcp'],
      env: {},
    });
    assert.deepEqual(adds(sb), [
      [
        'mcp',
        'add',
        '--transport',
        'stdio',
        '--scope',
        'user',
        'mwf',
        '--',
        process.execPath,
        sb.mwfJs,
        'mcp',
      ],
    ]);
    assert.equal(claudeJson(sb).projects, undefined, 'user scope, not a project-local entry');
    assert.equal(settings(sb).permissions, undefined, 'permissions.allow is never written');
    assert.match(r.notes.join('\n'), /workspace trust/);
    assert.match(r.notes.join('\n'), /not a security boundary/);
    assert.equal(existsSync(join(sb.home, '.mcp.json')), false);
  });

  it('is idempotent: a second run changes nothing, makes no backup and runs no `mcp add`', async () => {
    const sb = claudeSandbox();
    await installed(sb);
    const before = tree(sb.root);
    const n = adds(sb).length;
    const r = await installed(sb);
    assert.deepEqual(tree(sb.root), before);
    assert.equal(r.hooks?.status, 'unchanged');
    assert.ok(r.skills.every((s) => s.status === 'unchanged'));
    assert.equal(r.mcp?.status, 'unchanged');
    assert.equal(adds(sb).length, n);
    assert.deepEqual(r.backups, []);
  });

  it('replaces a stale registration (moved install): remove, then add, in one backed-up step', async () => {
    const sb = claudeSandbox();
    await installed(sb);
    const moved = join(sb.root, 'pkg2', 'bin');
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, 'mwf.js'), '');
    const r = await installed(sb, { mwfJs: join(moved, 'mwf.js') });
    assert.equal(r.mcp?.status, 'updated');
    assert.deepEqual(claudeJson(sb).mcpServers.mwf.args, [join(moved, 'mwf.js'), 'mcp']);
    assert.deepEqual(settings(sb).hooks.Stop[0].hooks[0].args[0], join(moved, 'mwf.js'));
    assert.equal(settings(sb).hooks.Stop.length, 1);
    assert.equal(backups(sb.home, '.claude.json').length, 1);
  });

  it('never runs claude through a shell: a hostile path is one argument and executes nothing', async () => {
    const sb = claudeSandbox();
    const evil = join(sb.root, 'a b; touch PWNED $(touch PWNED2) `touch PWNED3`', 'bin');
    mkdirSync(evil, { recursive: true });
    const mwfJs = join(evil, 'mwf.js');
    writeFileSync(mwfJs, '');
    await installed(sb, { mwfJs });
    assert.equal(adds(sb)[0]![adds(sb)[0]!.length - 2], mwfJs);
    for (const f of ['PWNED', 'PWNED2', 'PWNED3']) {
      assert.equal(existsSync(join(sb.root, f)), false);
      assert.equal(existsSync(join(process.cwd(), f)), false);
    }
    assert.equal(
      settings(sb).hooks.Stop[0].hooks[0].args[0],
      mwfJs,
      'exec form: no quoting at all',
    );
  });

  it('--dry-run writes nothing and runs no claude command that changes anything', async () => {
    const sb = claudeSandbox();
    const before = tree(sb.root);
    const r = await installClaude(envOf(sb), DRY);
    assert.equal(r.status, 'done');
    assert.equal(r.mcp?.status, 'planned');
    assert.deepEqual(tree(sb.root), before);
    assert.deepEqual(sb.calls(), [['--version']]);
    assert.equal(existsSync(sb.claudeDir), false);
  });

  it('keeps the skills alone that the user edited or wrote, unless --force-skills (backup first)', async () => {
    const sb = claudeSandbox();
    mkdirSync(join(sb.claudeDir, 'skills', 'mwf'), { recursive: true });
    writeFileSync(skillPath(sb, 'mwf'), 'my own skill\n');
    const r = await installClaude(envOf(sb), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.skills.find((s) => s.name === 'mwf')?.status, 'refused');
    assert.equal(readFileSync(skillPath(sb, 'mwf'), 'utf8'), 'my own skill\n');
    const f = await installClaude(envOf(sb), { dryRun: false, forceSkills: true });
    assert.equal(f.status, 'done');
    assert.equal(classify(readFileSync(skillPath(sb, 'mwf'), 'utf8')).kind, 'intact');
    const bk = backups(join(sb.claudeDir, 'skills'), 'mwf.SKILL.md');
    assert.equal(bk.length, 1);
    assert.equal(readFileSync(join(sb.claudeDir, 'skills', bk[0]!), 'utf8'), 'my own skill\n');
    assert.equal(mode(join(sb.claudeDir, 'skills', bk[0]!)), 0o600);
  });
});

describe('claude install: CLAUDE_CONFIG_DIR and the file the CLI writes (Aegis 1, 2)', () => {
  it('without CLAUDE_CONFIG_DIR everything is under ~/.claude and the CLI writes ~/.claude.json (beside it)', async () => {
    const sb = claudeSandbox(false);
    await installed(sb);
    assert.ok(existsSync(join(sb.home, '.claude', 'settings.json')));
    assert.ok(existsSync(join(sb.home, '.claude', 'skills', 'mwf', 'SKILL.md')));
    assert.ok(existsSync(join(sb.home, '.claude.json')));
    assert.equal(existsSync(join(sb.home, '.claude', '.claude.json')), false);
    assert.equal(claudeJsonPath(envOf(sb)), join(sb.home, '.claude.json'));
  });

  it('with CLAUDE_CONFIG_DIR set, everything goes there, including .claude.json; ~/.claude and ~/.claude.json stay untouched', async () => {
    const sb = claudeSandbox(true);
    const r = await installed(sb);
    assert.ok(existsSync(join(sb.root, 'cfg', 'settings.json')));
    assert.ok(existsSync(join(sb.root, 'cfg', 'skills', 'mwf', 'SKILL.md')));
    assert.ok(existsSync(join(sb.root, 'cfg', '.claude.json')));
    assert.equal(existsSync(join(sb.home, '.claude')), false);
    assert.equal(existsSync(join(sb.home, '.claude.json')), false);
    assert.equal(claudeJsonPath(envOf(sb)), join(sb.root, 'cfg', '.claude.json'));
    assert.match(r.warnings.join('\n'), /#48448/);
    assert.match(r.warnings.join('\n'), /CLAUDE_CONFIG_DIR/);
  });

  it('claude is run with the CLAUDE_CONFIG_DIR the user has (and none when they have none), whatever else is in the environment', async () => {
    const plain = claudeSandbox(false);
    // a stray CLAUDE_CONFIG_DIR in the base environment must not redirect the CLI when we computed ~/.claude
    await installClaude(
      envOf(plain, {}, { CLAUDE_CONFIG_DIR: join(plain.root, 'elsewhere') }),
      REAL,
    );
    assert.equal(existsSync(join(plain.root, 'elsewhere')), false);
    assert.ok(existsSync(plain.claudeJson));
  });

  it('A1 backs up exactly the file the CLI writes (default: ~/.claude.json), as 0600, with its exact content', async () => {
    const sb = claudeSandbox(false);
    const text = JSON.stringify(SECRET_JSON, null, 2);
    writeFileSync(sb.claudeJson, text, { mode: 0o600 });
    const r = await installed(sb);
    const bk = backups(sb.home, '.claude.json');
    assert.equal(bk.length, 1);
    assert.equal(readFileSync(join(sb.home, bk[0]!), 'utf8'), text);
    assert.equal(mode(join(sb.home, bk[0]!)), 0o600);
    assert.equal(r.mcp?.backup, join(sb.home, bk[0]!));
    // the other settings in it are exactly as they were; only mcpServers.mwf is new
    const now = claudeJson(sb);
    assert.deepEqual(
      { ...now, mcpServers: { other: now.mcpServers.other } },
      SECRET_JSON,
      'nothing but the mwf entry changed',
    );
    assert.deepEqual(backups(sb.claudeDir, '.claude.json'), []);
  });

  it('A1 with CLAUDE_CONFIG_DIR: the backup is of $CLAUDE_CONFIG_DIR/.claude.json, beside it; ~/.claude.json is not touched', async () => {
    const sb = claudeSandbox(true);
    mkdirSync(sb.claudeDir, { recursive: true });
    const text = JSON.stringify(SECRET_JSON);
    writeFileSync(sb.claudeJson, text, { mode: 0o600 });
    await installed(sb);
    const bk = backups(sb.claudeDir, '.claude.json');
    assert.equal(bk.length, 1);
    assert.equal(readFileSync(join(sb.claudeDir, bk[0]!), 'utf8'), text);
    assert.equal(mode(join(sb.claudeDir, bk[0]!)), 0o600);
    assert.equal(existsSync(join(sb.home, '.claude.json')), false);
    assert.deepEqual(backups(sb.home, '.claude.json'), []);
  });

  it('backups are 0600 whatever the umask (A2)', async () => {
    const sb = claudeSandbox(false);
    writeFileSync(sb.claudeJson, JSON.stringify(SECRET_JSON), { mode: 0o644 });
    mkdirSync(sb.claudeDir, { recursive: true });
    writeFileSync(settingsFile(sb), '{"model":"x"}', { mode: 0o644 });
    const old = process.umask(0);
    try {
      await installed(sb);
    } finally {
      process.umask(old);
    }
    for (const [dir, prefix] of [
      [sb.home, '.claude.json'],
      [sb.claudeDir, 'settings.json'],
    ] as const) {
      const bk = backups(dir, prefix);
      assert.equal(bk.length, 1, prefix);
      assert.equal(mode(join(dir, bk[0]!)), 0o600, prefix);
    }
  });

  it('A1: a change to anything but the mwf entry is reported (CONFIG_CHANGED_UNEXPECTEDLY), not reverted, with the backup path', async () => {
    for (const m of ['clobber', 'delete']) {
      const sb = claudeSandbox(false);
      writeFileSync(sb.claudeJson, JSON.stringify(SECRET_JSON), { mode: 0o600 });
      const r = await installClaude(envOf(sb, {}, { FAKE_CLAUDE_MODE: m }), REAL);
      assert.equal(r.status, 'failed', m);
      assert.equal(r.code, 'CONFIG_CHANGED_UNEXPECTEDLY', m);
      assert.equal(r.mcp?.status, 'unexpected_change', m);
      const bk = backups(sb.home, '.claude.json');
      assert.equal(bk.length, 1, m);
      assert.match(r.mcp?.detail ?? '', new RegExp(bk[0]!.replace(/\./g, '\\.')));
      assert.match(r.mcp?.detail ?? '', /NOT reverted/);
      assert.deepEqual(JSON.parse(readFileSync(join(sb.home, bk[0]!), 'utf8')), SECRET_JSON);
      // not reverted: the file is as the CLI left it
      assert.notDeepEqual(
        { ...claudeJson(sb), mcpServers: SECRET_JSON.mcpServers },
        SECRET_JSON,
        m,
      );
      assert.ok(claudeJson(sb).mcpServers.mwf, m);
      // hooks and skills (earlier steps) are done and reported
      assert.equal(r.hooks?.status, 'created');
    }
  });

  it('a settings.json that claude mcp add rewrote (an unrelated key) is reported as CONFIG_CHANGED_UNEXPECTEDLY via the settings guard, with the close-sessions hint', async () => {
    for (const customDir of [false, true]) {
      const sb = claudeSandbox(customDir);
      mkdirSync(sb.claudeDir, { recursive: true });
      writeFileSync(settingsFile(sb), '{"model":"mine","env":{"A":"1"}}\n');
      const r = await installClaude(envOf(sb, {}, { FAKE_CLAUDE_MODE: 'settings' }), REAL);
      assert.equal(r.status, 'failed');
      assert.equal(r.code, 'CONFIG_CHANGED_UNEXPECTEDLY');
      assert.equal(r.mcp?.status, 'unexpected_change');
      assert.match(r.mcp?.detail ?? '', /settings\.json changed in a way other than the mwf hooks/);
      assert.match(r.mcp?.detail ?? '', /NOT reverted/);
      assert.match(r.mcp?.detail ?? '', CLOSE_HINT);
      // the .claude.json part was fine and the backup named is the settings.json one made before our write
      const bk = backups(sb.claudeDir, 'settings.json');
      assert.equal(bk.length, 1);
      assert.match(r.mcp?.detail ?? '', new RegExp(bk[0]!.replace(/\./g, '\\.')));
      assert.equal(settings(sb).model, 'tampered-by-claude', 'not reverted');
    }
  });

  it('a settings.json that claude left unparseable is reported the same way', async () => {
    const sb = claudeSandbox(false);
    const r = await installClaude(envOf(sb, {}, { FAKE_CLAUDE_MODE: 'settingsbreak' }), REAL);
    assert.equal(r.status, 'failed');
    assert.equal(r.code, 'CONFIG_CHANGED_UNEXPECTEDLY');
    assert.match(r.mcp?.detail ?? '', /settings\.json can no longer be read as strict JSON/);
    assert.match(r.mcp?.detail ?? '', CLOSE_HINT);
  });

  it('the close-sessions hint is in the message of a .claude.json change too', async () => {
    const sb = claudeSandbox(false);
    const r = await installClaude(envOf(sb, {}, { FAKE_CLAUDE_MODE: 'clobber' }), REAL);
    assert.equal(r.code, 'CONFIG_CHANGED_UNEXPECTEDLY');
    assert.match(r.mcp?.detail ?? '', CLOSE_HINT);
    assert.match(r.mcp?.detail ?? '', /Close every running Claude Code session first/);
  });

  it('A1: a .claude.json that no longer parses after the CLI ran is reported as unexpected', async () => {
    const sb = claudeSandbox(false);
    const r = await installClaude(envOf(sb, {}, { FAKE_CLAUDE_MODE: 'breakjson' }), REAL);
    assert.equal(r.code, 'CONFIG_CHANGED_UNEXPECTEDLY');
    assert.equal(r.status, 'failed');
  });

  it('A1: an unparseable .claude.json is never handed to claude: refused, claude not run, prints the manual command', async () => {
    const sb = claudeSandbox(false);
    writeFileSync(sb.claudeJson, '{ "a": 1, // comment\n}', { mode: 0o600 });
    const r = await installClaude(envOf(sb), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.mcp?.status, 'refused');
    assert.match(r.mcp?.manual ?? '', /^claude mcp add --transport stdio --scope user mwf -- /);
    assert.deepEqual(adds(sb), []);
    assert.equal(readFileSync(sb.claudeJson, 'utf8'), '{ "a": 1, // comment\n}');
    assert.deepEqual(backups(sb.home, '.claude.json'), []);
  });

  it('a failing `claude mcp add` is reported with the manual command; hooks and skills stay installed', async () => {
    const sb = claudeSandbox(false);
    writeFileSync(sb.claudeJson, JSON.stringify(SECRET_JSON), { mode: 0o600 });
    const r = await installClaude(envOf(sb, {}, { FAKE_CLAUDE_MODE: 'fail' }), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.mcp?.status, 'failed');
    assert.match(r.mcp?.manual ?? '', /claude mcp add/);
    assert.equal(r.hooks?.status, 'created');
    assert.deepEqual(JSON.parse(readFileSync(sb.claudeJson, 'utf8')), SECRET_JSON);
  });

  it('a user-scope server called mwf that is not ours is never overwritten', async () => {
    const sb = claudeSandbox(false);
    writeFileSync(
      sb.claudeJson,
      JSON.stringify({ mcpServers: { mwf: { type: 'stdio', command: 'someone-else', args: [] } } }),
    );
    const r = await installClaude(envOf(sb), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.mcp?.status, 'refused');
    assert.deepEqual(adds(sb), []);
    assert.equal(claudeJson(sb).mcpServers.mwf.command, 'someone-else');
  });

  it('verifyClaudeJsonChange accepts only the mwf entry changing', () => {
    const want = { command: '/n', args: ['/p/mwf.js', 'mcp'] };
    const base = { a: 1, projects: { x: {} } };
    const ok = {
      ...base,
      mcpServers: { mwf: { type: 'stdio', command: '/n', args: ['/p/mwf.js', 'mcp'] } },
    };
    assert.equal(verifyClaudeJsonChange(base, ok, want), undefined);
    assert.equal(verifyClaudeJsonChange(ok, base, null), undefined);
    assert.equal(verifyClaudeJsonChange(ok, { ...base, mcpServers: {} }, null), undefined);
    assert.match(
      verifyClaudeJsonChange(base, { ...ok, a: 2 }, want) ?? '',
      /other than the mwf entry/,
    );
    assert.match(verifyClaudeJsonChange(base, { ...ok, projects: {} }, want) ?? '', /other than/);
    assert.match(verifyClaudeJsonChange(base, base, want) ?? '', /not what was asked/);
    assert.match(
      verifyClaudeJsonChange(
        base,
        { ...ok, mcpServers: { mwf: { command: '/evil', args: ['/p/mwf.js', 'mcp'] } } },
        want,
      ) ?? '',
      /not what was asked/,
    );
    assert.match(verifyClaudeJsonChange(ok, ok, null) ?? '', /still in/);
    // a project-local entry is not the user-scope entry
    const local = {
      ...base,
      projects: { x: { mcpServers: { mwf: { command: '/n', args: ['/p/mwf.js', 'mcp'] } } } },
    };
    assert.match(
      verifyClaudeJsonChange(base, local, want) ?? '',
      /other than the mwf entry|not what was asked/,
    );
  });
});

describe('claude install: hook identity (Aegis 3)', () => {
  const good = (extra: object = {}): object => ({
    type: 'command',
    command: '/usr/bin/node',
    args: ['/opt/pkg/bin/mwf.js', 'hook', 'stop', '--host', 'claude'],
    ...extra,
  });

  it('--host claude in args is a hard condition: lookalikes are not ours', () => {
    assert.equal(claudeIsOurs(good()), true);
    assert.equal(claudeIsOurs(good({ timeout: 9, statusMessage: 'other' })), true);
    const lookalikes: unknown[] = [
      // Codex's shell form, in the same file
      { type: 'command', command: "'/usr/bin/node' '/opt/pkg/bin/mwf.js' hook stop" },
      { type: 'command', command: "'/usr/bin/node' '/opt/pkg/bin/mwf.js' hook stop --host claude" },
      // exec form without or with another host
      good({ args: ['/opt/pkg/bin/mwf.js', 'hook', 'stop'] }),
      good({ args: ['/opt/pkg/bin/mwf.js', 'hook', 'stop', '--host', 'codex'] }),
      good({ args: ['/opt/pkg/bin/mwf.js', 'hook', 'stop', '--host'] }),
      good({ args: ['/opt/pkg/bin/mwf.js', 'hook', 'stop', '--host', 'claude', '--extra'] }),
      good({
        args: ['/opt/pkg/bin/mwf.js', 'hook', 'stop', '--stop-style', 'block', '--host', 'claude'],
      }),
      good({ args: ['/opt/pkg/bin/other.js', 'hook', 'stop', '--host', 'claude'] }),
      good({ args: ['/opt/pkg/bin/mwf.js', 'hook', 'compact', '--host', 'claude'] }),
      good({ args: ['/opt/pkg/bin/mwf.js', 'hook', 'stop', '--host', 7] }),
      good({ args: 'x' }),
      good({ type: 'prompt' }),
      good({ command: 7 }),
      null,
      'x',
    ];
    for (const h of lookalikes) assert.equal(claudeIsOurs(h), false, JSON.stringify(h));
  });

  it('install and uninstall leave Codex-form and host-less lookalikes alone, and still add and remove ours', async () => {
    const sb = claudeSandbox();
    mkdirSync(sb.claudeDir, { recursive: true });
    const theirs = [
      { type: 'command', command: `'${process.execPath}' '${sb.mwfJs}' hook stop`, timeout: 5 },
      { type: 'command', command: process.execPath, args: [sb.mwfJs, 'hook', 'stop'] },
      {
        type: 'command',
        command: process.execPath,
        args: [sb.mwfJs, 'hook', 'stop', '--host', 'codex'],
      },
    ];
    const doc = { hooks: { Stop: [{ hooks: theirs }] } };
    writeFileSync(settingsFile(sb), JSON.stringify(doc, null, 2));
    await installed(sb);
    const stop = settings(sb).hooks.Stop;
    assert.deepEqual(stop[0].hooks, theirs, 'untouched');
    assert.equal(stop.length, 2);
    assert.equal(claudeIsOurs(stop[1].hooks[0]), true);
    const u = await uninstallClaude(envOf(sb), REAL);
    assert.equal(u.status, 'done');
    assert.deepEqual(settings(sb), doc);
  });
});

describe('claude install: settings.json guard (Aegis 4)', () => {
  const RICH = {
    $schema: 'https://example.invalid/schema.json',
    model: 'x',
    permissions: { deny: ['Read(./secrets/**)'], defaultMode: 'default', unknown: { n: 1.5 } },
    env: { A: '1' },
    statusLine: { type: 'command', command: 'echo hi' },
    enabledPlugins: { 'p@m': true },
    futureKey: [1, { two: 2 }, null],
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'mine.sh', timeout: 3 }] }],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'hello.sh' }] }],
      SomeFutureEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
    },
  };

  it('keeps every other key (permissions, env, unknown top-level keys) and never writes permissions.allow', async () => {
    const sb = claudeSandbox();
    mkdirSync(sb.claudeDir, { recursive: true });
    writeFileSync(settingsFile(sb), JSON.stringify(RICH, null, 2) + '\n');
    await installed(sb);
    const now = settings(sb);
    assert.deepEqual(now.permissions, RICH.permissions);
    assert.equal(now.permissions.allow, undefined);
    assert.deepEqual(withoutOurs(now), RICH, 'deep-equal once mwf is taken out');
    for (const k of Object.keys(RICH).filter((k) => k !== 'hooks'))
      assert.deepEqual(now[k], (RICH as any)[k], k);
    assert.deepEqual(now.hooks.PreToolUse, RICH.hooks.PreToolUse);
    assert.deepEqual(now.hooks.SomeFutureEvent, RICH.hooks.SomeFutureEvent);
    assert.deepEqual(now.hooks.Stop[0], RICH.hooks.Stop[0]);
    assert.equal(backups(sb.claudeDir, 'settings.json').length, 1);
  });

  it('install then uninstall gives back the original settings (content), and keeps settings.json', async () => {
    const sb = claudeSandbox();
    mkdirSync(sb.claudeDir, { recursive: true });
    writeFileSync(settingsFile(sb), JSON.stringify(RICH, null, 2) + '\n');
    await installed(sb);
    const u = await uninstallClaude(envOf(sb), REAL);
    assert.equal(u.status, 'done');
    assert.deepEqual(settings(sb), RICH);
  });

  it('D10: when nothing but mwf was in settings.json, uninstall leaves the file, with an empty object', async () => {
    const sb = claudeSandbox();
    await installed(sb);
    assert.ok(existsSync(settingsFile(sb)));
    const u = await uninstallClaude(envOf(sb), REAL);
    assert.equal(u.status, 'done');
    assert.equal(u.hooks?.status, 'updated');
    assert.deepEqual(settings(sb), {});
    assert.equal(backups(sb.claudeDir, 'settings.json').length, 1, 'the previous file is kept');
    assert.equal(existsSync(skillPath(sb, 'mwf')), false);
    assert.equal(existsSync(join(sb.claudeDir, 'skills', 'mwf')), false);
    assert.deepEqual(claudeJson(sb).mcpServers ?? {}, {});
  });

  it('refuses settings.json that is not strict JSON, naming the line, and writes NOTHING (skills included)', async () => {
    for (const text of [
      '{\n  // comment\n  "a": 1\n}',
      '{ "a": 1, }',
      '\ufeff{"a":1}',
      '{ "a": 1, "a": 2 }',
      '[1]',
      '{ "hooks": [] }',
      '{ "hooks": { "Stop": {} } }',
    ]) {
      const sb = claudeSandbox();
      mkdirSync(sb.claudeDir, { recursive: true });
      writeFileSync(settingsFile(sb), text);
      const before = tree(sb.root);
      const r = await installClaude(envOf(sb), REAL);
      assert.equal(r.status, 'refused', text);
      assert.equal(r.code, 'SETTINGS_JSON_REFUSED', text);
      assert.deepEqual(tree(sb.root), before, text);
      assert.deepEqual(adds(sb), [], text);
    }
  });

  it('the difference guard trips when an edit would change anything but our handlers', () => {
    const before = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] }, a: 1 };
    assert.doesNotThrow(() => checkOnlyOursChanged(before, before, CLAUDE_FLAVOR));
    const withOurs = {
      ...before,
      hooks: {
        Stop: [...before.hooks.Stop, { hooks: [good()] }],
      },
    };
    function good() {
      return {
        type: 'command',
        command: 'n',
        args: ['/p/mwf.js', 'hook', 'stop', '--host', 'claude'],
      };
    }
    assert.doesNotThrow(() => checkOnlyOursChanged(before, withOurs, CLAUDE_FLAVOR));
    for (const bad of [
      { ...withOurs, a: 2 },
      { ...withOurs, permissions: { allow: ['Bash'] } },
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'changed' }, good()] }] }, a: 1 },
    ])
      assert.throws(() => checkOnlyOursChanged(before, bad, CLAUDE_FLAVOR), HooksDocError);
  });

  it('warns (and changes nothing) when settings.json has "disableAllHooks": true', async () => {
    const sb = claudeSandbox();
    mkdirSync(sb.claudeDir, { recursive: true });
    writeFileSync(settingsFile(sb), '{"disableAllHooks": true}');
    const r = await installed(sb);
    assert.match(r.warnings.join('\n'), /disableAllHooks/);
    assert.equal(settings(sb).disableAllHooks, true);
  });

  it('a symlinked settings.json (dotfiles manager) stays a link; the real file changes and the backup is beside it', async () => {
    const sb = claudeSandbox();
    mkdirSync(sb.claudeDir, { recursive: true });
    const dots = join(sb.root, 'dotfiles');
    mkdirSync(dots);
    writeFileSync(join(dots, 'settings.json'), '{"model":"x"}\n', { mode: 0o600 });
    symlinkSync(join(dots, 'settings.json'), settingsFile(sb));
    await installed(sb);
    assert.ok(lstatSync(settingsFile(sb)).isSymbolicLink());
    assert.equal(JSON.parse(readFileSync(join(dots, 'settings.json'), 'utf8')).model, 'x');
    assert.ok(JSON.parse(readFileSync(join(dots, 'settings.json'), 'utf8')).hooks.Stop);
    assert.equal(backups(dots, 'settings.json').length, 1);
    assert.deepEqual(backups(sb.claudeDir, 'settings.json'), []);
    const u = await uninstallClaude(envOf(sb), REAL);
    assert.equal(u.status, 'done');
    assert.ok(lstatSync(settingsFile(sb)).isSymbolicLink());
    assert.deepEqual(JSON.parse(readFileSync(join(dots, 'settings.json'), 'utf8')), { model: 'x' });
  });

  it('a settings.json changed by someone else during the install is not overwritten (CONCURRENT_MODIFICATION)', async () => {
    const sb = claudeSandbox();
    mkdirSync(sb.claudeDir, { recursive: true });
    writeFileSync(settingsFile(sb), '{"model":"x"}');
    const r = await installClaude(
      envOf(sb, {
        beforeRename: () => {
          const tmp = settingsFile(sb) + '.other';
          writeFileSync(tmp, '{"model":"theirs"}');
          renameSync(tmp, settingsFile(sb));
        },
      }),
      REAL,
    );
    assert.equal(r.status, 'failed');
    assert.equal(r.code, 'CONCURRENT_MODIFICATION');
    assert.equal(readFileSync(settingsFile(sb), 'utf8'), '{"model":"theirs"}');
  });
});

describe('claude install: A5 version gate (Aegis 5)', () => {
  async function refusedWith(
    sb: ClaudeSandbox,
    vars: NodeJS.ProcessEnv,
    code: string,
    extra: Partial<ClaudeEnv> = {},
  ): Promise<Report> {
    const before = tree(sb.root);
    const r = await installClaude(envOf(sb, extra, vars), REAL);
    assert.equal(r.status, 'refused', JSON.stringify(vars));
    assert.equal(r.code, code, JSON.stringify(vars));
    assert.deepEqual(tree(sb.root), before, 'nothing was written');
    assert.equal(existsSync(sb.claudeDir), false);
    assert.equal(existsSync(sb.claudeJson), false);
    assert.deepEqual(
      sb.calls().filter((c) => c[0] !== '--version'),
      [],
      'no command other than --version was run',
    );
    return r;
  }

  it('no output at all', async () => {
    await refusedWith(claudeSandbox(), { FAKE_CLAUDE_VERSION: '' }, 'CLAUDE_VERSION_UNKNOWN');
  });
  it('garbled output', async () => {
    for (const v of [
      'garbage',
      'Segmentation fault',
      'claude 2.1.314',
      '2.1.314',
      '2.1 (Claude Code)',
      'codex-cli 2.1.314',
      '2.1.314 (Other Tool)',
      'v2.x.314 (Claude Code)',
    ])
      await refusedWith(claudeSandbox(), { FAKE_CLAUDE_VERSION: v }, 'CLAUDE_VERSION_UNKNOWN');
  });
  it('a failing `claude --version` (non-zero exit, even with a good-looking line) and a missing claude', async () => {
    await refusedWith(claudeSandbox(), { FAKE_CLAUDE_EXIT: '3' }, 'CLAUDE_VERSION_UNKNOWN');
    const sb = claudeSandbox();
    await refusedWith(sb, {}, 'CLAUDE_VERSION_UNKNOWN', {
      claudeBin: join(sb.root, 'no-such-claude'),
    });
  });
  it('too old (below 2.1.314)', async () => {
    for (const v of ['2.1.313', '2.0.999', '1.9.9', '0.0.1'])
      await refusedWith(
        claudeSandbox(),
        { FAKE_CLAUDE_VERSION: `${v} (Claude Code)` },
        'CLAUDE_TOO_OLD',
      );
  });
  it('accepts 2.1.314 and newer', async () => {
    for (const v of ['2.1.314', '2.1.315', '2.2.0', '3.0.0', '2.1.400-beta.1']) {
      const sb = claudeSandbox();
      const r = await installClaude(
        envOf(sb, {}, { FAKE_CLAUDE_VERSION: `${v} (Claude Code)` }),
        REAL,
      );
      assert.equal(r.status, 'done', v);
    }
  });
  it('parseClaudeVersion', () => {
    assert.deepEqual(parseClaudeVersion('2.1.314 (Claude Code)\n'), [2, 1, 314]);
    assert.deepEqual(parseClaudeVersion('v2.1.314 (Claude Code)'), [2, 1, 314]);
    assert.equal(parseClaudeVersion(''), null);
    assert.equal(parseClaudeVersion('2.1.314'), null);
  });
});

describe('claude uninstall', () => {
  it('removes our hooks, skills and MCP entry, keeping everything else and every backup', async () => {
    const sb = claudeSandbox();
    mkdirSync(sb.claudeDir, { recursive: true });
    writeFileSync(settingsFile(sb), JSON.stringify({ model: 'x' }));
    writeFileSync(sb.claudeJson, JSON.stringify(SECRET_JSON), { mode: 0o600 });
    await installed(sb);
    const u = await uninstallClaude(envOf(sb), REAL);
    assert.equal(u.status, 'done');
    assert.deepEqual(settings(sb), { model: 'x' });
    assert.deepEqual(claudeJson(sb), SECRET_JSON);
    for (const s of SKILLS) assert.equal(existsSync(skillPath(sb, s.name)), false);
    assert.ok(backups(sb.claudeDir, 'settings.json').length >= 1);
    assert.ok(backups(sb.home, '.claude.json').length >= 2);
    assert.match(u.notes.join('\n'), /never deleted/);
  });

  it('keeps edited skills (hash mismatch) and removes them only with --force-skills, after a backup', async () => {
    const sb = claudeSandbox();
    await installed(sb);
    writeFileSync(
      skillPath(sb, 'mwf-save'),
      readFileSync(skillPath(sb, 'mwf-save'), 'utf8') + '\nmine\n',
    );
    const u = await uninstallClaude(envOf(sb), REAL);
    assert.equal(u.status, 'done');
    assert.equal(u.skills.find((s) => s.name === 'mwf-save')?.status, 'kept');
    assert.ok(existsSync(skillPath(sb, 'mwf-save')));
    const f = await uninstallClaude(envOf(sb), { dryRun: false, forceSkills: true });
    assert.equal(existsSync(skillPath(sb, 'mwf-save')), false);
    assert.equal(backups(join(sb.claudeDir, 'skills'), 'mwf-save.SKILL.md').length, 1);
    assert.equal(f.status, 'done');
  });

  it('works without any version check (an old or missing claude), reporting the manual MCP command', async () => {
    const sb = claudeSandbox();
    await installed(sb);
    const r = await uninstallClaude(
      envOf(sb, { claudeBin: join(sb.root, 'no-such-claude') }),
      REAL,
    );
    assert.equal(r.status, 'partial');
    assert.equal(r.mcp?.status, 'failed');
    assert.equal(r.mcp?.manual, 'claude mcp remove mwf --scope user');
    assert.equal(settings(sb).hooks, undefined);
    assert.equal(existsSync(skillPath(sb, 'mwf')), false);
    assert.ok(claudeJson(sb).mcpServers.mwf, 'left for the user to remove');
  });

  it('leaves a server called mwf that is not ours, and an unparseable .claude.json, alone', async () => {
    const sb = claudeSandbox();
    writeFileSync(sb.claudeJson, JSON.stringify({ mcpServers: { mwf: { command: 'else' } } }));
    const r = await uninstallClaude(envOf(sb), REAL);
    assert.equal(r.mcp?.status, 'refused');
    assert.equal(claudeJson(sb).mcpServers.mwf.command, 'else');
    const sb2 = claudeSandbox();
    writeFileSync(sb2.claudeJson, '{ nope');
    const r2 = await uninstallClaude(envOf(sb2), REAL);
    assert.equal(r2.mcp?.status, 'manual');
    assert.deepEqual(sb2.calls(), []);
    assert.equal(readFileSync(sb2.claudeJson, 'utf8'), '{ nope');
  });

  it('--dry-run writes nothing and runs no claude command', async () => {
    const sb = claudeSandbox();
    await installed(sb);
    const before = tree(sb.root);
    const n = sb.calls().length;
    const r = await uninstallClaude(envOf(sb), DRY);
    assert.equal(r.status, 'done');
    assert.equal(r.mcp?.status, 'planned');
    assert.deepEqual(tree(sb.root), before);
    assert.equal(sb.calls().length, n);
  });

  it('an uninstall that changes nothing else in .claude.json passes A1; one that does is reported', async () => {
    const sb = claudeSandbox();
    writeFileSync(sb.claudeJson, JSON.stringify(SECRET_JSON), { mode: 0o600 });
    await installed(sb);
    const r = await uninstallClaude(envOf(sb, {}, { FAKE_CLAUDE_MODE: 'clobber' }), REAL);
    assert.equal(r.status, 'failed');
    assert.equal(r.code, 'CONFIG_CHANGED_UNEXPECTEDLY');
  });
});

describe('claude uninstall: settings.json guard and the close-sessions hint', () => {
  it('a settings.json that claude mcp remove rewrote (an unrelated key) is reported as CONFIG_CHANGED_UNEXPECTEDLY, with the hint', async () => {
    const sb = claudeSandbox();
    await installed(sb);
    const r = await uninstallClaude(envOf(sb, {}, { FAKE_CLAUDE_MODE: 'settings' }), REAL);
    assert.equal(r.status, 'failed');
    assert.equal(r.code, 'CONFIG_CHANGED_UNEXPECTEDLY');
    assert.equal(r.mcp?.status, 'unexpected_change');
    assert.match(r.mcp?.detail ?? '', /settings\.json changed in a way other than the mwf hooks/);
    assert.match(r.mcp?.detail ?? '', CLOSE_HINT);
    assert.equal(settings(sb).model, 'tampered-by-claude', 'not reverted');
  });

  it('a .claude.json change during uninstall carries the hint too', async () => {
    const sb = claudeSandbox();
    await installed(sb);
    const r = await uninstallClaude(envOf(sb, {}, { FAKE_CLAUDE_MODE: 'clobber' }), REAL);
    assert.equal(r.code, 'CONFIG_CHANGED_UNEXPECTEDLY');
    assert.match(r.mcp?.detail ?? '', CLOSE_HINT);
  });

  it('--dry-run never runs the settings check (nothing ran)', async () => {
    const sb = claudeSandbox();
    await installed(sb);
    const r = await uninstallClaude(envOf(sb, {}, { FAKE_CLAUDE_MODE: 'settings' }), DRY);
    assert.equal(r.status, 'done');
  });
});

describe('mwf install / uninstall --harness claude on the command line', () => {
  const TTY = { stdin: true, stdout: true };
  async function run(
    sb: ClaudeSandbox,
    argv: string[],
    extra: Partial<LifecycleIo> = {},
  ): Promise<{ code: number; out: string; err: string }> {
    const res = { out: '', err: '' };
    const code = await lifecycleMain(argv, {
      stdout: (t) => (res.out += t),
      stderr: (t) => (res.err += t),
      entry: sb.mwfJs,
      env: sb.env,
      home: sb.home,
      claudeBin: sb.claude,
      ...extra,
    });
    return { code, ...res };
  }

  it('a real run needs a terminal on both stdin and stdout, with no bypass; claude is not even asked for its version', async () => {
    for (const tty of [
      undefined,
      { stdin: false, stdout: false },
      { stdin: true, stdout: false },
      { stdin: false, stdout: true },
    ]) {
      for (const cmd of ['install', 'uninstall']) {
        const sb = claudeSandbox();
        const r = await run(sb, [cmd, '--harness', 'claude'], tty ? { tty } : {});
        assert.equal(r.code, 1);
        assert.match(r.err, /CONFIRM_REQUIRES_TTY/);
        assert.deepEqual(readdirSync(sb.home), []);
        assert.deepEqual(sb.calls(), []);
      }
    }
    const sb = claudeSandbox();
    const env = { ...sb.env, MWF_ASSUME_TTY: '1', MWF_YES: '1', CI: '1', TTY: '1' };
    for (const flag of ['--yes', '--force', '--tty', '--confirm'])
      assert.equal(
        (await run(sb, ['install', '--harness', 'claude', flag], { env })).code,
        2,
        flag,
      );
    assert.match(
      (await run(sb, ['install', '--harness', 'claude'], { env })).err,
      /CONFIRM_REQUIRES_TTY/,
    );
    assert.deepEqual(readdirSync(sb.home), []);
  });

  it('--dry-run works without a terminal, reports and changes nothing; --json is structured', async () => {
    const sb = claudeSandbox();
    const r = await run(sb, ['install', '--harness', 'claude', '--dry-run']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /mwf install --harness claude \(dry run: nothing was written\): done/);
    assert.match(r.out, /settings\s+created/);
    assert.match(r.out, /run it yourself: claude mcp add --transport stdio --scope user mwf -- /);
    assert.deepEqual(readdirSync(sb.home), []);
    const j = await run(sb, ['install', '--harness', 'claude', '--dry-run', '--json']);
    assert.equal(JSON.parse(j.out).data.harness, 'claude');
    const t = await run(sb, ['install', '--harness', 'claude', '--json']);
    assert.equal(JSON.parse(t.out).error.code, 'CONFIRM_REQUIRES_TTY');
    assert.equal((await run(sb, ['uninstall', '--harness', 'claude', '--dry-run'])).code, 0);
  });

  it('a real run in a terminal installs, prints a readable summary and uninstalls', async () => {
    const sb = claudeSandbox();
    const r = await run(sb, ['install', '--harness', 'claude'], { tty: TTY });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /mwf install --harness claude: done \(Claude Code 2\.1\.314\)/);
    assert.match(r.out, /workspace trust/);
    assert.ok(existsSync(join(sb.claudeDir, 'settings.json')));
    const again = await run(sb, ['install', '--harness', 'claude', '--json'], { tty: TTY });
    assert.equal(JSON.parse(again.out).data.hooks.status, 'unchanged');
    const u = await run(sb, ['uninstall', '--harness', 'claude'], { tty: TTY });
    assert.equal(u.code, 0, u.err);
    assert.equal(existsSync(join(sb.claudeDir, 'skills', 'mwf')), false);
  });

  it('the text printed for CONFIG_CHANGED_UNEXPECTEDLY (install and uninstall) carries the close-sessions hint', async () => {
    const sb = claudeSandbox();
    const env = { ...sb.env, FAKE_CLAUDE_MODE: 'clobber' };
    const r = await run(sb, ['install', '--harness', 'claude'], { tty: TTY, env });
    assert.equal(r.code, 1);
    assert.match(r.out + r.err, /CONFIG_CHANGED_UNEXPECTEDLY/);
    assert.match(r.out + r.err, CLOSE_HINT);
    const u = await run(sb, ['uninstall', '--harness', 'claude'], {
      tty: TTY,
      env: { ...sb.env, FAKE_CLAUDE_MODE: 'settings' },
    });
    assert.equal(u.code, 1);
    assert.match(u.out + u.err, /CONFIG_CHANGED_UNEXPECTEDLY/);
    assert.match(u.out + u.err, CLOSE_HINT);
  });

  it('CLAUDE_CONFIG_DIR from the environment is honoured; a relative one is refused', async () => {
    const sb = claudeSandbox(true);
    const r = await run(sb, ['install', '--harness', 'claude'], { tty: TTY });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /#48448/);
    assert.ok(existsSync(join(sb.root, 'cfg', 'settings.json')));
    assert.equal(existsSync(join(sb.home, '.claude')), false);
    const bad = await run(sb, ['install', '--harness', 'claude', '--dry-run'], {
      env: { ...sb.env, CLAUDE_CONFIG_DIR: 'relative/dir' },
    });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /INVALID_PATH/);
  });

  it('a refused version gate exits 1 with the reason; a source-tree run is refused', async () => {
    const sb = claudeSandbox();
    const r = await run(sb, ['install', '--harness', 'claude'], {
      tty: TTY,
      claudeBin: join(sb.root, 'missing'),
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /CLAUDE_VERSION_UNKNOWN/);
    assert.match(r.err, /nothing was installed/);
    const s = await run(sb, ['install', '--harness', 'claude'], {
      tty: TTY,
      entry: join(sb.root, 'src', 'bin', 'mwf.ts'),
    });
    assert.match(s.err, /NOT_INSTALLED_BUILD/);
    assert.equal(existsSync(sb.claudeDir), false);
  });

  it('--help covers claude, and says ~/.agents/skills is shared while Claude Code does not use it', async () => {
    const sb = claudeSandbox();
    const out = (await run(sb, ['install', '--help'])).out;
    assert.match(out, /--harness codex\|claude/);
    assert.match(out, /claude: <CLAUDE_CONFIG_DIR or ~\/\.claude>\/settings\.json/);
    assert.match(out, /Needs Claude Code 2\.1\.314 or newer/);
    assert.match(out, /shared agent-skills directory/);
    assert.match(out, /not the shared ~\/\.agents\/skills/);
    assert.match(out, /never writes permissions\.allow/);
    assert.match(out, /not a security boundary/);
  });
});
