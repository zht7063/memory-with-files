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
import { acquireLock, inspectLock } from '../src/core/lock.ts';
import { layoutOf } from '../src/core/paths.ts';
import { DEDUP_MAX_ENTRIES, emptyState, pruneDedup } from '../src/core/state.ts';
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

  it('reclaims a lock older than the stale age (live pid on another host); keeps a fresh one', async () => {
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

  it('a live same-host holder is respected even when old, until the age limit', async () => {
    const ctx = await project();
    const layout = layoutOf(ctx.root);
    const now = 5_000_000;
    writeFileSync(
      layout.lock,
      JSON.stringify({ pid: process.pid, host: hostname(), time: now - 10_000, token: 't' }),
    );
    await assert.rejects(
      acquireLock(layout, { waitMs: 0, now: () => now }),
      (e: { code?: string }) => e.code === 'LOCK_TIMEOUT',
    );
    const h = await acquireLock(layout, { waitMs: 0, now: () => now + 25_000 }); // 35s old
    assert.equal(h.reclaimed, true);
    h.release();
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
    const state = emptyState();
    const now = 10 * 24 * 3600_000;
    for (let i = 0; i < 1200; i++) {
      state.dedup[`r${i}`] = { at: now - (1200 - i), op: 'add', fingerprint: 'f', result: '{}' };
    }
    state.dedup['old'] = { at: now - 25 * 3600_000, op: 'add', fingerprint: 'f', result: '{}' };
    pruneDedup(state, now);
    const keys = Object.keys(state.dedup);
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
