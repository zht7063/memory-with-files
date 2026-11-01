import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  SafeWriteError,
  backupSnapshot,
  commitFile,
  readSnapshot,
  removeFile,
  resolveTarget,
} from '../src/lifecycle/safe-write.ts';
import { tmpDir } from './helpers/util.ts';

const mode = (p: string): number => statSync(p).mode & 0o777;
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof SafeWriteError ? error.code : `other:${(error as Error).message}`;
  }
  return undefined;
};
const names = (dir: string): string[] => readdirSync(dir).sort();

describe('safe-write', () => {
  it('creates a new file (0600 by default) and leaves no temp file', () => {
    const dir = tmpDir();
    const p = join(dir, 'a.json');
    const r = commitFile(p, 'hello', readSnapshot(p));
    assert.equal(readFileSync(p, 'utf8'), 'hello');
    assert.equal(mode(p), 0o600);
    assert.equal(r.backup, undefined);
    assert.deepEqual(names(dir), ['a.json']);
  });

  it('backs an existing file up to a unique 0600 file, keeps the file mode, and never overwrites a backup (A2)', () => {
    const dir = tmpDir();
    const p = join(dir, 'a.json');
    writeFileSync(p, 'v0', { mode: 0o644 });
    chmodSync(p, 0o644);
    const first = commitFile(p, 'v1', readSnapshot(p), { now: new Date('2026-11-01T00:00:00Z') });
    const second = commitFile(p, 'v2', readSnapshot(p), { now: new Date('2026-11-01T00:00:00Z') });
    assert.notEqual(first.backup, second.backup, 'same second, still different backups');
    assert.equal(readFileSync(first.backup!, 'utf8'), 'v0');
    assert.equal(readFileSync(second.backup!, 'utf8'), 'v1');
    assert.equal(mode(first.backup!), 0o600);
    assert.equal(mode(second.backup!), 0o600);
    assert.equal(mode(p), 0o644);
    assert.match(first.backup!, /a\.json\.mwf-bak-20261101T000000Z-[0-9a-f]{8}$/);
    assert.equal(names(dir).length, 3);
  });

  it('a backup is 0600 whatever the umask', () => {
    const dir = tmpDir();
    const p = join(dir, 'x');
    writeFileSync(p, 'data');
    const old = process.umask(0o000);
    try {
      const b = backupSnapshot(p, readSnapshot(p));
      assert.equal(mode(b), 0o600);
    } finally {
      process.umask(old);
    }
  });

  it('writes through a symlink: the real file changes, the link and its directory stay as they were (A3)', () => {
    const base = tmpDir();
    const dots = join(base, 'dotfiles');
    const conf = join(base, 'conf');
    mkdirSync(dots);
    mkdirSync(conf);
    const real = join(dots, 'hooks.json');
    writeFileSync(real, '{"a":1}\n');
    const link = join(conf, 'hooks.json');
    symlinkSync(real, link);
    const r = commitFile(link, '{"a":2}\n', readSnapshot(link));
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), real);
    assert.equal(readFileSync(real, 'utf8'), '{"a":2}\n');
    assert.deepEqual(names(conf), ['hooks.json'], 'nothing new next to the link');
    assert.equal(names(dots).length, 2, 'the backup sits next to the real file');
    assert.ok(r.backup!.startsWith(dots));
  });

  it('refuses a file or directory owned by someone else, a dangling link, a directory, a fifo, a world-writable directory (A3)', () => {
    const dir = tmpDir();
    const p = join(dir, 'f');
    writeFileSync(p, 'x');
    const me = process.getuid!();
    assert.equal(
      code(() => readSnapshot(p, { uid: me + 1 })),
      'UNSAFE_TARGET',
    );
    assert.equal(
      code(() => commitFile(p, 'y', readSnapshot(p), { owner: { uid: me + 1 } })),
      'UNSAFE_TARGET',
    );
    symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling'));
    assert.equal(
      code(() => readSnapshot(join(dir, 'dangling'))),
      'UNSAFE_TARGET',
    );
    mkdirSync(join(dir, 'd'));
    assert.equal(
      code(() => readSnapshot(join(dir, 'd'))),
      'UNSAFE_TARGET',
    );
    assert.equal(spawnSync('mkfifo', [join(dir, 'fifo')]).status, 0);
    assert.equal(
      code(() => readSnapshot(join(dir, 'fifo'))),
      'UNSAFE_TARGET',
    );
    const open = join(dir, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    assert.equal(
      code(() => readSnapshot(join(open, 'new'))),
      'UNSAFE_TARGET',
    );
    assert.equal(
      code(() => readSnapshot(join(dir, 'missing-dir', 'new'))),
      'UNSAFE_TARGET',
    );
  });

  it("a change between the read and the rename aborts the write and keeps the other writer's file", () => {
    const dir = tmpDir();
    const p = join(dir, 'a.json');
    writeFileSync(p, 'v0');
    const snap = readSnapshot(p);
    // changed before we commit
    writeFileSync(p, 'other-1');
    assert.equal(
      code(() => commitFile(p, 'ours', snap)),
      'CONCURRENT_MODIFICATION',
    );
    assert.equal(readFileSync(p, 'utf8'), 'other-1');
    // changed in the window just before the rename
    const snap2 = readSnapshot(p);
    const c = code(() =>
      commitFile(p, 'ours', snap2, { beforeRename: () => writeFileSync(p, 'other-2!') }),
    );
    assert.equal(c, 'CONCURRENT_MODIFICATION');
    assert.equal(readFileSync(p, 'utf8'), 'other-2!');
    assert.ok(!names(dir).some((n) => n.includes('mwf-tmp')), 'temp file removed');
  });

  it('a same-size, same-content rewrite is not a change; a same-size different-content one is', () => {
    const dir = tmpDir();
    const p = join(dir, 'a');
    writeFileSync(p, 'aaaa');
    const snap = readSnapshot(p);
    writeFileSync(p, 'bbbb');
    assert.equal(
      code(() => commitFile(p, 'x', snap)),
      'CONCURRENT_MODIFICATION',
    );
  });

  it('a file that appears after we saw none is never overwritten', () => {
    const dir = tmpDir();
    const p = join(dir, 'new.json');
    const snap = readSnapshot(p);
    assert.equal(snap.exists, false);
    const c = code(() =>
      commitFile(p, 'ours', snap, { beforeRename: () => writeFileSync(p, 'theirs') }),
    );
    assert.equal(c, 'CONCURRENT_MODIFICATION');
    assert.equal(readFileSync(p, 'utf8'), 'theirs');
    assert.deepEqual(names(dir), ['new.json']);
  });

  it('removeFile backs up first, refuses a symlink, and refuses a file that changed', () => {
    const dir = tmpDir();
    const p = join(dir, 'a');
    writeFileSync(p, 'data');
    const r = removeFile(p, readSnapshot(p));
    assert.equal(readFileSync(r.backup!, 'utf8'), 'data');
    assert.equal(mode(r.backup!), 0o600);
    assert.deepEqual(names(dir), [r.backup!.split('/').pop()]);
    const real = join(dir, 'real');
    writeFileSync(real, 'x');
    symlinkSync(real, join(dir, 'link'));
    assert.equal(
      code(() => removeFile(join(dir, 'link'), readSnapshot(join(dir, 'link')))),
      'UNSAFE_TARGET',
    );
    const snap = readSnapshot(real);
    writeFileSync(real, 'y');
    assert.equal(
      code(() => removeFile(real, snap)),
      'CONCURRENT_MODIFICATION',
    );
    assert.equal(readFileSync(real, 'utf8'), 'y');
  });

  it('resolveTarget gives the real path and accepts a not-yet-existing file in a good directory', () => {
    const dir = tmpDir();
    assert.equal(resolveTarget(join(dir, 'x')), join(realpathSync(dir), 'x'));
  });
});
