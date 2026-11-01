import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execRunner, type Report } from '../src/lifecycle/codex.ts';
import { lifecycleMain, type LifecycleIo } from '../src/lifecycle/main.ts';
import {
  extensionPath,
  installPi,
  mcpState,
  parsePiVersion,
  uninstallPi,
  verifyMcpJsonChange,
  type PiEnv,
} from '../src/lifecycle/pi.ts';
import { classifyExtension } from '../src/lifecycle/pi-extension.ts';
import { classify } from '../src/lifecycle/skills-files.ts';
import { SKILLS } from '../src/skills/index.ts';
import { piSandbox, type PiSandbox } from './helpers/fake-pi.ts';

const REAL = { dryRun: false, forceSkills: false };
const DRY = { dryRun: true, forceSkills: false };
const FORCE = { dryRun: false, forceSkills: true };

function envOf(sb: PiSandbox, extra: Partial<PiEnv> = {}, vars: NodeJS.ProcessEnv = {}): PiEnv {
  return {
    piDir: sb.piDir,
    customDir: sb.customDir,
    home: sb.home,
    node: process.execPath,
    mwfJs: sb.mwfJs,
    piBin: sb.pi,
    version: '1.0.0-test',
    run: execRunner,
    baseEnv: { ...sb.env, ...vars },
    ...extra,
  };
}

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
const mcp = (sb: PiSandbox): any => JSON.parse(readFileSync(sb.mcpJson, 'utf8'));
const skillPath = (sb: PiSandbox, name: string): string =>
  join(sb.piDir, 'skills', name, 'SKILL.md');
const extFile = (sb: PiSandbox): string => extensionPath(envOf(sb));
const adds = (sb: PiSandbox): string[][] => sb.calls().filter((c) => c[1] === 'add');
const mutations = (sb: PiSandbox): string[][] => sb.calls().filter((c) => c[0] === 'mcp');

async function installed(sb: PiSandbox, extra: Partial<PiEnv> = {}): Promise<Report> {
  const r = await installPi(envOf(sb, extra), REAL);
  assert.equal(r.status, 'done', JSON.stringify(r));
  return r;
}

const OTHER = { command: 'other-server', args: ['--x'], exposure: 'direct' };
const writeMcp = (sb: PiSandbox, doc: unknown): void => {
  mkdirSync(sb.piDir, { recursive: true });
  writeFileSync(sb.mcpJson, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2), {
    mode: 0o600,
  });
};

describe('pi version parsing (A5)', () => {
  it('accepts exactly one bare x.y.z line', () => {
    assert.deepEqual(parsePiVersion('1.4.0\n'), [1, 4, 0]);
    assert.deepEqual(parsePiVersion('1.4.0'), [1, 4, 0]);
    assert.deepEqual(parsePiVersion('12.0.31\r\n'), [12, 0, 31]);
  });
  it('rejects any prefix, suffix, extra line or noise', () => {
    for (const bad of [
      '',
      '\n',
      'pi 1.4.0',
      'v1.4.0',
      '1.4.0-rc.1',
      '1.4.0+build',
      '1.4.0 ',
      ' 1.4.0',
      '1.4',
      '1.4.0.1',
      '1.4.0\n1.5.0',
      '1.4.0\n\n',
      'warning\n1.4.0',
      '1.4.0x',
      'x1.4.0',
    ])
      assert.equal(parsePiVersion(bad), null, JSON.stringify(bad));
  });
});

