// F1: every directory on the way to a write target is checked, not just the leaf.
// A world-writable temp directory stands in for /tmp (no sudo, nothing outside the sandboxes).
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { execRunner, installCodex, uninstallCodex, type Report } from '../src/lifecycle/codex.ts';
import { installClaude, uninstallClaude } from '../src/lifecycle/claude.ts';
import { installPi, uninstallPi } from '../src/lifecycle/pi.ts';
import {
  SafeWriteError,
  checkAncestors,
  mkdirSafe,
  resolveTarget,
  type AccountReader,
  type Owner,
} from '../src/lifecycle/safe-write.ts';
import { SKILLS } from '../src/skills/index.ts';
import { sandbox } from './helpers/fake-codex.ts';
import { claudeSandbox } from './helpers/fake-claude.ts';
import { piSandbox } from './helpers/fake-pi.ts';
import { tmpDir } from './helpers/util.ts';

const REAL = { dryRun: false, forceSkills: false };
const DRY = { dryRun: true, forceSkills: false };
const uid = process.getuid?.() ?? 0;

/** A world-writable directory outside every sandbox: the stand-in for /tmp. */
function trapDir(mode = 0o777): string {
  const dir = tmpDir('mwf-trap-');
  chmodSync(dir, mode);
  return dir;
}
const gidOf = (p: string): number => statSync(p).gid;

/** Fake /etc/passwd and /etc/group (injected through the owner; the real ones are never read). */
function accounts(
  gid: number,
  opts: {
    members?: string[];
    others?: Array<{ uid: number; gid: number }>;
    primary?: number;
    noGroup?: boolean;
    noUser?: boolean;
  } = {},
): AccountReader {
  const passwd = [
    ...(opts.noUser ? [] : [`me:x:${uid}:${opts.primary ?? gid}:Me:/home/me:/bin/sh`]),
    ...(opts.others ?? []).map((o, i) => `other${i}:x:${o.uid}:${o.gid}::/home/o:/bin/sh`),
  ].join('\n');
  const group = opts.noGroup
    ? 'unrelated:x:99999:\n'
    : `mygroup:x:${gid}:${(opts.members ?? ['me']).join(',')}\n`;
  return { passwd: () => `${passwd}\n`, group: () => group };
}
const ownerWith = (a: AccountReader): Owner => ({ uid, accounts: a });

const expectUnsafe = (fn: () => unknown, re: RegExp): void =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof SafeWriteError, String(e));
    assert.equal(e.code, 'UNSAFE_TARGET');
    assert.match(e.message, re);
    return true;
  });

