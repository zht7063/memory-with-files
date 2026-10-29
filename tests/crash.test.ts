// kill -9 injection: the child SIGKILLs itself at every failpoint of the write path. After each
// kill we re-run the same request (same request_id) and assert the end state is exactly-once,
// clean (no .tmp-*, no intent, no lock), consistent (doctor ok, index == files) and registered.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as core from '../src/core/index.ts';
import { listTrash, openIndexReadOnly } from '../src/core/db.ts';
import { loadAll } from '../src/core/load.ts';
import { layoutOf } from '../src/core/paths.ts';
import { project, runChild } from './helpers/util.ts';

const FAILPOINTS = [
  'lock:created',
  'lock:written',
  'lock:held',
  'atomic:temp-synced',
  'atomic:renamed',
  'write:intent',
  'write:target',
  'write:indexed',
  'write:dedup',
  'write:done',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Every record/handoff file on disk parses; nothing half-written is visible under its final name. */
function assertNoPartialFiles(ctx: core.Ctx): void {
  const loaded = loadAll(layoutOf(ctx.root));
  assert.deepEqual(loaded.invalid, [], 'every visible file is complete');
}

/** Exactly `copies` trash file(s) per record id, and the index manifest lists the same set. */
function assertTrashManifest(ctx: core.Ctx, ids: string[], copies: number): void {
  const files = readdirSync(join(ctx.root, '.mwf/trash')).filter((f) => f.endsWith('.md'));
  for (const id of ids) {
    assert.equal(
      files.filter((f) => f.startsWith(`${id}.`)).length,
      copies,
      `${copies} trash cop${copies === 1 ? 'y' : 'ies'} of ${id}`,
    );
  }
  assert.equal(files.length, ids.length * copies, 'no stray trash files');
  const db = openIndexReadOnly(layoutOf(ctx.root));
  assert.ok(db);
  try {
    const rows = listTrash(db)
      .map((r) => `${r.trash_id}.md`)
      .sort();
    assert.deepEqual(rows, [...files].sort(), 'trash manifest == trash directory');
  } finally {
    db.close();
  }
}

async function assertClean(ctx: core.Ctx): Promise<void> {
  const mwf = join(ctx.root, '.mwf');
  const files = walk(mwf);
  assert.deepEqual(
    files.filter((f) => /\.tmp-/.test(f)),
    [],
    'no temp files',
  );
  assert.equal(existsSync(join(mwf, 'mwf.local.intent.json')), false, 'no intent left');
  assert.equal(existsSync(join(mwf, 'mwf.local.lock')), false, 'no lock left');
  assert.equal(existsSync(join(mwf, 'mwf.local.lock.reclaim')), false, 'no reclaim guard left');
  const doc = await core.doctor(ctx);
  assert.deepEqual(
    doc.issues.filter((i) => i.level !== 'info'),
    [],
    'doctor is clean',
  );
  assert.equal(doc.index.mismatches, 0);
  // index.md is part of every write's intent: after recovery it matches the records exactly
  assert.ok(!doc.issues.some((i) => i.code === 'index_md_stale'), 'index.md is current');
}

interface Scenario {
  name: string;
  /** records created before the crashed call (not under test) */
  setup?: (ctx: core.Ctx) => Promise<void>;
  call: (ctx: core.Ctx) => Promise<{ fn: string; input: unknown }>;
  verify: (ctx: core.Ctx, result: Record<string, unknown>) => Promise<void>;
}

const REQ = 'crash-test-request-0001';
// a recovery run must not wait for the 30s age limit of a lock left by a SIGKILLed process
const RECOVERY_CTX = { waitMs: 5000, lockStaleMs: 300 };

const scenarios: Scenario[] = [
  {
    name: 'add',
    call: async () => ({
      fn: 'add',
      input: {
        type: 'decision',
        title: 'Crash add',
        body: 'body of the crash test',
        request_id: REQ,
      },
    }),
    verify: async (ctx, result) => {
      const files = walk(join(ctx.root, '.mwf/memory')).filter((f) => f.endsWith('.md'));
      assert.equal(files.length, 1, 'exactly one record');
      const id = result['id'] as string;
      assert.ok(files[0]?.endsWith(`${id}.md`), 'deterministic id from request_id');
      assert.equal((await core.recall(ctx, { query: 'crash test' })).hits.length, 1);
    },
  },
  {
    name: 'edit',
    setup: async (ctx) => {
      await core.add(ctx, {
        type: 'knowledge',
        title: 'E',
        body: 'before edit',
        request_id: 'setup-edit-1',
      });
    },
    call: async (ctx) => {
      const rec = (await core.recall(ctx, { query: 'before edit' })).hits[0];
      assert.ok(rec);
      return {
        fn: 'edit',
        input: { id: rec.id, expected_hash: rec.hash, body: 'after edit', request_id: REQ },
      };
    },
    verify: async (ctx) => {
      const hits = (await core.recall(ctx, { query: 'after edit' })).hits;
      assert.equal(hits.length, 1);
      assert.equal(core.get(ctx, { id: hits[0]!.id }).body, 'after edit');
    },
  },
  {
    name: 'handoff.save',
    setup: async (ctx) => {
      await core.handoff(ctx, {
        action: 'save',
        task: 'tk',
        content: 'v1 body',
        request_id: 'setup-ho-1',
      });
    },
    call: async () => ({
      fn: 'handoff',
      input: { action: 'save', task: 'tk', content: 'v2 body', base_version: 1, request_id: REQ },
    }),
    verify: async (ctx, result) => {
      const h = core.readHandoffFile(ctx, 'tk');
      assert.equal(h.version, 2, 'version bumped exactly once');
      assert.equal(result['version'], 2);
      assert.equal(h.body.split('v2 body').length - 1, 1, 'content appended once');
    },
  },
  {
    name: 'forget (two targets: trash + removal)',
    setup: async (ctx) => {
      await core.add(ctx, {
        type: 'incident',
        title: 'F',
        body: 'to forget',
        request_id: 'setup-forget-1',
      });
    },
    call: async (ctx) => {
      const rec = (await core.recall(ctx, { query: 'to forget' })).hits[0];
      assert.ok(rec);
      const pre = (await core.forget(ctx, { ids: [rec.id] })) as core.Preview<unknown>;
      return {
        fn: 'forget',
        input: { ids: [rec.id], confirm: true, preview_token: pre.preview_token, request_id: REQ },
      };
    },
    verify: async (ctx, _result) => {
      assert.equal(
        (await core.recall(ctx, { query: 'to forget', status: 'all' })).hits.length,
        0,
        'no live copy',
      );
      const trash = (await core.restore(ctx)) as { entries: unknown[] };
      assert.equal(trash.entries.length, 1, 'exactly one trash entry');
    },
  },
  {
    name: 'forget (3 records: 3 trash copies + 3 removals)',
    setup: async (ctx) => {
      for (const n of ['a', 'b', 'c'])
        await core.add(ctx, {
          type: 'incident',
          title: `F${n}`,
          body: `multi forget ${n}`,
          request_id: `setup-mf-${n}`,
        });
    },
    call: async (ctx) => {
      const ids = (await core.recall(ctx, { query: 'multi forget' })).hits.map((h) => h.id).sort();
      assert.equal(ids.length, 3);
      const pre = (await core.forget(ctx, { ids })) as core.Preview<unknown>;
      return {
        fn: 'forget',
        input: { ids, confirm: true, preview_token: pre.preview_token, request_id: REQ },
      };
    },
    verify: async (ctx, result) => {
      assert.equal(
        (await core.recall(ctx, { query: 'multi forget', status: 'all' })).hits.length,
        0,
        'no live copy',
      );
      const forgotten = result['forgotten'] as Array<{ id: string; trash_id: string }>;
      assert.equal(forgotten.length, 3);
      assertTrashManifest(
        ctx,
        forgotten.map((f) => f.id),
        1,
      );
    },
  },
  {
    name: 'compact (2 groups: scope merge + trash + removal)',
    setup: async (ctx) => {
      let i = 0;
      for (const g of ['x', 'y']) {
        for (const dir of ['p', 'q']) {
          await core.add(ctx, {
            type: 'knowledge',
            title: `Dup ${g}`,
            body: `identical body ${g}`,
            scope: { paths: [`${g}/${dir}/`] },
            request_id: `setup-cp-${g}${dir}${i++}`,
          });
        }
      }
    },
    call: async (ctx) => {
      const pre = (await core.compact(ctx)) as core.Preview<unknown>;
      assert.equal(pre.affected.length, 2);
      return {
        fn: 'compact',
        input: { confirm: true, preview_token: pre.preview_token, request_id: REQ },
      };
    },
    verify: async (ctx, result) => {
      const live = (await core.recall(ctx, { query: 'identical body', status: 'all' })).hits;
      assert.equal(live.length, 2, 'one survivor per group');
      for (const h of live) {
        const g = h.title.endsWith('x') ? 'x' : 'y';
        assert.deepEqual(
          core.get(ctx, { id: h.id }).scope,
          { paths: [`${g}/p/`, `${g}/q/`] },
          'scopes merged',
        );
      }
      assertTrashManifest(ctx, result['trashed'] as string[], 1);
      assert.equal((result['trashed'] as string[]).length, 2);
    },
  },
  {
    name: 'purge (3 trash entries removed)',
    setup: async (ctx) => {
      const ids: string[] = [];
      for (const n of ['a', 'b', 'c'])
        ids.push(
          (
            await core.add(ctx, {
              type: 'task',
              title: `P${n}`,
              body: `purge me ${n}`,
              request_id: `setup-pg-${n}`,
            })
          ).id,
        );
      const pre = (await core.forget(ctx, { ids })) as core.Preview<unknown>;
      await core.forget(ctx, {
        ids,
        confirm: true,
        preview_token: pre.preview_token,
        request_id: 'setup-pg-forget',
      });
    },
    call: async (ctx) => {
      const ids = (
        (await core.restore(ctx)) as { entries: Array<{ trash_id: string }> }
      ).entries.map((e) => e.trash_id);
      assert.equal(ids.length, 3);
      const pre = (await core.purge(ctx, { ids })) as core.Preview<unknown>;
      return {
        fn: 'purge',
        input: { ids, confirm: true, preview_token: pre.preview_token, request_id: REQ },
      };
    },
    verify: async (ctx) => {
      assert.deepEqual(walk(join(ctx.root, '.mwf/trash')), [], 'trash is empty');
      assert.equal(
        ((await core.restore(ctx)) as { entries: unknown[] }).entries.length,
        0,
        'manifest is empty',
      );
    },
  },
  {
    name: 'inbox discard (preview_token + confirm, 2 of 3 entries)',
    setup: async (ctx) => {
      for (const t of ['one', 'two', 'three'])
        await core.propose(ctx, { text: `idea ${t}`, request_id: `setup-ib-${t}` });
    },
    call: async (ctx) => {
      const list = (await core.inbox(ctx)) as { entries: Array<{ id: string; text: string }> };
      const entry_ids = list.entries.filter((e) => !e.text.includes('three')).map((e) => e.id);
      assert.equal(entry_ids.length, 2);
      const pre = (await core.inbox(ctx, {
        action: 'discard',
        entry_ids,
      })) as core.Preview<unknown>;
      return {
        fn: 'inbox',
        input: {
          action: 'discard',
          entry_ids,
          confirm: true,
          preview_token: pre.preview_token,
          request_id: REQ,
        },
      };
    },
    verify: async (ctx) => {
      const list = (await core.inbox(ctx)) as { total: number; entries: Array<{ text: string }> };
      assert.equal(list.total, 1);
      assert.match(list.entries[0]?.text ?? '', /idea three/);
    },
  },
];

/** Kill at the n-th hit of fp; returns false when the call finished without reaching it. */
async function crashAndRecover(scenario: Scenario, fp: string, n: number): Promise<boolean> {
  const ctx = await project();
  await scenario.setup?.(ctx);
  const call = await scenario.call(ctx);
  const child = await runChild(ctx, [call], { MWF_FAILPOINT: `${fp}@${n}` });
  if (child.signal !== 'SIGKILL') {
    assert.equal(child.code, 0, child.stderr);
    return false;
  }
  // what a concurrent / later reader sees right after the crash is never partial
  assertNoPartialFiles(ctx);
  // recover: the very same request, retried
  const retry = await runChild({ ...ctx, ...RECOVERY_CTX }, [call]);
  assert.equal(retry.code, 0, `${retry.stderr} ${JSON.stringify(retry.results)}`);
  const result = retry.results[0] as Record<string, unknown>;
  assert.equal(result['request_id'], REQ);
  await assertClean(ctx);
  await scenario.verify(ctx, result);
  // the request is registered: replaying it again is a pure dedup and changes nothing
  const again = await runChild({ ...ctx, ...RECOVERY_CTX }, [call]);
  assert.equal((again.results[0] as Record<string, unknown>)['deduped'], true);
  await scenario.verify(ctx, result);
  return true;
}

describe('kill -9 at every failpoint of the write path', () => {
  for (const scenario of scenarios) {
    for (const fp of FAILPOINTS) {
      it(`${scenario.name} @ ${fp}`, async () => {
        let hits = 0;
        // sweep n = 1, 2, ... until the call completes without reaching the n-th hit
        while (hits < 12 && (await crashAndRecover(scenario, fp, hits + 1))) hits++;
        assert.ok(hits >= 1, `failpoint ${fp} was never reached`);
        assert.ok(hits < 12, `failpoint ${fp} kept firing`);
      });
    }
  }
});

describe('recovery rules', () => {
  it('a crash after the record rename but before dedup registration completes the registration (no rewrite)', async () => {
    const ctx = await project();
    const call = {
      fn: 'add',
      input: { type: 'task', title: 'T', body: 'recover me', request_id: REQ },
    };
    const killed = await runChild(ctx, [call], { MWF_FAILPOINT: 'write:indexed' });
    assert.equal(killed.signal, 'SIGKILL');
    assert.ok(existsSync(join(ctx.root, '.mwf/mwf.local.intent.json')));
    // any later writer (even for something else) recovers the leftover intent first
    const other = await runChild({ ...ctx, ...RECOVERY_CTX }, [
      { fn: 'add', input: { type: 'task', title: 'Other', body: 'x' } },
    ]);
    assert.equal(other.code, 0, other.stderr);
    assert.equal(existsSync(join(ctx.root, '.mwf/mwf.local.intent.json')), false);
    const state = readFileSync(join(ctx.root, '.mwf/dedup.local.toml'), 'utf8');
    assert.match(state, new RegExp(`\\[dedup\\.${REQ}\\]`));
    const retry = await runChild(ctx, [call]);
    assert.equal((retry.results[0] as Record<string, unknown>)['deduped'], true);
  });

  it('a crash before the record exists discards the intent; the retry performs the write', async () => {
    const ctx = await project();
    const call = {
      fn: 'add',
      input: { type: 'task', title: 'T', body: 'not yet written', request_id: REQ },
    };
    const killed = await runChild(ctx, [call], { MWF_FAILPOINT: 'write:intent' });
    assert.equal(killed.signal, 'SIGKILL');
    const retry = await runChild({ ...ctx, ...RECOVERY_CTX }, [call]);
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal((retry.results[0] as Record<string, unknown>)['deduped'], false);
    assert.equal((await core.recall(ctx, { query: 'not yet written' })).hits.length, 1);
  });

  it('doctor reports a temp file and a pending intent left by a crash, before anything repairs them', async () => {
    const ctx = await project();
    const call = { fn: 'add', input: { type: 'task', title: 'T', body: 'x', request_id: REQ } };
    await runChild(ctx, [call], { MWF_FAILPOINT: 'atomic:temp-synced' });
    const d1 = await core.doctor(ctx);
    assert.ok(d1.issues.some((i) => i.code === 'temp_leftover'));
    await runChild({ ...ctx, ...RECOVERY_CTX }, [call]);
    const d2 = await core.doctor(ctx);
    assert.equal(d2.temp_files.length, 0);
    await runChild(ctx, [{ ...call, input: { ...call.input, request_id: 'another-1' } }], {
      MWF_FAILPOINT: 'write:target',
    });
    const d3 = await core.doctor(ctx);
    assert.ok(d3.issues.some((i) => i.code === 'pending_intent'));
  });
});
