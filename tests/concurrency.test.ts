import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as core from '../src/core/index.ts';
import { loadAll } from '../src/core/load.ts';
import { acquireLock, beat, inspectLock, processStart } from '../src/core/lock.ts';
import { withLock } from '../src/core/write.ts';
import { layoutOf } from '../src/core/paths.ts';
import { DEDUP_MAX_ENTRIES, pruneDedup, type DedupEntry } from '../src/core/state.ts';
import { project, runChild } from './helpers/util.ts';

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => child.on('close', r));
  assert.ok(child.pid);
  return child.pid;
}

describe('multi-process concurrent writes', () => {
  it('N processes adding / editing / saving handoffs lose nothing and leave a consistent store', async () => {
    const ctx = await project('track', { waitMs: 30_000 });
    const WRITERS = 6;
    const PER = 10;
    const handoffSavers = 4;
    const jobs: Array<Promise<Awaited<ReturnType<typeof runChild>>>> = [];
    for (let w = 0; w < WRITERS; w++) {
      const calls = Array.from({ length: PER }, (_, i) => ({
        fn: 'add',
        input: {
          type: 'knowledge',
          title: `w${w} item ${i}`,
          body: `body from writer ${w} number ${i} ${'z'.repeat(2000)}`,
        },
      }));
      jobs.push(runChild(ctx, calls));
    }
    for (let h = 0; h < handoffSavers; h++) {
      jobs.push(
        runChild(ctx, [
          {
            fn: 'handoff',
            input: { action: 'save', task: 'shared', content: `saver ${h} first`, base_version: 0 },
          },
          {
            fn: 'handoff',
            input: { action: 'save', task: 'shared', content: `saver ${h} second` },
          },
        ]),
      );
    }
    const results = await Promise.all(jobs);
    for (const r of results) assert.equal(r.code, 0, `${r.stderr} ${JSON.stringify(r.results)}`);

    const loaded = loadAll(layoutOf(ctx.root));
    assert.deepEqual(loaded.invalid, []);
    assert.equal(loaded.records.length, WRITERS * PER, 'every add landed exactly once');
    assert.equal(new Set(loaded.records.map((r) => r.doc.id)).size, WRITERS * PER);

    // handoff: version == number of saves (no lost update); every body survived (never overwritten)
    const h = core.readHandoffFile(ctx, 'shared');
    assert.equal(h.version, handoffSavers * 2);
    for (let i = 0; i < handoffSavers; i++) {
      assert.match(h.body, new RegExp(`saver ${i} first`));
      assert.match(h.body, new RegExp(`saver ${i} second`));
    }

    const doc = await core.doctor(ctx);
    assert.deepEqual(
      doc.issues.filter((i) => i.level !== 'info'),
      [],
    );
    assert.equal(doc.index.mismatches, 0);
    assert.equal((await core.status(ctx)).index.in_sync, true);
    const mwf = join(ctx.root, '.mwf');
    assert.equal(existsSync(join(mwf, 'mwf.local.lock')), false);
    assert.equal(existsSync(join(mwf, 'mwf.local.intent.json')), false);
  });

  it('concurrent edits of one record with the same expected_hash: exactly one wins, the rest get HASH_MISMATCH', async () => {
    const ctx = await project('track', { waitMs: 30_000 });
    const r = await core.add(ctx, { type: 'knowledge', title: 'Contended', body: 'start' });
    const runs = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        runChild(ctx, [
          { fn: 'edit', input: { id: r.id, expected_hash: r.hash, body: `writer ${i}` } },
        ]),
      ),
    );
    const ok = runs.filter((x) => x.code === 0);
    const bad = runs.filter((x) => x.code !== 0);
    assert.equal(ok.length, 1);
    for (const b of bad)
      assert.equal((b.results[0] as { error: { code: string } }).error.code, 'HASH_MISMATCH');
    assert.match(core.get(ctx, { id: r.id }).body, /^writer \d$/);
  });

  it('readers never see partial data while a writer rewrites a large record', async () => {
    const ctx = await project('track', { waitMs: 30_000 });
    const mk = (v: number): string =>
      Array.from({ length: 400 }, () => `version-${v} ${'line '.repeat(20)}`).join('\n');
    const r = await core.add(ctx, { type: 'knowledge', title: 'Big', body: mk(0) });
    const file = join(ctx.root, '.mwf/memory/knowledge', `${r.id}.md`);

    // writer: 40 sequential edits, each a different big body (hash chain done in the child)
    const script = `
      import * as core from ${JSON.stringify(new URL('../src/core/index.ts', import.meta.url).href)};
      const ctx = ${JSON.stringify(ctx)};
      const mk = (v) => Array.from({ length: 400 }, () => 'version-' + v + ' ' + 'line '.repeat(20)).join('\\n');
      process.stdout.write('go');
      for (let v = 1; v <= 60; v++) {
        const cur = core.get(ctx, { id: ${JSON.stringify(r.id)} });
        await core.edit(ctx, { id: ${JSON.stringify(r.id)}, expected_hash: cur.hash, body: mk(v) });
      }
    `;
    const writer = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let err = '';
    const started = new Promise<void>((res) => writer.stdout.once('data', () => res()));
    writer.stderr.on('data', (d: Buffer) => (err += d.toString()));
    let done = false;
    const exited = new Promise<number | null>((res) =>
      writer.on('close', (c) => {
        done = true;
        res(c);
      }),
    );
    await started; // only start reading once the writer is about to begin editing
    let reads = 0;
    const seen = new Set<string>();
    while (!done) {
      // 1. raw file reads (cheap, many): complete frontmatter + a body of one single version
      for (let i = 0; i < 25; i++) {
        const text = readFileSync(file, 'utf8');
        assert.match(text, /^---\n[\s\S]*?\n---\n/);
        const versions = new Set([...text.matchAll(/version-(\d+) /g)].map((m) => m[1]));
        assert.equal(versions.size, 1, 'file contains exactly one version');
        seen.add([...versions][0]!);
        reads++;
      }
      // 2. API reads (the index may be repaired under a short lock)
      const got = core.get(ctx, { id: r.id });
      assert.equal(new Set([...got.body.matchAll(/version-(\d+) /g)].map((m) => m[1])).size, 1);
      const hits = await core.recall(ctx, { query: 'version' });
      assert.ok(hits.hits.length <= 1);
      await new Promise((r) => setTimeout(r, 1)); // let the child's exit event through
    }
    assert.equal(await exited, 0, err);
    assert.ok(reads > 3 && seen.size > 1, `observed ${seen.size} versions over ${reads} reads`);
    assert.match(core.get(ctx, { id: r.id }).body, /version-60 /);
    assert.deepEqual(
      readdirSync(join(ctx.root, '.mwf/memory/knowledge')).filter((f) => f.includes('.tmp-')),
      [],
    );
  });
});

