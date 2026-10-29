// L1-L4: recovery that skipped a changed file (doctor), a lock held too long (doctor), pid
// namespaces (same hostname, different namespace), and aborting a write whose lock was lost.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as core from '../src/core/index.ts';
import { setFailpointHook } from '../src/core/failpoint.ts';
import {
  acquireLock,
  assertLockHeld,
  beat,
  inspectLock,
  pidNamespace,
  processStart,
} from '../src/core/lock.ts';
import { layoutOf } from '../src/core/paths.ts';
import { withLock } from '../src/core/write.ts';
import { project, runChild } from './helpers/util.ts';

const THIEF = { pid: 1, host: 'thief-host', token: 'thief-token' };
const steal = (lockPath: string): void =>
  writeFileSync(lockPath, JSON.stringify({ ...THIEF, time: Date.now() }));

describe('L1: doctor reports a roll-forward that skipped a changed file', () => {
  it('keeps the hand-edited file and says so; the report goes away once the file is gone', async () => {
    const ctx = await project('track', { waitMs: 5000, lockStaleMs: 300 });
    const a = await core.add(ctx, { type: 'decision', title: 'Alpha', body: 'alpha body' });
    const b = await core.add(ctx, { type: 'decision', title: 'Beta', body: 'beta body' });
    const ids = [a.id, b.id];
    const preview = (await core.forget(ctx, { ids })) as core.Preview<unknown>;
    // forget plans: index.md, trash copy A, trash copy B, remove A, remove B. Die after "remove A".
    const crashed = await runChild(
      ctx,
      [
        {
          fn: 'forget',
          input: { ids, confirm: true, preview_token: preview.preview_token, request_id: 'l1-req' },
        },
      ],
      { MWF_FAILPOINT: 'write:target@4' },
    );
    assert.equal(crashed.signal, 'SIGKILL');
    const layout = layoutOf(ctx.root);
    const live = (id: string): string => join(ctx.root, `.mwf/memory/decisions/${id}.md`);
    // removals follow the (sorted) id order, so which record is still pending depends on the ids
    const pending = ids.filter((id) => existsSync(live(id)));
    assert.equal(pending.length, 1, 'one removal happened, the other is still pending');
    const stuck = pending[0]!;
    assert.ok(existsSync(layout.intent));

    // somebody edits the file that the interrupted forget meant to remove
    writeFileSync(live(stuck), readFileSync(live(stuck), 'utf8') + '\nhand-written addition\n');

    // the next writer recovers: it must NOT delete the changed file
    await core.reindex(ctx);
    assert.equal(existsSync(layout.intent), false, 'intent recovered');
    assert.match(readFileSync(live(stuck), 'utf8'), /hand-written addition/);

    const report = await core.doctor(ctx);
    const issue = report.issues.find((i) => i.code === 'rollforward_skipped');
    assert.ok(issue, 'doctor reports the skipped removal');
    assert.equal(issue.level, 'warn');
    assert.equal(issue.path, `.mwf/memory/decisions/${stuck}.md`);
    assert.match(issue.message, /forget/);
    assert.match(issue.message, /l1-req/);
    assert.equal(report.issues.filter((i) => i.code === 'rollforward_skipped').length, 1);

    // reported once per (request, path) even if recovery runs again; resolved once the file is gone
    await core.reindex(ctx);
    assert.equal(
      (await core.doctor(ctx)).issues.filter((i) => i.code === 'rollforward_skipped').length,
      1,
    );
    const again = (await core.forget(ctx, { ids: [stuck] })) as core.Preview<unknown>;
    await core.forget(ctx, { ids: [stuck], confirm: true, preview_token: again.preview_token });
    assert.equal(
      (await core.doctor(ctx)).issues.some((i) => i.code === 'rollforward_skipped'),
      false,
    );
  });

  it('an undisturbed roll-forward reports nothing', async () => {
    const ctx = await project('track', { waitMs: 5000, lockStaleMs: 300 });
    const a = await core.add(ctx, { type: 'task', title: 'One', body: 'one' });
    const b = await core.add(ctx, { type: 'task', title: 'Two', body: 'two' });
    const ids = [a.id, b.id];
    const preview = (await core.forget(ctx, { ids })) as core.Preview<unknown>;
    await runChild(
      ctx,
      [{ fn: 'forget', input: { ids, confirm: true, preview_token: preview.preview_token } }],
      { MWF_FAILPOINT: 'write:target@4' },
    );
    await core.reindex(ctx);
    const report = await core.doctor(ctx);
    assert.equal(
      report.issues.some((i) => i.code === 'rollforward_skipped'),
      false,
    );
    for (const id of ids) {
      assert.equal(existsSync(join(ctx.root, `.mwf/memory/tasks/${id}.md`)), false);
    }
  });
});