describe('checkAncestors (the shared rule)', () => {
  it('walks from the trust root down, resolves links inside it and returns the resolved path', () => {
    const root = tmpDir('mwf-anc-');
    mkdirSync(join(root, 'real', 'deep'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const owner: Owner = { uid, root };
    assert.equal(
      checkAncestors(join(root, 'link', 'deep'), owner),
      join(realpathSync(root), 'real', 'deep'),
    );
    // the missing tail is not an error, it is appended to the resolved part
    assert.equal(
      checkAncestors(join(root, 'link', 'new', 'er'), owner),
      join(realpathSync(root), 'real', 'new', 'er'),
    );
  });

  it('without a root it checks nothing above the leaf (the old behaviour)', () => {
    const trap = trapDir();
    assert.equal(checkAncestors(join(trap, 'x'), { uid }), join(trap, 'x'));
  });

  it('refuses a path outside the root', () => {
    const root = tmpDir('mwf-anc-');
    expectUnsafe(() => checkAncestors(join(root, '..', 'elsewhere'), { uid, root }), /outside/);
  });

  it('refuses a symlink that resolves outside the root, even to a private directory', () => {
    const root = tmpDir('mwf-anc-');
    const away = tmpDir('mwf-away-'); // 0700, ours, but not inside the root
    symlinkSync(away, join(root, 'out'));
    expectUnsafe(() => checkAncestors(join(root, 'out', 'skills'), { uid, root }), /outside/);
    expectUnsafe(
      () => checkAncestors(join(root, 'out', 'skills'), { uid, root }),
      /dotfiles repository\) is refused; make it a real directory/,
    );
  });

  it('refuses a dangling symlink at any component, and mkdirSafe creates nothing through it', () => {
    const root = tmpDir('mwf-anc-');
    const away = tmpDir('mwf-away-');
    const gone = join(away, 'not-there');
    symlinkSync(gone, join(root, 'dangling'));
    expectUnsafe(() => checkAncestors(join(root, 'dangling', 'a'), { uid, root }), /dangling/);
    expectUnsafe(() => mkdirSafe(join(root, 'dangling', 'a'), { uid, root }, 0o755), /dangling/);
    expectUnsafe(() => resolveTarget(join(root, 'dangling', 'f.txt'), { uid, root }), /dangling/);
    assert.equal(existsSync(gone), false);
  });

  it('refuses an other-writable ancestor, always (0o002, 0o777 and sticky 0o1777)', () => {
    for (const m of [0o702, 0o777, 0o1777, 0o1757]) {
      const root = tmpDir('mwf-anc-');
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      chmodSync(join(root, 'a'), m);
      expectUnsafe(() => checkAncestors(join(root, 'a', 'b'), { uid, root }), /world-writable/);
      // ... even with a lookup that would allow a group
      const a = accounts(gidOf(join(root, 'a')));
      expectUnsafe(
        () => checkAncestors(join(root, 'a', 'b'), { ...ownerWith(a), root }),
        /world-writable/,
      );
    }
  });

  it('refuses a directory the root itself resolves to when it is other-writable (CODEX_HOME=/tmp)', () => {
    const trap = trapDir(0o1777);
    expectUnsafe(() => checkAncestors(join(trap, 'x'), { uid, root: trap }), /world-writable/);
  });

  it('refuses a directory that is not ours', () => {
    const root = tmpDir('mwf-anc-');
    mkdirSync(join(root, 'a'));
    expectUnsafe(() => checkAncestors(join(root, 'a'), { uid: uid + 1, root }), /not owned/);
  });

  describe('group-writable ancestors', () => {
    const make = (): { root: string; dir: string; gid: number } => {
      const root = tmpDir('mwf-anc-');
      const dir = join(root, 'g');
      mkdirSync(dir);
      chmodSync(dir, 0o770);
      return { root, dir, gid: gidOf(dir) };
    };

    const cases: Array<[string, (gid: number) => AccountReader]> = [
      ['the group is not the primary group', (gid) => accounts(gid, { primary: gid + 1 })],
      [
        'another user is listed as a member of the group',
        (gid) => accounts(gid, { members: ['me', 'colleague'] }),
      ],
      [
        'another user has the group as primary group',
        (gid) => accounts(gid, { others: [{ uid: uid + 1, gid }] }),
      ],
      [
        'the group is not in the group file (membership unknown)',
        (gid) => accounts(gid, { noGroup: true }),
      ],
      ['the user is not in the password file', (gid) => accounts(gid, { noUser: true })],
      [
        'the lookup fails (group file unreadable)',
        (gid) => ({
          ...accounts(gid),
          group: () => {
            throw new Error('EACCES');
          },
        }),
      ],
      [
        'the lookup fails (password file unreadable)',
        (gid) => ({
          ...accounts(gid),
          passwd: () => {
            throw new Error('EACCES');
          },
        }),
      ],
    ];
    for (const [name, build] of cases)
      it(`refuses: ${name}`, () => {
        const { root, dir, gid } = make();
        expectUnsafe(
          () => checkAncestors(join(dir, 'sub'), { ...ownerWith(build(gid)), root }),
          /group-writable/,
        );
      });

    it('allows: the primary group with no other member; and 0o002 on the same directory is still refused', () => {
      const { root, dir, gid } = make();
      const owner = { ...ownerWith(accounts(gid)), root };
      assert.equal(checkAncestors(join(dir, 'sub'), owner), join(realpathSync(root), 'g', 'sub'));
      // a member that is only another name for us (same uid) does not count as another user
      assert.doesNotThrow(() => checkAncestors(dir, { ...ownerWith(accounts(gid)), root }));
      for (const m of [0o772, 0o777, 0o1777, 0o702]) {
        chmodSync(dir, m);
        expectUnsafe(() => checkAncestors(join(dir, 'sub'), owner), /world-writable/);
      }
      chmodSync(dir, 0o770);
      assert.doesNotThrow(() => checkAncestors(join(dir, 'sub'), owner));
      chmodSync(dir, 0o750); // control: not group-writable at all
      assert.doesNotThrow(() => checkAncestors(join(dir, 'sub'), { uid, root }));
    });
  });
});

// ---- the three harnesses -------------------------------------------------------------------

interface Rig {
  name: string;
  home: string;
  /** The skills root the installer writes to. */
  skills: string;
  /** The first directory below home on the way to it (a link there is an "intermediate" link). */
  mid: string;
  install(owner?: Owner, dry?: boolean): Promise<Report>;
  uninstall(owner?: Owner, dry?: boolean): Promise<Report>;
}

function codexRig(): Rig {
  const sb = sandbox();
  const env = (owner?: Owner) => ({
    codexHome: sb.codexHome,
    home: sb.home,
    node: process.execPath,
    mwfJs: sb.mwfJs,
    codexBin: sb.codex,
    version: '1.0.0-test',
    run: execRunner,
    baseEnv: sb.env,
    ...(owner ? { owner } : {}),
  });
  return {
    name: 'codex',
    home: sb.home,
    skills: join(sb.home, '.agents', 'skills'),
    mid: join(sb.home, '.agents'),
    install: (owner, dry) => installCodex(env(owner), dry ? DRY : REAL),
    uninstall: (owner, dry) => uninstallCodex(env(owner), dry ? DRY : REAL),
  };
}

function claudeRig(custom = false): Rig {
  const sb = claudeSandbox(custom);
  const env = (owner?: Owner) => ({
    claudeDir: sb.claudeDir,
    customDir: sb.customDir,
    home: sb.home,
    node: process.execPath,
    mwfJs: sb.mwfJs,
    claudeBin: sb.claude,
    version: '1.0.0-test',
    run: execRunner,
    baseEnv: sb.env,
    ...(owner ? { owner } : {}),
  });
  return {
    name: custom ? 'claude (CLAUDE_CONFIG_DIR)' : 'claude',
    home: sb.home,
    skills: join(sb.claudeDir, 'skills'),
    mid: sb.claudeDir,
    install: (owner, dry) => installClaude(env(owner), dry ? DRY : REAL),
    uninstall: (owner, dry) => uninstallClaude(env(owner), dry ? DRY : REAL),
  };
}

function piRig(custom = false): Rig {
  const sb = piSandbox(custom);
  const env = (owner?: Owner) => ({
    piDir: sb.piDir,
    customDir: sb.customDir,
    home: sb.home,
    node: process.execPath,
    mwfJs: sb.mwfJs,
    piBin: sb.pi,
    version: '1.0.0-test',
    run: execRunner,
    baseEnv: sb.env,
    ...(owner ? { owner } : {}),
  });
  return {
    name: custom ? 'pi (PI_CODING_AGENT_DIR)' : 'pi',
    home: sb.home,
    skills: join(sb.piDir, 'skills'),
    mid: custom ? sb.piDir : join(sb.home, '.pi'),
    install: (owner, dry) => installPi(env(owner), dry ? DRY : REAL),
    uninstall: (owner, dry) => uninstallPi(env(owner), dry ? DRY : REAL),
  };
}

const RIGS: Array<[string, () => Rig]> = [
  ['codex', codexRig],
  ['claude', () => claudeRig()],
  ['claude with CLAUDE_CONFIG_DIR', () => claudeRig(true)],
  ['pi', () => piRig()],
  ['pi with PI_CODING_AGENT_DIR', () => piRig(true)],
];

const names = SKILLS.map((s) => s.name);
const empty = (dir: string): boolean => readdirSync(dir).length === 0;
const noSkillIn = (dir: string): void => {
  for (const n of names) assert.equal(existsSync(join(dir, n)), false, `${dir}/${n}`);
};

/** Install must have been refused as UNSAFE_TARGET and have written no skill. */
function assertRefused(r: Report, label: string): void {
  assert.notEqual(r.status, 'done', label);
  assert.equal(r.code, 'UNSAFE_TARGET', `${label}: ${JSON.stringify(r)}`);
  for (const s of r.skills) assert.notEqual(s.status, 'created', label);
}

/** The home-level link to `skills`' parent, with the real directory it was meant to be. */
function linkSkillsRoot(rig: Rig, target: string): void {
  mkdirSync(join(rig.skills, '..'), { recursive: true });
  symlinkSync(target, rig.skills);
}

for (const [label, make] of RIGS) {
  describe(`F1 ${label}: the skills root and its ancestors`, () => {
    it('1: a skills root that is a symlink to a world-writable directory is refused; nothing is written there', async () => {
      for (const dry of [false, true]) {
        const rig = make();
        const trap = trapDir(0o1777);
        linkSkillsRoot(rig, trap);
        const r = await rig.install(undefined, dry);
        assertRefused(r, `${label} dry=${dry}`);
        assert.deepEqual(readdirSync(trap), [], 'nothing in the target directory');
        assert.ok(lstatSync(rig.skills).isSymbolicLink());
        assert.ok(r.skills.length > 0);
        for (const s of r.skills) assert.equal(s.code, 'UNSAFE_TARGET');
      }
    });

    it('1b: ... also when the target is a private directory outside the harness (rule: a link may not leave the root)', async () => {
      const rig = make();
      const away = tmpDir('mwf-away-');
      linkSkillsRoot(rig, away);
      const r = await rig.install();
      assertRefused(r, label);
      assert.deepEqual(readdirSync(away), []);
    });

    it('3: a dangling symlink as the skills root is refused and nothing is created at its target', async () => {
      for (const dry of [false, true]) {
        const rig = make();
        const gone = join(tmpDir('mwf-away-'), 'missing', 'deeper');
        linkSkillsRoot(rig, gone);
        const r = await rig.install(undefined, dry);
        assertRefused(r, label);
        assert.match(JSON.stringify(r), /dangling/);
        assert.equal(existsSync(join(gone, '..')), false);
      }
    });

    it('3b: a dangling intermediate symlink is refused and nothing is created at its target', async () => {
      const rig = make();
      const gone = join(tmpDir('mwf-away-'), 'missing');
      symlinkSync(gone, rig.mid);
      const r = await rig.install();
      assertRefused(r, label);
      assert.equal(existsSync(gone), false);
    });

    it('2: an intermediate symlink into a world-writable directory is refused; nothing is written there', async () => {
      const rig = make();
      const trap = trapDir(0o1777);
      symlinkSync(trap, rig.mid);
      const r = await rig.install();
      assertRefused(r, label);
      assert.deepEqual(readdirSync(trap), []);
    });

    it('2b: an intermediate symlink to a private directory outside the harness root is refused', async () => {
      const rig = make();
      const away = tmpDir('mwf-away-');
      symlinkSync(away, rig.mid);
      const r = await rig.install();
      // a CODEX/CLAUDE/PI dir that is itself the root may be a link (the user's choice);
      // below the root a link may not leave it
      if (label.includes('CONFIG_DIR') || label.includes('AGENT_DIR')) {
        assert.equal(r.status, 'done', JSON.stringify(r));
        return;
      }
      assertRefused(r, label);
      assert.deepEqual(readdirSync(away), []);
    });

    it('2c: positive control: a symlink that stays inside home, to a private directory, works', async () => {
      const rig = make();
      if (label.includes('CONFIG_DIR') || label.includes('AGENT_DIR')) return; // no home-relative link
      const dots = join(rig.home, 'dotfiles', 'target');
      mkdirSync(dots, { recursive: true });
      symlinkSync(dots, rig.mid);
      const r = await rig.install();
      assert.equal(r.status, 'done', JSON.stringify(r));
      for (const n of names)
        assert.ok(existsSync(join(dots, rig.skills.slice(rig.mid.length), n, 'SKILL.md')));
      const u = await rig.uninstall();
      assert.equal(u.status, 'done', JSON.stringify(u));
    });

    it('4: a world-writable directory on the way is refused (0o777 and sticky 0o1777), and a 0o775 one is too unless the group is ours alone', async () => {
      for (const m of [0o777, 0o1777]) {
        const rig = make();
        mkdirSync(rig.skills, { recursive: true });
        chmodSync(join(rig.skills, '..'), m);
        const r = await rig.install();
        assertRefused(r, `${label} ${m.toString(8)}`);
        noSkillIn(rig.skills);
      }
    });

    it('4b: a world-writable skills root itself is refused; a 0o775 one is group-checked', async () => {
      const rig = make();
      mkdirSync(rig.skills, { recursive: true });
      chmodSync(rig.skills, 0o777);
      const r = await rig.install();
      assertRefused(r, label);
      assert.ok(empty(rig.skills));
    });

    it('5: uninstall never removes through an unsafe link, a dangling link or a world-writable directory', async () => {
      // the leftovers of the old bug: skills in the world-writable directory the root points to
      const rig = make();
      const trap = trapDir(0o1777);
      for (const n of names) {
        mkdirSync(join(trap, n));
        writeFileSync(join(trap, n, 'SKILL.md'), 'leftover\n');
      }
      linkSkillsRoot(rig, trap);
      for (const dry of [false, true]) {
        const u = await rig.uninstall(undefined, dry);
        assert.equal(u.code, 'UNSAFE_TARGET', JSON.stringify(u));
        assert.notEqual(u.status, 'done');
        for (const s of u.skills) assert.equal(s.status, 'refused');
      }
      for (const n of names) assert.equal(readdirSync(join(trap, n)).join(), 'SKILL.md');
      // a dangling root
      const rig2 = make();
      linkSkillsRoot(rig2, join(tmpDir('mwf-away-'), 'missing'));
      const u2 = await rig2.uninstall();
      assert.equal(u2.code, 'UNSAFE_TARGET');
      // a world-writable root
      const rig3 = make();
      mkdirSync(join(rig3.skills, names[0]!), { recursive: true });
      writeFileSync(join(rig3.skills, names[0]!, 'SKILL.md'), 'mine\n');
      chmodSync(rig3.skills, 0o777);
      const u3 = await rig3.uninstall();
      assert.equal(u3.code, 'UNSAFE_TARGET');
      assert.equal(existsSync(join(rig3.skills, names[0]!, 'SKILL.md')), true);
    });

    it('6: regression: a normal install and uninstall still work, and a missing skills root is created', async () => {
      const rig = make();
      const r = await rig.install();
      assert.equal(r.status, 'done', JSON.stringify(r));
      for (const n of names) assert.ok(existsSync(join(rig.skills, n, 'SKILL.md')));
      assert.equal(statSync(rig.skills).mode & 0o022, 0);
      const again = await rig.install();
      assert.equal(again.status, 'done');
      const u = await rig.uninstall();
      assert.equal(u.status, 'done', JSON.stringify(u));
      noSkillIn(rig.skills);
      const none = await make().uninstall(); // nothing installed: a no-op
      assert.equal(none.code, undefined);
    });

    it('8: group-writable ancestor, refuse cases (not our group, shared group, lookup fails)', async () => {
      const kinds: Array<[string, (gid: number) => AccountReader]> = [
        ['not the primary group', (gid) => accounts(gid, { primary: gid + 1 })],
        ['another member', (gid) => accounts(gid, { members: ['me', 'colleague'] })],
        [
          'lookup fails',
          (gid) => ({
            passwd: () => {
              throw new Error('boom');
            },
            group: () => accounts(gid).group(),
          }),
        ],
      ];
      for (const [kind, build] of kinds) {
        const rig = make();
        mkdirSync(rig.skills, { recursive: true });
        const mid = join(rig.skills, '..');
        chmodSync(mid, 0o770);
        const r = await rig.install(ownerWith(build(gidOf(mid))));
        assertRefused(r, `${label}: ${kind}`);
        noSkillIn(rig.skills);
        const u = await rig.uninstall(ownerWith(build(gidOf(mid))));
        assert.equal(u.code, 'UNSAFE_TARGET', kind);
      }
    });

    it('9: group-writable ancestor, allow case (our own group, no other member), and 0o002 on the same directory is refused', async () => {
      const rig = make();
      mkdirSync(rig.skills, { recursive: true });
      const mid = join(rig.skills, '..');
      chmodSync(mid, 0o770);
      const owner = ownerWith(accounts(gidOf(mid)));
      const r = await rig.install(owner);
      assert.equal(r.status, 'done', JSON.stringify(r));
      for (const n of names) assert.ok(existsSync(join(rig.skills, n, 'SKILL.md')));
      // control: other-writable on the very same directory is refused whatever the lookup says
      const rig2 = make();
      mkdirSync(rig2.skills, { recursive: true });
      const mid2 = join(rig2.skills, '..');
      for (const m of [0o777, 0o1777, 0o772]) {
        chmodSync(mid2, m);
        const r2 = await rig2.install(ownerWith(accounts(gidOf(mid2))));
        assertRefused(r2, `${label} ${m.toString(8)}`);
        noSkillIn(rig2.skills);
      }
    });
  });
}