describe('pi install', () => {
  it('writes the extension, the skills (Pi tool names) and registers MCP through pi with direct exposure', async () => {
    const sb = piSandbox();
    const r = await installed(sb);
    assert.equal(r.harness, 'pi');
    assert.equal(r.pi_version, '1.4.0');
    // extension
    const text = readFileSync(extFile(sb), 'utf8');
    assert.equal(classifyExtension(text).kind, 'intact');
    assert.equal(mode(extFile(sb)), 0o644);
    assert.ok(
      text.includes(JSON.stringify(sb.mwfJs)) && text.includes(JSON.stringify(process.execPath)),
    );
    assert.equal(r.hooks?.status, 'created');
    // skills: ~/.pi/agent/skills, rendered for Pi
    assert.equal(r.skills.length, SKILLS.length);
    for (const s of SKILLS) {
      const body = readFileSync(skillPath(sb, s.name), 'utf8');
      assert.equal(classify(body).kind, 'intact', s.name);
      assert.match(body, /mcp__mwf__mwf_/, s.name);
      assert.ok(
        !/(?<!mcp__mwf__)\bmwf_(save|handoff|recall|status|bootstrap)\b/.test(body),
        s.name,
      );
    }
    assert.equal(existsSync(join(sb.home, '.agents')), false, 'the shared ~/.agents is not used');
    assert.equal(
      existsSync(join(sb.piDir, 'settings.json')),
      false,
      'Pi settings.json is not touched',
    );
    // MCP
    assert.deepEqual(mcp(sb).mcpServers.mwf, {
      command: process.execPath,
      args: [sb.mwfJs, 'mcp'],
      exposure: 'direct',
      description: 'mwf: project memory (the mwf_* tools)',
    });
    assert.deepEqual(adds(sb), [
      [
        'mcp',
        'add',
        'mwf',
        '--exposure',
        'direct',
        '--description',
        'mwf: project memory (the mwf_* tools)',
        '--',
        process.execPath,
        sb.mwfJs,
        'mcp',
      ],
    ]);
    assert.equal(r.mcp?.status, 'added');
    assert.match(r.notes.join('\n'), /full permissions/);
    assert.match(r.notes.join('\n'), /\.agents\/skills.*higher priority/);
    assert.match(r.notes.join('\n'), /not a security boundary/);
  });

  it('is idempotent: a second run changes nothing, makes no backup and runs no `mcp add`', async () => {
    const sb = piSandbox();
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

  it('a moved install replaces the stale registration with one `mcp add` (it replaces by name) and a new extension', async () => {
    const sb = piSandbox();
    await installed(sb);
    const moved = join(sb.root, 'pkg2', 'bin');
    mkdirSync(moved, { recursive: true });
    writeFileSync(join(moved, 'mwf.js'), '');
    const r = await installed(sb, { mwfJs: join(moved, 'mwf.js') });
    assert.equal(r.mcp?.status, 'updated');
    assert.equal(r.hooks?.status, 'updated');
    assert.deepEqual(mcp(sb).mcpServers.mwf.args, [join(moved, 'mwf.js'), 'mcp']);
    assert.ok(readFileSync(extFile(sb), 'utf8').includes(JSON.stringify(join(moved, 'mwf.js'))));
    assert.equal(adds(sb).length, 2);
    assert.equal(sb.calls().filter((c) => c[1] === 'remove').length, 0);
    assert.equal(backups(sb.piDir, 'mcp.json').length, 1);
    assert.deepEqual(
      backups(join(sb.piDir, 'extensions'), 'mwf.js'),
      [],
      'our own older file needs no backup',
    );
  });

  it('Aegis 1: an entry of ours with a missing or non-direct exposure is replaced, never treated as current', async () => {
    for (const exposure of [undefined, 'codemode', 'Direct', 'direct ', 7]) {
      const sb = piSandbox();
      writeMcp(sb, {
        keep: 1,
        mcpServers: {
          other: OTHER,
          mwf: {
            command: process.execPath,
            args: [sb.mwfJs, 'mcp'],
            ...(exposure !== undefined ? { exposure } : {}),
          },
        },
      });
      const r = await installed(sb);
      assert.equal(r.mcp?.status, 'updated', String(exposure));
      assert.equal(mcp(sb).mcpServers.mwf.exposure, 'direct');
      assert.deepEqual(mcp(sb).mcpServers.other, OTHER);
      assert.equal(mcp(sb).keep, 1);
      assert.equal(adds(sb).length, 1);
    }
  });

  it('mcpState: ours is exactly stdio + mwf.js + mcp + exposure "direct"', () => {
    const base = { command: 'node', args: ['/a/mwf.js', 'mcp'] };
    assert.equal(mcpState({}).kind, 'absent');
    assert.equal(mcpState({ mcpServers: {} }).kind, 'absent');
    assert.equal(
      mcpState({ mcpServers: { mwf: { ...base, exposure: 'direct' } } }).kind,
      'current',
    );
    assert.equal(mcpState({ mcpServers: { mwf: base } }).kind, 'stale');
    assert.equal(
      mcpState({ mcpServers: { mwf: { ...base, exposure: 'codemode' } } }).kind,
      'stale',
    );
    assert.equal(
      mcpState({
        mcpServers: { mwf: { command: 'node', args: ['/a/x.js', 'mcp'], exposure: 'direct' } },
      }).kind,
      'other',
    );
    assert.equal(
      mcpState({
        mcpServers: { mwf: { ...base, args: ['/a/mwf.js', 'serve'], exposure: 'direct' } },
      }).kind,
      'other',
    );
    assert.equal(
      mcpState({ mcpServers: { mwf: { url: 'https://x', exposure: 'direct' } } }).kind,
      'other',
    );
    assert.equal(mcpState({ mcpServers: { mwf: 'text' } }).kind, 'other');
  });

  it('an MCP server named mwf that is not ours is left alone: no pi command, partial, manual command given', async () => {
    const sb = piSandbox();
    const theirs = { command: 'their-thing', args: ['go'], exposure: 'direct' };
    writeMcp(sb, { mcpServers: { mwf: theirs } });
    const before = readFileSync(sb.mcpJson, 'utf8');
    const r = await installPi(envOf(sb), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.mcp?.status, 'refused');
    assert.match(r.mcp!.manual!, /pi mcp add/);
    assert.equal(readFileSync(sb.mcpJson, 'utf8'), before);
    assert.deepEqual(mutations(sb), []);
    assert.equal(r.hooks?.status, 'created', 'the other parts are still installed');
    assert.deepEqual(backups(sb.piDir, 'mcp.json'), []);
  });

  it('never runs pi through a shell: a hostile path is one argument and executes nothing', async () => {
    const sb = piSandbox();
    const evil = join(sb.root, 'a b; touch PWNED $(touch PWNED2) `touch PWNED3`', 'bin');
    mkdirSync(evil, { recursive: true });
    const mwfJs = join(evil, 'mwf.js');
    writeFileSync(mwfJs, '');
    await installed(sb, { mwfJs });
    assert.equal(adds(sb)[0]![adds(sb)[0]!.length - 2], mwfJs);
    assert.equal(mcp(sb).mcpServers.mwf.args[0], mwfJs);
    for (const f of ['PWNED', 'PWNED2', 'PWNED3']) {
      assert.equal(existsSync(join(sb.root, f)), false);
      assert.equal(existsSync(join(process.cwd(), f)), false);
    }
    assert.ok(readFileSync(extFile(sb), 'utf8').includes(JSON.stringify(mwfJs)));
  });

  it('--dry-run writes nothing and runs no pi command that changes anything', async () => {
    const sb = piSandbox();
    const before = tree(sb.root);
    const r = await installPi(envOf(sb), DRY);
    assert.equal(r.status, 'done');
    assert.equal(r.mcp?.status, 'planned');
    assert.equal(r.hooks?.status, 'created');
    assert.deepEqual(tree(sb.root), before);
    assert.deepEqual(sb.calls(), [['--version']]);
    assert.equal(existsSync(sb.piDir), false);
  });

  it('refuses a Pi that is too old or whose version cannot be read, and changes nothing', async () => {
    for (const [v, code] of [
      ['1.3.9', 'PI_VERSION_TOO_OLD'],
      ['0.73.1', 'PI_VERSION_TOO_OLD'],
      ['1.4.0-rc.1', 'PI_VERSION_UNPARSEABLE'],
      ['pi 1.4.0', 'PI_VERSION_UNPARSEABLE'],
      ['1.4.0\n1.5.0', 'PI_VERSION_UNPARSEABLE'],
      ['', 'PI_VERSION_UNPARSEABLE'],
    ] as const) {
      const sb = piSandbox();
      const r = await installPi(envOf(sb, {}, { FAKE_PI_VERSION: v }), REAL);
      assert.equal(r.status, 'refused', v);
      assert.equal(r.code, code, v);
      assert.deepEqual(readdirSync(sb.home), [], v);
      assert.deepEqual(mutations(sb), []);
    }
    const failing = piSandbox();
    const r = await installPi(envOf(failing, {}, { FAKE_PI_EXIT: '3' }), REAL);
    assert.equal(r.code, 'PI_VERSION_UNPARSEABLE');
    const missing = piSandbox();
    const m = await installPi(envOf(missing, { piBin: join(missing.root, 'nope') }), REAL);
    assert.equal(m.code, 'PI_VERSION_UNPARSEABLE');
    assert.deepEqual(readdirSync(missing.home), []);
  });

  it('accepts newer versions (1.4.1, 1.10.0, 2.0.0)', async () => {
    for (const v of ['1.4.1', '1.10.0', '2.0.0']) {
      const sb = piSandbox();
      const r = await installPi(envOf(sb, {}, { FAKE_PI_VERSION: v }), REAL);
      assert.equal(r.status, 'done', v);
      assert.equal(r.pi_version, v);
    }
  });
});

describe('pi install: skills and the extension the user may have changed', () => {
  it('keeps skills the user edited or wrote, unless --force-skills (backup first)', async () => {
    const sb = piSandbox();
    mkdirSync(join(sb.piDir, 'skills', 'mwf'), { recursive: true });
    writeFileSync(skillPath(sb, 'mwf'), 'my own skill\n');
    const r = await installPi(envOf(sb), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.skills.find((s) => s.name === 'mwf')?.status, 'refused');
    assert.equal(readFileSync(skillPath(sb, 'mwf'), 'utf8'), 'my own skill\n');
    const f = await installPi(envOf(sb), FORCE);
    assert.equal(f.status, 'done');
    assert.equal(classify(readFileSync(skillPath(sb, 'mwf'), 'utf8')).kind, 'intact');
    const bk = backups(join(sb.piDir, 'skills'), 'mwf.SKILL.md');
    assert.equal(bk.length, 1);
    assert.equal(mode(join(sb.piDir, 'skills', bk[0]!)), 0o600);
  });

  it('keeps an extension mwf did not write, and one the user edited; --force-skills overwrites after a 0600 backup', async () => {
    for (const kind of ['foreign', 'edited'] as const) {
      const sb = piSandbox();
      await installed(sb);
      const own = readFileSync(extFile(sb), 'utf8');
      const text = kind === 'foreign' ? 'export default function () {}\n' : own + '// mine\n';
      writeFileSync(extFile(sb), text);
      const r = await installPi(envOf(sb), REAL);
      assert.equal(r.status, 'partial', kind);
      assert.equal(r.hooks?.status, 'refused', kind);
      assert.equal(readFileSync(extFile(sb), 'utf8'), text, kind);
      const f = await installPi(envOf(sb), FORCE);
      assert.equal(f.status, 'done', kind);
      assert.equal(readFileSync(extFile(sb), 'utf8'), own);
      const bk = backups(join(sb.piDir, 'extensions'), 'mwf.js');
      assert.equal(bk.length, 1, kind);
      assert.equal(readFileSync(join(sb.piDir, 'extensions', bk[0]!), 'utf8'), text);
      assert.equal(mode(join(sb.piDir, 'extensions', bk[0]!)), 0o600);
    }
  });

  it('a symlinked extension file holding foreign content is kept and never written through', async () => {
    const sb = piSandbox();
    mkdirSync(join(sb.piDir, 'extensions'), { recursive: true });
    const target = join(sb.root, 'victim.js');
    writeFileSync(target, 'victim\n');
    symlinkSync(target, extFile(sb));
    const r = await installPi(envOf(sb), REAL);
    assert.equal(r.hooks?.status, 'refused');
    assert.equal(readFileSync(target, 'utf8'), 'victim\n');
    assert.notEqual(r.status, 'done');
  });

  it('refuses to write the extension into a world-writable directory', async () => {
    const sb = piSandbox();
    mkdirSync(join(sb.piDir, 'extensions'), { recursive: true });
    chmodSync(join(sb.piDir, 'extensions'), 0o777);
    const r = await installPi(envOf(sb), REAL);
    assert.equal(r.hooks?.status, 'refused');
    assert.equal(existsSync(extFile(sb)), false);
    assert.equal(r.status, 'partial');
  });
});

describe('pi install: D9, the Codex skills in ~/.agents/skills (Aegis 2)', () => {
  it('warns, never touches them, and says the project/ancestor .agents/skills override ~/.pi/agent/skills', async () => {
    const sb = piSandbox();
    const shared = join(sb.home, '.agents', 'skills', 'mwf');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'SKILL.md'), 'codex flavour, bare tool names: mwf_save\n');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(shared, 'SKILL.md'), old, old);
    const before = tree(join(sb.home, '.agents'));
    const r = await installed(sb);
    assert.deepEqual(tree(join(sb.home, '.agents')), before);
    assert.equal(statSync(join(shared, 'SKILL.md')).mtimeMs, old.getTime());
    const w = r.warnings.join('\n');
    assert.match(w, /\.agents\/skills/);
    assert.match(w, /left them untouched/);
    assert.match(
      w,
      /project's own \.agents\/skills \(or in any ancestor directory's \.agents\/skills\)/,
    );
    assert.match(w, /HIGHER priority than/);
    assert.match(w, /override/);
    const d = await installPi(envOf(piSandbox()), DRY);
    assert.equal(d.warnings.length, 0, 'no warning when there is nothing there');
    const dry = await installPi(envOf(sb), DRY);
    assert.deepEqual(tree(join(sb.home, '.agents')), before);
    assert.match(dry.warnings.join('\n'), /left them untouched/);
  });

  it('the priority note is on every successful install, even without a conflict', async () => {
    const sb = piSandbox();
    const r = await installed(sb);
    assert.match(
      r.notes.join('\n'),
      /project's own \.agents\/skills \(or an ancestor directory's \.agents\/skills\) or \.pi\/skills has higher priority/,
    );
  });
});