describe('lock', () => {
  it('times out with LOCK_TIMEOUT when a live holder keeps the lock', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    const held = await acquireLock(layout, { waitMs: 0 });
    try {
      assert.equal(inspectLock(layout).held, true);
      const t0 = Date.now();
      await assert.rejects(
        core.add({ ...ctx, waitMs: 150 }, { type: 'task', title: 'x', body: 'y' }),
        (e: { code?: string }) => {
          assert.equal(e.code, 'LOCK_TIMEOUT');
          return true;
        },
      );
      assert.ok(Date.now() - t0 >= 140 && Date.now() - t0 < 3000);
      // per-call wait budget wins over ctx default
      await assert.rejects(
        core.add(ctx, { type: 'task', title: 'x', body: 'y', wait_ms: 50 }),
        (e: { code?: string }) => e.code === 'LOCK_TIMEOUT',
      );
    } finally {
      held.release();
    }
    assert.equal(inspectLock(layout).held, false);
    await core.add(ctx, { type: 'task', title: 'x', body: 'y' });
  });

  it('reclaims a lock whose holder pid is dead, immediately', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    writeFileSync(
      layout.lock,
      JSON.stringify({ pid: await deadPid(), host: hostname(), time: Date.now(), token: 'dead' }),
    );
    assert.equal(inspectLock(layout).stale, true);
    const t0 = Date.now();
    await core.add({ ...ctx, waitMs: 2000 }, { type: 'task', title: 'x', body: 'y' });
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(existsSync(layout.lock), false);
  });

  it('foreign hostname: reclaimed by staleness only (pid is meaningless there); a fresh one is respected', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    let now = 1_000_000;
    writeFileSync(
      layout.lock,
      JSON.stringify({ pid: process.pid, host: 'some-other-host', time: now - 29_000, token: 't' }),
    );
    await assert.rejects(
      acquireLock(layout, { waitMs: 0, now: () => now }),
      (e: { code?: string }) => e.code === 'LOCK_TIMEOUT',
    );
    now += 2_000; // now 31s old
    const handle = await acquireLock(layout, { waitMs: 0, now: () => now });
    assert.equal(handle.reclaimed, true);
    handle.release();
    assert.equal(existsSync(layout.lock), false);
  });

  it('never reclaims a live same-host holder, however old the lock is', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    const now = Date.now();
    const lock = {
      pid: process.pid,
      host: hostname(),
      time: now - 24 * 3600_000, // a day old
      token: 't',
      start: processStart(process.pid) ?? undefined,
    };
    writeFileSync(layout.lock, JSON.stringify(lock));
    const state = inspectLock(layout, { staleMs: 30_000, now: () => now });
    assert.equal(state.stale, false);
    assert.equal(state.reason, null);
    for (const at of [now, now + 31_000, now + 7 * 24 * 3600_000]) {
      await assert.rejects(
        acquireLock(layout, { waitMs: 0, now: () => at }),
        (e: { code?: string }) => e.code === 'LOCK_TIMEOUT',
      );
    }
    // same for a lock written before the `start` field existed (plain liveness fallback)
    writeFileSync(layout.lock, JSON.stringify({ ...lock, start: undefined }));
    await assert.rejects(
      acquireLock(layout, { waitMs: 0, now: () => now + 3600_000 }),
      (e: { code?: string }) => e.code === 'LOCK_TIMEOUT',
    );
    assert.ok(existsSync(layout.lock));
  });

  it('a second process does not take a lock held by a live process past the stale age', async () => {
    const ctx = await project('track', { lockStaleMs: 150 });
    const layout = layoutOf(ctx.root);
    const script = `
      import { acquireLock } from ${JSON.stringify(new URL('../src/core/lock.ts', import.meta.url).href)};
      const h = await acquireLock(${JSON.stringify(layout)}, { waitMs: 0 });
      process.stdout.write('held');
      await new Promise((r) => setTimeout(r, 1500)); // no heartbeat: lock "time" goes far past staleMs
      h.release();
    `;
    const holder = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const exited = new Promise((res) => holder.on('close', res));
    await new Promise<void>((res) => holder.stdout.once('data', () => res()));
    await new Promise((r) => setTimeout(r, 400)); // > 2x staleMs
    assert.equal(inspectLock(layout, { staleMs: 150 }).stale, false);
    const t0 = Date.now();
    const second = await runChild({ ...ctx, waitMs: 500, lockStaleMs: 150 }, [
      { fn: 'add', input: { type: 'task', title: 'blocked', body: 'x' } },
    ]);
    assert.equal(second.code, 1);
    assert.equal((second.results[0] as { error: { code: string } }).error.code, 'LOCK_TIMEOUT');
    assert.ok(Date.now() - t0 >= 450);
    assert.equal(loadAll(layout).records.length, 0, 'second process wrote nothing');
    await exited; // holder released normally
    const third = await runChild(ctx, [
      { fn: 'add', input: { type: 'task', title: 'ok', body: 'x' } },
    ]);
    assert.equal(third.code, 0, third.stderr);
  });

  it('reclaims when the pid is alive but is a different process (start time mismatch = pid reuse)', async (t) => {
    if (processStart(process.pid) === null) return t.skip('no /proc start time on this platform');
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    writeFileSync(
      layout.lock,
      JSON.stringify({
        pid: process.pid, // alive, but not the process that took the lock
        host: hostname(),
        time: Date.now(),
        token: 'old-owner',
        start: 'boot:1', // recorded start time differs from the live process
      }),
    );
    const state = inspectLock(layout);
    assert.equal(state.reason, 'pid-reused');
    const h = await acquireLock(layout, { waitMs: 0 });
    assert.equal(h.reclaimed, true);
    h.release();
    assert.equal(existsSync(layout.lock), false);
    // the lock a live process takes records its own start time
    const own = await acquireLock(layout, { waitMs: 0 });
    assert.equal(own.info.start, processStart(process.pid));
    own.release();
  });

  it('parses /proc/<pid>/stat start time robustly (comm with spaces / parentheses)', (t) => {
    const a = processStart(process.pid);
    if (a === null) return t.skip('no /proc start time on this platform');
    assert.equal(processStart(process.pid), a); // stable
    assert.equal(processStart(2 ** 22 + 12345), null); // no such process
    assert.match(a, /:\d+$/);
  });

  it('heartbeat refreshes the lock time (throttled) and never touches a lock it lost', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    let now = 1_000_000;
    const h = await acquireLock(layout, { waitMs: 0, staleMs: 1000, now: () => now });
    const time = (): number => JSON.parse(readFileSync(layout.lock, 'utf8')).time;
    assert.equal(time(), 1_000_000);
    now += 100;
    beat();
    assert.equal(time(), 1_000_000, 'throttled: less than staleMs/4 since the last beat');
    now += 400;
    beat();
    assert.equal(time(), 1_000_500);
    now += 10;
    assert.equal(h.heartbeat(true), true);
    assert.equal(time(), 1_000_510, 'force bypasses the throttle');
    // another owner took over: we must not overwrite its lock
    const foreign = JSON.stringify({ pid: 1, host: 'x', time: 5, token: 'someone-else' });
    writeFileSync(layout.lock, foreign);
    now += 5000;
    assert.equal(h.heartbeat(true), false);
    assert.equal(readFileSync(layout.lock, 'utf8'), foreign);
    h.release();
  });

  it('a long async operation keeps heartbeating so a foreign-host stale check never fires', async () => {
    const ctx = await project('track', { lockStaleMs: 120, waitMs: 0 });
    const layout = layoutOf(ctx.root);
    const times = new Set<number>();
    const op = withLock(ctx, 0, async () => {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 50));
        times.add(JSON.parse(readFileSync(layout.lock, 'utf8')).time);
      }
    });
    await op;
    assert.ok(times.size >= 3, `lock time advanced ${times.size} times during a 600ms op`);
    const first = Math.min(...times);
    const last = Math.max(...times);
    assert.ok(last - first >= 300);
  });

  it('foreign hostname: a fresh lock is respected even if its pid does not exist here; doctor reports it', async () => {
    const dead = await deadPid();
    const t = Date.now();
    const ctx = await project('track', { lockStaleMs: 30_000, now: () => t });
    const layout = layoutOf(ctx.root);
    writeFileSync(
      layout.lock,
      JSON.stringify({ pid: dead, host: 'other-box', time: t - 1000, token: 'f' }),
    );
    assert.equal(inspectLock(layout, { now: () => t }).stale, false);
    await assert.rejects(
      acquireLock(layout, { waitMs: 0, now: () => t }),
      (e: { code?: string }) => e.code === 'LOCK_TIMEOUT',
    );
    let doc = await core.doctor(ctx);
    const fresh = doc.issues.find((i) => i.code === 'foreign_host_lock');
    assert.ok(fresh, 'doctor reports a lock held from another host');
    assert.match(fresh.message, /other-box/);
    assert.match(fresh.message, /respected/);
    const st = await core.status(ctx);
    assert.equal(st.lock.foreign_host, true);
    assert.equal(st.lock.held, true);
    // once its heartbeat is older than the stale age doctor says it will be reclaimed
    const later = { ...ctx, now: () => t + 31_000 };
    doc = await core.doctor(later);
    assert.match(doc.issues.find((i) => i.code === 'foreign_host_lock')?.message ?? '', /reclaim/);
    // and a writer actually reclaims it
    await core.add(later, { type: 'task', title: 'after reclaim', body: 'x' });
    assert.equal(existsSync(layout.lock), false);
  });

  it('doctor reports a dead same-host holder as stale_lock (not foreign)', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    writeFileSync(
      layout.lock,
      JSON.stringify({ pid: await deadPid(), host: hostname(), time: Date.now(), token: 'd' }),
    );
    const doc = await core.doctor(ctx);
    assert.ok(doc.issues.some((i) => i.code === 'stale_lock'));
    assert.ok(!doc.issues.some((i) => i.code === 'foreign_host_lock'));
  });

  it("reclaim guard: a guard left by a dead reclaimer is cleaned up; a live reclaimer's guard is never deleted", async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    const deadLock = {
      pid: await deadPid(),
      host: hostname(),
      time: Date.now(),
      token: 'dead-lock',
    };
    // dead reclaimer left its guard behind, plus a dead lock holder
    writeFileSync(layout.lock, JSON.stringify(deadLock));
    writeFileSync(layout.lockGuard, JSON.stringify({ ...deadLock, token: 'dead-guard' }));
    const h = await acquireLock(layout, { waitMs: 2000 });
    assert.equal(h.reclaimed, true);
    assert.equal(existsSync(layout.lockGuard), false);
    h.release();
    // a guard held by a LIVE process (mid-reclaim) is kept untouched, and we time out
    writeFileSync(layout.lock, JSON.stringify(deadLock));
    const live = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      time: 1,
      token: 'live-guard',
      start: processStart(process.pid) ?? undefined,
    });
    writeFileSync(layout.lockGuard, live);
    await assert.rejects(
      acquireLock(layout, { waitMs: 150 }),
      (e: { code?: string }) => e.code === 'LOCK_TIMEOUT',
    );
    assert.equal(readFileSync(layout.lockGuard, 'utf8').trimEnd(), live.trimEnd());
  });

  it('an empty lock file (holder died between create and write) is reclaimed by mtime age', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    writeFileSync(layout.lock, '');
    await assert.rejects(
      acquireLock(layout, { waitMs: 0, staleMs: 60_000 }),
      (e: { code?: string }) => e.code === 'LOCK_TIMEOUT',
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(layout.lock, old, old);
    const h = await acquireLock(layout, { waitMs: 0, staleMs: 60_000 });
    assert.equal(h.reclaimed, true);
    h.release();
  });

  it('release never removes a lock that someone else reclaimed', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    const a = await acquireLock(layout, { waitMs: 0 });
    writeFileSync(
      layout.lock,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        time: Date.now(),
        token: 'someone-else',
      }),
    );
    a.release();
    assert.equal(existsSync(layout.lock), true);
    assert.equal(JSON.parse(readFileSync(layout.lock, 'utf8')).token, 'someone-else');
  });

  it('many processes racing for a stale lock: it is reclaimed exactly once and all writes land', async () => {
    const ctx = await project('track', { waitMs: 30_000, lockStaleMs: 200 });
    const layout = layoutOf(ctx.root);
    writeFileSync(
      layout.lock,
      JSON.stringify({ pid: await deadPid(), host: hostname(), time: Date.now(), token: 'dead' }),
    );
    const runs = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        runChild(ctx, [{ fn: 'add', input: { type: 'task', title: `r${i}`, body: `race ${i}` } }]),
      ),
    );
    for (const r of runs) assert.equal(r.code, 0, r.stderr);
    assert.equal(loadAll(layout).records.length, 6);
  });
});