describe('L2: doctor reports a lock held too long', () => {
  it('flags a live lock older than lockHeldWarnMs, not a young one, and keeps the acquisition time across heartbeats', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    let now = 1_000_000;
    const handle = await acquireLock(layout, { waitMs: 0, staleMs: 30_000, now: () => now });
    const warn = (c: core.Ctx) =>
      core.doctor(c).then((d) => d.issues.filter((i) => i.code === 'lock_held_long'));

    assert.equal((await warn({ ...ctx, now: () => now + 60_000 })).length, 0, '60s < 120s default');
    now += 150_000;
    handle.heartbeat(true); // heartbeat is fresh, but the lock has been held for 150s
    const info = JSON.parse(readFileSync(layout.lock, 'utf8')) as {
      time: number;
      acquired: number;
    };
    assert.equal(info.time, 1_150_000);
    assert.equal(info.acquired, 1_000_000, 'acquired is never refreshed');
    const issues = await warn({ ...ctx, now: () => now });
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /150s/);
    assert.match(issues[0]!.message, new RegExp(`pid ${process.pid}`));
    assert.equal(issues[0]!.level, 'warn');
    // threshold is configurable
    assert.equal((await warn({ ...ctx, now: () => now, lockHeldWarnMs: 200_000 })).length, 0);
    assert.equal((await warn({ ...ctx, now: () => now, lockHeldWarnMs: 100_000 })).length, 1);
    handle.release();
    assert.equal((await warn({ ...ctx, now: () => now })).length, 0, 'released: nothing to report');
  });

  it('ignores locks written before the acquired field existed', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    writeFileSync(
      layout.lock,
      JSON.stringify({ pid: process.pid, host: hostname(), time: 1, token: 'old-format' }),
    );
    const report = await core.doctor({ ...ctx, now: () => 10_000_000 });
    assert.equal(
      report.issues.some((i) => i.code === 'lock_held_long'),
      false,
    );
  });
});

describe('L3: same hostname, different pid namespace', () => {
  const ns = pidNamespace();
  const holder = (extra: Record<string, unknown>, time: number) =>
    JSON.stringify({
      pid: process.pid, // alive here, but in the holder's own namespace it means nothing
      host: hostname(),
      time,
      acquired: time,
      token: 'other-ns-token',
      ...extra,
    });

  it('a holder in another pid namespace is treated like a foreign host: respected until its heartbeat is stale', async (t) => {
    if (ns === null) return t.skip('no /proc pid namespace on this platform');
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    const now = Date.now();
    writeFileSync(layout.lock, holder({ pidns: 'pid:[1]' }, now - 1000));
    const lock = inspectLock(layout, { staleMs: 30_000, now: () => now });
    assert.equal(lock.foreign, true);
    assert.equal(lock.stale, false);
    await assert.rejects(
      acquireLock(layout, { waitMs: 0, staleMs: 30_000 }),
      (e: { code?: string }) => e.code === 'LOCK_TIMEOUT',
    );
    const doc = await core.doctor(ctx);
    const issue = doc.issues.find((i) => i.code === 'foreign_host_lock');
    assert.ok(issue);
    assert.match(issue.message, /another pid namespace/);
    // heartbeat gone stale -> reclaimable
    writeFileSync(layout.lock, holder({ pidns: 'pid:[1]' }, now - 60_000));
    const handle = await acquireLock(layout, { waitMs: 0, staleMs: 30_000 });
    assert.equal(handle.reclaimed, true);
    handle.release();
  });

  it('the same namespace keeps the strict rule: a live holder is never reclaimed, however old', async (t) => {
    if (ns === null) return t.skip('no /proc pid namespace on this platform');
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    writeFileSync(layout.lock, holder({ pidns: ns, start: processStart(process.pid) }, 1));
    assert.equal(inspectLock(layout, { staleMs: 30_000 }).stale, false);
    await assert.rejects(
      acquireLock(layout, { waitMs: 0, staleMs: 30_000 }),
      (e: { code?: string }) => e.code === 'LOCK_TIMEOUT',
    );
  });

  it('known limit: without a recorded namespace (older mwf, no /proc) the holder is judged by its pid', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    writeFileSync(layout.lock, holder({}, Date.now()));
    assert.equal(inspectLock(layout, { staleMs: 30_000 }).foreign, false);
  });

  it('every lock this version writes records its pid namespace and acquisition time', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    const handle = await acquireLock(layout, { waitMs: 0 });
    const info = JSON.parse(readFileSync(layout.lock, 'utf8')) as Record<string, unknown>;
    assert.equal(info['acquired'], info['time']);
    if (ns !== null) assert.equal(info['pidns'], ns);
    assert.ok(readFileSync(layout.lock).length >= 512, 'padded for in-place heartbeats');
    handle.release();
  });
});