describe('pi install: PI_CODING_AGENT_DIR and the file the CLI writes', () => {
  it('without it everything is under ~/.pi/agent; pi is run with no PI_CODING_AGENT_DIR even if the base env had one', async () => {
    const sb = piSandbox(false);
    const elsewhere = join(sb.root, 'elsewhere');
    await installPi(envOf(sb, {}, { PI_CODING_AGENT_DIR: elsewhere }), REAL);
    assert.ok(existsSync(join(sb.home, '.pi', 'agent', 'mcp.json')));
    assert.ok(existsSync(join(sb.home, '.pi', 'agent', 'extensions', 'mwf.js')));
    assert.ok(existsSync(join(sb.home, '.pi', 'agent', 'skills', 'mwf', 'SKILL.md')));
    assert.equal(existsSync(elsewhere), false);
  });

  it('with it set, everything goes there including mcp.json; ~/.pi stays untouched', async () => {
    const sb = piSandbox(true);
    const r = await installed(sb);
    assert.ok(existsSync(join(sb.root, 'agent', 'mcp.json')));
    assert.ok(existsSync(join(sb.root, 'agent', 'extensions', 'mwf.js')));
    assert.ok(existsSync(join(sb.root, 'agent', 'skills', 'mwf', 'SKILL.md')));
    assert.equal(existsSync(join(sb.home, '.pi')), false);
    assert.match(r.warnings.join('\n'), /PI_CODING_AGENT_DIR is set/);
  });
});