describe('request_id deduplication', () => {
  it('replaying a request_id returns the original result without writing again', async () => {
    const ctx = await project();
    const input = {
      type: 'decision' as const,
      title: 'Once',
      body: 'only once',
      request_id: 'req-dup-1',
    };
    const a = await core.add(ctx, input);
    const b = await core.add(ctx, input);
    assert.equal(a.deduped, false);
    assert.equal(b.deduped, true);
    assert.equal(b.id, a.id);
    assert.equal(loadAll(layoutOf(ctx.root)).records.length, 1);
    // dedup survives a process boundary
    const c = await runChild(ctx, [{ fn: 'add', input }]);
    assert.equal((c.results[0] as { deduped: boolean }).deduped, true);
    assert.equal(loadAll(layoutOf(ctx.root)).records.length, 1);
  });

  it('auto-generates a request_id when absent, and two requests do not collide', async () => {
    const ctx = await project();
    const a = await core.add(ctx, { type: 'task', title: 'Same', body: 'same' });
    const b = await core.add(ctx, { type: 'task', title: 'Same', body: 'same' });
    assert.notEqual(a.request_id, b.request_id);
    assert.notEqual(a.id, b.id);
    assert.equal(b.deduped, false);
  });

  it('rejects reuse of a request_id for a different request', async () => {
    const ctx = await project();
    await core.add(ctx, { type: 'task', title: 'A', body: 'a', request_id: 'req-x' });
    await assert.rejects(
      core.add(ctx, { type: 'task', title: 'B', body: 'b', request_id: 'req-x' }),
      (e: { code?: string }) => e.code === 'REQUEST_ID_REUSED',
    );
    await assert.rejects(
      core.propose(ctx, { text: 'a', request_id: 'req-x' }),
      (e: { code?: string }) => e.code === 'REQUEST_ID_REUSED',
    );
    assert.equal(loadAll(layoutOf(ctx.root)).records.length, 1);
  });

  it('entries expire after 24h (the request is executed again)', async () => {
    let t = Date.parse('2026-03-01T00:00:00Z');
    const ctx = await project('track', { now: () => t });
    const input = { type: 'task' as const, title: 'T', body: 'b', request_id: 'req-ttl' };
    await core.add(ctx, input);
    t += 23 * 3600_000;
    assert.equal((await core.add(ctx, input)).deduped, true);
    t += 2 * 3600_000;
    assert.equal((await core.add(ctx, input)).deduped, false);
  });

  it('pruneDedup keeps at most 1000 entries (newest first) and drops anything older than 24h', () => {
    const state: Record<string, DedupEntry> = {};
    const now = 10 * 24 * 3600_000;
    for (let i = 0; i < 1200; i++) {
      state[`r${i}`] = { at: now - (1200 - i), op: 'add', fingerprint: 'f', result: '{}' };
    }
    state['old'] = { at: now - 25 * 3600_000, op: 'add', fingerprint: 'f', result: '{}' };
    pruneDedup(state, now);
    const keys = Object.keys(state);
    assert.equal(keys.length, DEDUP_MAX_ENTRIES);
    assert.ok(!keys.includes('old'));
    assert.ok(keys.includes('r1199') && !keys.includes('r0'));
  });
});

describe('architecture', () => {
  it('core imports nothing from cli/mcp/hooks (layering)', () => {
    const dir = new URL('../src/core/', import.meta.url).pathname;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1]!;
        assert.ok(
          spec.startsWith('node:') || spec === '@iarna/toml' || /^\.\/[\w-]+\.ts$/.test(spec),
          `${f} imports ${spec}`,
        );
      }
    }
  });

  it('MWF_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    assert.equal(core.MWF_VERSION, pkg.version);
    assert.ok(statSync(new URL('../src/core/index.ts', import.meta.url)).isFile());
  });
});