describe('L4: a write whose lock was lost is aborted', () => {
  it('assertLockHeld / beat throw LOCK_LOST once the lock belongs to someone else, and release leaves it alone', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    const handle = await acquireLock(layout, { waitMs: 0, staleMs: 40 });
    assertLockHeld(); // fine while ours
    steal(layout.lock);
    assert.throws(
      () => assertLockHeld(),
      (e: { code?: string }) => e.code === 'LOCK_LOST',
    );
    assert.equal(handle.lost, true);
    assert.throws(
      () => beat(),
      (e: { code?: string }) => e.code === 'LOCK_LOST',
    );
    handle.release();
    assert.equal(JSON.parse(readFileSync(layout.lock, 'utf8')).token, 'thief-token');
  });

  it('a vanished lock file counts as lost too', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    const handle = await acquireLock(layout, { waitMs: 0 });
    writeFileSync(layout.lock, '');
    assert.throws(
      () => assertLockHeld(),
      (e: { code?: string }) => e.code === 'LOCK_LOST',
    );
    handle.release();
  });

  it('the heartbeat timer notices a lost lock while an operation is awaiting; the next beat() aborts', async () => {
    const ctx = await project('track', { lockStaleMs: 80, waitMs: 0 });
    const layout = layoutOf(ctx.root);
    await assert.rejects(
      withLock(ctx, 0, async () => {
        steal(layout.lock);
        await new Promise((r) => setTimeout(r, 250)); // > several heartbeat intervals (80/4 = 20ms)
        beat();
      }),
      (e: { code?: string }) => e.code === 'LOCK_LOST',
    );
    assert.equal(JSON.parse(readFileSync(layout.lock, 'utf8')).token, 'thief-token', 'not removed');
  });

  for (const [label, stealAt] of [
    ['before the intent', 'lock:held'],
    ['after the intent, before the first target', 'write:intent'],
    ['between targets', 'write:target'],
  ] as const) {
    it(`runWrite stops ${label}; nothing more is written and a retry is exactly-once`, async () => {
      const ctx = await project('track', { waitMs: 3000, lockStaleMs: 300 });
      const layout = layoutOf(ctx.root);
      let fired = false;
      setFailpointHook((name) => {
        if (name === stealAt && !fired) {
          fired = true;
          steal(layout.lock);
        }
      });
      try {
        await assert.rejects(
          core.add(ctx, { type: 'decision', title: 'Lost lock', body: 'x', request_id: 'l4-req' }),
          (e: { code?: string }) => e.code === 'LOCK_LOST',
        );
      } finally {
        setFailpointHook(null);
      }
      assert.equal(fired, true);
      const records = readdirSync(join(ctx.root, '.mwf/memory/decisions'));
      assert.deepEqual(records, [], 'the record itself was never written');
      assert.equal(existsSync(layout.intent), stealAt !== 'lock:held', 'intent left for recovery');
      assert.equal(
        JSON.parse(readFileSync(layout.lock, 'utf8')).token,
        'thief-token',
        "we did not delete the new holder's lock",
      );
      // The thief is gone (its heartbeat is stale / it released): the next writer recovers and the
      // same request lands exactly once.
      writeFileSync(layout.lock, JSON.stringify({ ...THIEF, time: 1 }));
      const retry = await core.add(ctx, {
        type: 'decision',
        title: 'Lost lock',
        body: 'x',
        request_id: 'l4-req',
      });
      assert.equal(retry.deduped, false);
      assert.equal(readdirSync(join(ctx.root, '.mwf/memory/decisions')).length, 1);
      const report = await core.doctor(ctx);
      assert.deepEqual(
        report.issues.filter((i) => i.level !== 'info'),
        [],
      );
    });
  }
});