describe('pi install: safeguards on mcp.json (A1, A3, A4)', () => {
  const SECRET = { theme: 'x', mcpServers: { other: OTHER }, imports: ['a'] };

  it('A1 backs up exactly the file pi writes, 0600, with its exact content; nothing but the mwf entry changes', async () => {
    const sb = piSandbox();
    const text = JSON.stringify(SECRET, null, 2);
    writeMcp(sb, text);
    const r = await installed(sb);
    const bk = backups(sb.piDir, 'mcp.json');
    assert.equal(bk.length, 1);
    assert.equal(readFileSync(join(sb.piDir, bk[0]!), 'utf8'), text);
    assert.equal(mode(join(sb.piDir, bk[0]!)), 0o600);
    assert.equal(r.mcp?.backup, join(sb.piDir, bk[0]!));
    const now = mcp(sb);
    assert.deepEqual({ ...now, mcpServers: { other: now.mcpServers.other } }, SECRET);
  });

  it('no backup when mcp.json did not exist', async () => {
    const sb = piSandbox();
    await installed(sb);
    assert.deepEqual(backups(sb.piDir, 'mcp.json'), []);
  });

  it('backups are 0600 whatever the umask (A2)', async () => {
    const sb = piSandbox();
    mkdirSync(sb.piDir, { recursive: true });
    writeFileSync(sb.mcpJson, JSON.stringify(SECRET), { mode: 0o644 });
    const old = process.umask(0);
    try {
      await installed(sb);
    } finally {
      process.umask(old);
    }
    assert.equal(mode(join(sb.piDir, backups(sb.piDir, 'mcp.json')[0]!)), 0o600);
  });

  for (const [name, fakeMode, status] of [
    ['clobber (an unrelated key rewritten)', 'clobber', 'failed'],
    ['delete (another server dropped)', 'delete', 'failed'],
    ['breakjson (file left unreadable)', 'breakjson', 'failed'],
    ['noexposure (entry not in our form)', 'noexposure', 'failed'],
  ] as const) {
    it(`reports CONFIG_CHANGED_UNEXPECTEDLY, does not revert, names the backup and says to close sessions: ${name}`, async () => {
      const sb = piSandbox();
      writeMcp(sb, SECRET);
      const original = readFileSync(sb.mcpJson, 'utf8');
      const r = await installPi(envOf(sb, {}, { FAKE_PI_MODE: fakeMode }), REAL);
      assert.equal(r.status, status);
      assert.equal(r.code, 'CONFIG_CHANGED_UNEXPECTEDLY');
      assert.equal(r.mcp?.status, 'unexpected_change');
      assert.match(r.mcp!.detail!, /NOT reverted/);
      assert.match(r.mcp!.detail!, /Close every running Pi session first/);
      assert.match(r.mcp!.detail!, /CONFIG_CHANGED_UNEXPECTEDLY/);
      const bk = backups(sb.piDir, 'mcp.json');
      assert.equal(bk.length, 1);
      assert.equal(readFileSync(join(sb.piDir, bk[0]!), 'utf8'), original);
      assert.ok(r.mcp!.detail!.includes(join(sb.piDir, bk[0]!)));
    });
  }

  it('a failing pi command is partial with the manual command; nothing else lost', async () => {
    const sb = piSandbox();
    const r = await installPi(envOf(sb, {}, { FAKE_PI_MODE: 'fail' }), REAL);
    assert.equal(r.status, 'partial');
    assert.equal(r.mcp?.status, 'failed');
    assert.match(r.mcp!.manual!, /pi mcp add mwf --exposure direct/);
    assert.equal(r.hooks?.status, 'created');
  });

  it('mcp.json that is not strict JSON (BOM, comments, array, invalid) is not run against: manual command, rest installed', async () => {
    for (const bad of ['\ufeff{"mcpServers":{}}', '{ // c\n}', '[]', '{ broken', '']) {
      const sb = piSandbox();
      writeMcp(sb, bad);
      const r = await installPi(envOf(sb), REAL);
      assert.equal(r.status, 'partial', JSON.stringify(bad));
      assert.equal(r.mcp?.status, 'refused', JSON.stringify(bad));
      assert.match(r.mcp!.manual!, /pi mcp add/);
      assert.deepEqual(mutations(sb), []);
      assert.equal(readFileSync(sb.mcpJson, 'utf8'), bad);
      assert.equal(r.hooks?.status, 'created');
    }
  });

  it('a symlinked mcp.json (dotfiles manager) stays a link; the real file changes and the backup is beside it', async () => {
    const sb = piSandbox();
    const dots = join(sb.root, 'dots');
    mkdirSync(dots, { recursive: true });
    mkdirSync(sb.piDir, { recursive: true });
    writeFileSync(join(dots, 'mcp.json'), JSON.stringify({ mcpServers: { other: OTHER } }), {
      mode: 0o600,
    });
    symlinkSync(join(dots, 'mcp.json'), sb.mcpJson);
    await installed(sb);
    assert.ok(lstatSync(sb.mcpJson).isSymbolicLink());
    assert.equal(
      JSON.parse(readFileSync(join(dots, 'mcp.json'), 'utf8')).mcpServers.mwf.exposure,
      'direct',
    );
    assert.equal(backups(dots, 'mcp.json').length, 1);
  });

  it('refuses to back up or change mcp.json in a world-writable directory: no pi command', async () => {
    const sb = piSandbox();
    writeMcp(sb, { mcpServers: { other: OTHER } });
    chmodSync(sb.piDir, 0o777);
    const r = await installPi(envOf(sb), REAL);
    assert.equal(r.mcp?.status, 'refused');
    assert.deepEqual(mutations(sb), []);
    assert.deepEqual(backups(sb.piDir, 'mcp.json'), []);
  });

  it('verifyMcpJsonChange: only the mwf entry may differ', () => {
    const want = { command: 'n', args: ['/m/mwf.js', 'mcp'] };
    const entry = { ...want, exposure: 'direct' };
    const before = { a: 1, mcpServers: { other: OTHER } };
    assert.equal(
      verifyMcpJsonChange(before, { ...before, mcpServers: { other: OTHER, mwf: entry } }, want),
      undefined,
    );
    assert.match(
      verifyMcpJsonChange(before, { a: 2, mcpServers: { other: OTHER, mwf: entry } }, want)!,
      /other than/,
    );
    assert.match(
      verifyMcpJsonChange(before, { a: 1, mcpServers: { mwf: entry } }, want)!,
      /other than/,
    );
    assert.match(
      verifyMcpJsonChange(
        before,
        { ...before, mcpServers: { other: OTHER, mwf: { ...entry, exposure: 'codemode' } } },
        want,
      )!,
      /not what was asked/,
    );
    assert.match(
      verifyMcpJsonChange(
        before,
        { ...before, mcpServers: { other: OTHER, mwf: { ...entry, args: ['x'] } } },
        want,
      )!,
      /not what was asked/,
    );
    assert.equal(verifyMcpJsonChange({ mcpServers: { mwf: entry } }, {}, null), undefined);
    assert.match(
      verifyMcpJsonChange({ mcpServers: { mwf: entry } }, { mcpServers: { mwf: entry } }, null)!,
      /still in/,
    );
  });
});

describe('pi uninstall', () => {
  it('removes exactly what install wrote and leaves everything else, including other servers and skills', async () => {
    const sb = piSandbox();
    writeMcp(sb, { mcpServers: { other: OTHER }, keep: true });
    mkdirSync(join(sb.piDir, 'skills', 'my-own'), { recursive: true });
    writeFileSync(join(sb.piDir, 'skills', 'my-own', 'SKILL.md'), 'mine\n');
    writeFileSync(join(sb.piDir, 'settings.json'), '{"a":1}\n');
    await installed(sb);
    const r = await uninstallPi(envOf(sb), REAL);
    assert.equal(r.status, 'done', JSON.stringify(r));
    assert.equal(existsSync(extFile(sb)), false);
    for (const s of SKILLS) assert.equal(existsSync(skillPath(sb, s.name)), false, s.name);
    assert.deepEqual(mcp(sb), { mcpServers: { other: OTHER }, keep: true });
    assert.equal(readFileSync(join(sb.piDir, 'skills', 'my-own', 'SKILL.md'), 'utf8'), 'mine\n');
    assert.equal(readFileSync(join(sb.piDir, 'settings.json'), 'utf8'), '{"a":1}\n');
    assert.equal(r.mcp?.status, 'removed');
    assert.ok(r.backups.length >= 1);
    assert.match(r.notes.join('\n'), /Project memory/);
  });

  it('is a no-op when nothing is installed, and idempotent', async () => {
    const sb = piSandbox();
    const before = tree(sb.root);
    const r = await uninstallPi(envOf(sb), REAL);
    assert.equal(r.status, 'done');
    assert.equal(r.mcp?.status, 'absent');
    assert.equal(r.hooks?.status, 'unchanged');
    assert.deepEqual(tree(sb.root), before);
    assert.deepEqual(mutations(sb), []);
    await installed(sb);
    await uninstallPi(envOf(sb), REAL);
    const again = await uninstallPi(envOf(sb), REAL);
    assert.equal(again.status, 'done');
    assert.equal(again.mcp?.status, 'absent');
  });

  it('keeps an extension the user edited, or did not get from mwf; --force-skills removes it after a backup', async () => {
    for (const kind of ['foreign', 'edited'] as const) {
      const sb = piSandbox();
      await installed(sb);
      const own = readFileSync(extFile(sb), 'utf8');
      const text = kind === 'foreign' ? 'mine\n' : own + '// mine\n';
      writeFileSync(extFile(sb), text);
      const r = await uninstallPi(envOf(sb), REAL);
      assert.equal(r.status, 'partial', kind);
      assert.equal(r.hooks?.status, 'refused', kind);
      assert.equal(readFileSync(extFile(sb), 'utf8'), text);
      const f = await uninstallPi(envOf(sb), FORCE);
      assert.equal(existsSync(extFile(sb)), false, kind);
      const bk = backups(join(sb.piDir, 'extensions'), 'mwf.js');
      assert.equal(readFileSync(join(sb.piDir, 'extensions', bk[0]!), 'utf8'), text, kind);
      assert.equal(f.hooks?.status, 'removed');
    }
  });

  it('removes an older entry of ours without exposure, but leaves one that is not ours', async () => {
    const sb = piSandbox();
    writeMcp(sb, {
      mcpServers: { mwf: { command: 'node', args: ['/old/mwf.js', 'mcp'] }, other: OTHER },
    });
    const r = await uninstallPi(envOf(sb), REAL);
    assert.equal(r.mcp?.status, 'removed');
    assert.deepEqual(mcp(sb).mcpServers, { other: OTHER });
    const sb2 = piSandbox();
    writeMcp(sb2, { mcpServers: { mwf: { command: 'their', args: [] } } });
    const r2 = await uninstallPi(envOf(sb2), REAL);
    assert.equal(r2.status, 'partial');
    assert.equal(r2.mcp?.status, 'refused');
    assert.deepEqual(mutations(sb2), []);
  });

  it('needs no working pi version to remove; a failing pi is partial with the manual command', async () => {
    const sb = piSandbox();
    await installed(sb);
    const r = await uninstallPi(
      envOf(sb, {}, { FAKE_PI_VERSION: '0.1.0', FAKE_PI_MODE: 'fail' }),
      REAL,
    );
    assert.equal(r.status, 'partial');
    assert.equal(r.mcp?.status, 'failed');
    assert.match(r.mcp!.manual!, /pi mcp remove mwf/);
    assert.equal(existsSync(extFile(sb)), false);
  });

  it('an unexpected change by pi is reported, not reverted', async () => {
    const sb = piSandbox();
    writeMcp(sb, { mcpServers: { other: OTHER } });
    await installed(sb);
    const r = await uninstallPi(envOf(sb, {}, { FAKE_PI_MODE: 'clobber' }), REAL);
    assert.equal(r.code, 'CONFIG_CHANGED_UNEXPECTEDLY');
    assert.equal(r.status, 'failed');
    assert.equal(mcp(sb).theme, 'tampered');
  });

  it('--dry-run changes and runs nothing', async () => {
    const sb = piSandbox();
    await installed(sb);
    const before = tree(sb.root);
    const n = sb.calls().length;
    const r = await uninstallPi(envOf(sb), DRY);
    assert.equal(r.mcp?.status, 'planned');
    assert.deepEqual(tree(sb.root), before);
    assert.equal(sb.calls().length, n);
  });

  it('never touches the Codex skills in ~/.agents/skills', async () => {
    const sb = piSandbox();
    await installed(sb);
    const shared = join(sb.home, '.agents', 'skills', 'mwf');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'SKILL.md'), 'codex\n');
    const before = tree(join(sb.home, '.agents'));
    await uninstallPi(envOf(sb), REAL);
    assert.deepEqual(tree(join(sb.home, '.agents')), before);
  });
});

describe('mwf install --harness pi (the command)', () => {
  async function run(sb: PiSandbox, argv: string[], extra: Partial<LifecycleIo> = {}) {
    const res = { out: '', err: '' };
    const code = await lifecycleMain(argv, {
      stdout: (t) => (res.out += t),
      stderr: (t) => (res.err += t),
      entry: sb.mwfJs,
      env: sb.env,
      home: sb.home,
      piBin: sb.pi,
      ...extra,
    });
    return { code, ...res };
  }

  it('a real run needs a terminal on both stdin and stdout; pi is not even asked for its version', async () => {
    for (const tty of [
      undefined,
      { stdin: false, stdout: false },
      { stdin: true, stdout: false },
      { stdin: false, stdout: true },
    ]) {
      for (const cmd of ['install', 'uninstall']) {
        const sb = piSandbox();
        const r = await run(sb, [cmd, '--harness', 'pi'], tty ? { tty } : {});
        assert.equal(r.code, 1);
        assert.match(r.err, /CONFIRM_REQUIRES_TTY/);
        assert.deepEqual(readdirSync(sb.home), []);
        assert.deepEqual(sb.calls(), []);
      }
    }
  });

  it('install then uninstall in a terminal', async () => {
    const sb = piSandbox();
    const tty = { stdin: true, stdout: true };
    const i = await run(sb, ['install', '--harness', 'pi'], { tty });
    assert.equal(i.code, 0, i.err + i.out);
    assert.match(i.out, /Pi 1\.4\.0/);
    assert.match(i.out, /extension/);
    assert.ok(existsSync(extFile(sb)));
    const u = await run(sb, ['uninstall', '--harness', 'pi'], { tty });
    assert.equal(u.code, 0, u.err + u.out);
    assert.equal(existsSync(extFile(sb)), false);
  });

  it('--dry-run works without a terminal; --json prints the report', async () => {
    const sb = piSandbox();
    const r = await run(sb, ['install', '--harness', 'pi', '--dry-run', '--json']);
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out).data;
    assert.equal(j.harness, 'pi');
    assert.equal(j.dry_run, true);
    assert.equal(j.mcp.status, 'planned');
    assert.deepEqual(readdirSync(sb.home), []);
  });

  it('PI_CODING_AGENT_DIR from the environment selects the directory; a relative one is refused', async () => {
    const sb = piSandbox(true);
    const r = await run(sb, ['install', '--harness', 'pi'], { tty: { stdin: true, stdout: true } });
    assert.equal(r.code, 0, r.err + r.out);
    assert.ok(existsSync(join(sb.root, 'agent', 'extensions', 'mwf.js')));
    const rel = piSandbox();
    const bad = await run(rel, ['install', '--harness', 'pi', '--dry-run'], {
      env: { ...rel.env, PI_CODING_AGENT_DIR: 'relative/dir' },
    });
    assert.equal(bad.code, 1);
    assert.deepEqual(rel.calls(), []);
  });

  it('usage mentions pi and unknown harnesses are a usage error', async () => {
    const sb = piSandbox();
    const bad = await run(sb, ['install', '--harness', 'vim']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /codex, claude or pi/);
    const help = await run(sb, ['install', '--help']);
    assert.match(help.out + help.err, /--harness codex\|claude\|pi/);
    assert.match(help.out + help.err, /higher priority/);
  });
});
