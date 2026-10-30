// Decisions settled after PR1: dedup.local.toml, secret scanning in runWrite, inbox discard as a
// destructive op, and index.md refreshed by every write (same lock / intent / recovery flow).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as core from '../src/core/index.ts';
import { loadAll } from '../src/core/load.ts';
import { buildIndexMd } from '../src/core/indexmd.ts';
import { layoutOf } from '../src/core/paths.ts';
import { scanSecrets } from '../src/core/secrets.ts';
import { project, runChild } from './helpers/util.ts';

async function rejects(p: Promise<unknown>, code: string): Promise<{ message?: string }> {
  let caught: { code?: string; message?: string } | undefined;
  await p.catch((e: { code?: string; message?: string }) => (caught = e));
  assert.ok(caught, `expected ${code}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}

const mwfFile = (ctx: core.Ctx, rel: string): string => join(ctx.root, '.mwf', rel);
const read = (ctx: core.Ctx, rel: string): string => readFileSync(mwfFile(ctx, rel), 'utf8');

// Fixtures are assembled at runtime so no credential-shaped literal sits in the repository.
const j = (...parts: string[]): string => parts.join('');
const rep = (c: string, n: number): string => c.repeat(n);
const MIXED = 'a1B2c3D4e5F6g7H8i9J0kLmN'; // random-looking, with letters and digits
const SECRETS: Record<string, string> = {
  'private-key': j('-----BEGIN RSA ', 'PRIV', 'ATE KEY-----\nMIIE'),
  'aws-access-key-id': j('AK', 'IA', 'IOSFODNN7EXAMPLE'),
  'aws-secret-access-key': j('aws_secret', '_access_key = ', rep('A', 20), rep('b', 20)),
  'github-token': j('gh', 'p_', rep('a', 36)),
  'github-fine-grained-token': j('github', '_pat_', rep('A', 30)),
  'gitlab-token': j('gl', 'pat-', rep('x', 24)),
  'slack-token': j('xo', 'xb-', '1234567890-abcdefghij'),
  'slack-webhook': j('https://hooks.slack', '.com/services/', 'T0123ABCD/B0123ABCD/', rep('z', 12)),
  'stripe-key': j('sk', '_live_', rep('q', 24)),
  'anthropic-key': j('sk', '-ant-', rep('k', 30)),
  'openai-key': j('sk', '-', rep('Z', 40)),
  'google-api-key': j('AI', 'za', rep('S', 35)),
  'sendgrid-key': j('SG', '.', rep('a', 22), '.', rep('b', 43)),
  'npm-token': j('npm', '_', rep('n', 36)),
  'huggingface-token': j('hf', '_', rep('h', 34)),
  jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', rep('s', 20)),
  'authorization-header': j('Authorization: Bearer ', MIXED, 'oPqR'),
  'url-credentials': j('postgres', '://admin:', 'Zx9kQ2mV7p', '@db.internal:5432/app'),
  'secret-assignment': j('API_', 'KEY = "', MIXED, '"'),
};

describe('dedup table lives in dedup.local.toml', () => {
  it('is written there (not in state.toml) and is covered by the .mwf/*.local.* ignore rule', async () => {
    const ctx = await project('track');
    await core.add(ctx, { type: 'task', title: 'T', body: 'b', request_id: 'req-loc-1' });
    assert.match(read(ctx, 'dedup.local.toml'), /\[dedup\.req-loc-1\]/);
    assert.doesNotMatch(read(ctx, 'state.toml'), /dedup/);
    // a replay is answered from the new file
    assert.equal(
      (await core.add(ctx, { type: 'task', title: 'T', body: 'b', request_id: 'req-loc-1' }))
        .deduped,
      true,
    );
    // git really ignores it in track mode (and not the shared state / records)
    execFileSync('git', ['init', '-q'], { cwd: ctx.root });
    const ignored = (rel: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', `.mwf/${rel}`], { cwd: ctx.root });
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(ignored('dedup.local.toml'), true);
    assert.equal(ignored('state.toml'), false);
    assert.equal(ignored('index.md'), false);
  });

  it('a corrupt dedup.local.toml does not block writes: treated as empty, doctor warns, next write replaces it', async () => {
    const ctx = await project();
    writeFileSync(mwfFile(ctx, 'dedup.local.toml'), 'this is = = not toml [');
    assert.ok((await core.doctor(ctx)).issues.some((i) => i.code === 'dedup_invalid'));
    await core.add(ctx, { type: 'task', title: 'T', body: 'b', request_id: 'req-fix' });
    assert.match(read(ctx, 'dedup.local.toml'), /\[dedup\.req-fix\]/);
    assert.ok(!(await core.doctor(ctx)).issues.some((i) => i.code === 'dedup_invalid'));
  });
});

describe('secret scanning (inside runWrite)', () => {
  for (const [rule, value] of Object.entries(SECRETS)) {
    it(`rejects ${rule}`, async () => {
      assert.ok(
        scanSecrets(`note\n${value}\n`).some((f) => f.rule === rule),
        `scanner finds ${rule}`,
      );
      const ctx = await project();
      const before = readdirSync(mwfFile(ctx, 'memory/decisions'));
      const err = await rejects(
        core.add(ctx, {
          type: 'decision',
          title: 'Deploy notes',
          body: `use this:\n${value}\nthanks`,
        }),
        'SECRET_DETECTED',
      );
      assert.ok(!(err.message ?? '').includes(value), 'the secret is never echoed back');
      assert.deepEqual(readdirSync(mwfFile(ctx, 'memory/decisions')), before);
      assert.equal(existsSync(mwfFile(ctx, 'mwf.local.intent.json')), false);
    });
  }

  it('reports rule, path and line (redacted sample) in error details', async () => {
    const ctx = await project();
    let details: { findings?: Array<Record<string, unknown>> } = {};
    await core
      .add(ctx, {
        type: 'knowledge',
        title: 'k',
        body: `line1\nline2 ${SECRETS['github-token']}`,
      })
      .catch((e: { details: typeof details }) => (details = e.details));
    const f = details.findings?.[0];
    assert.equal(f?.rule, 'github-token');
    assert.equal(Number(f?.line) > 0, true);
    assert.match(String(f?.path), /^\.mwf\/memory\/knowledge\/kn_/);
    assert.ok(!String(f?.sample).includes(SECRETS['github-token'] as string));
  });

  it('covers every write path: title, propose, handoff, edit, inbox accept', async () => {
    const ctx = await project();
    const secret = SECRETS['github-token'] as string;
    await rejects(
      core.add(ctx, { type: 'task', title: `t ${secret}`, body: 'b' }),
      'SECRET_DETECTED',
    );
    await rejects(core.propose(ctx, { text: `remember ${secret}` }), 'SECRET_DETECTED');
    await rejects(
      core.handoff(ctx, { action: 'save', task: 'tk', content: `x ${secret}` } as never),
      'SECRET_DETECTED',
    );
    assert.equal(existsSync(mwfFile(ctx, 'handoff/tk.md')), false);
    const rec = await core.add(ctx, { type: 'task', title: 'ok', body: 'fine' });
    const got = core.get(ctx, { id: rec.id });
    await rejects(
      core.edit(ctx, { id: rec.id, expected_hash: got.hash, body: `now ${secret}` }),
      'SECRET_DETECTED',
    );
    assert.equal(core.get(ctx, { id: rec.id }).body, 'fine');
    // an inbox entry that already holds a secret (hand-written) cannot be promoted to a record
    const inboxPath = mwfFile(ctx, 'inbox.md');
    writeFileSync(
      inboxPath,
      `${readFileSync(inboxPath, 'utf8')}\n## ib_aaaaaaaaaa | 2026-01-01T00:00:00.000Z | user\n\n${secret}\n`,
    );
    await rejects(
      core.inbox(ctx, { action: 'accept', entry_id: 'ib_aaaaaaaaaa', type: 'task', title: 'x' }),
      'SECRET_DETECTED',
    );
  });

  it('does not flag ordinary text or placeholders', async () => {
    const ctx = await project();
    const body = [
      'token budget: 20000 per request; max_tokens = 4096',
      'api_key: <your-api-key>',
      'password: changeme',
      'secret_key = "abcdefghijklmnop"',
      'export OPENAI_API_KEY=${OPENAI_API_KEY}',
      'pip install scikit-learn  # sk-learn-is-not-a-key',
      'postgres://user:password@localhost:5432/db',
      'https://example.com/path?x=1',
      'commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b',
      'Authorization: Bearer <token>',
    ].join('\n');
    const r = await core.add(ctx, { type: 'knowledge', title: 'Config notes', body });
    assert.match(core.get(ctx, { id: r.id }).body, /max_tokens/);
  });

  it('only INTRODUCED secrets are rejected: records that already contain one can still be edited elsewhere, forgotten, and purged', async () => {
    const ctx = await project();
    const secret = SECRETS['github-token'] as string;
    const rec = await core.add(ctx, { type: 'incident', title: 'Leak', body: 'clean body' });
    // simulate a legacy / hand-edited record that already contains a secret
    const path = mwfFile(ctx, `memory/incidents/${rec.id}.md`);
    writeFileSync(path, readFileSync(path, 'utf8').replace('clean body', `leaked ${secret}`));
    const cur = core.get(ctx, { id: rec.id });
    const edited = await core.edit(ctx, { id: rec.id, expected_hash: cur.hash, status: 'done' });
    assert.equal(edited.changed, true); // title/status edit keeps the old text: not "new"
    const pre = (await core.forget(ctx, { ids: [rec.id] })) as core.Preview<unknown>;
    await core.forget(ctx, { ids: [rec.id], confirm: true, preview_token: pre.preview_token });
    assert.equal(existsSync(path), false); // the way out of a leaked secret works
    const trash = readdirSync(mwfFile(ctx, 'trash')).filter((f) => f.endsWith('.md'));
    assert.equal(trash.length, 1); // trash copies are exempt from the scan
    const pp = (await core.purge(ctx, {})) as core.Preview<unknown> & { preview_token: string };
    assert.equal(pp.preview, true);
  });

  it('restore of a record that contains a secret stays rejected (nothing is restored)', async () => {
    const ctx = await project();
    const secret = SECRETS['github-token'] as string;
    const rec = await core.add(ctx, { type: 'incident', title: 'Leak', body: 'clean body' });
    const path = mwfFile(ctx, `memory/incidents/${rec.id}.md`);
    writeFileSync(path, readFileSync(path, 'utf8').replace('clean body', `leaked ${secret}`));
    const pre = (await core.forget(ctx, { ids: [rec.id] })) as core.Preview<unknown>;
    await core.forget(ctx, { ids: [rec.id], confirm: true, preview_token: pre.preview_token });
    await rejects(core.restore(ctx, { id: rec.id }), 'SECRET_DETECTED');
    assert.equal(existsSync(path), false);
    assert.equal(readdirSync(mwfFile(ctx, 'trash')).filter((f) => f.endsWith('.md')).length, 1);
  });

  it('the scan is pattern-based, not exhaustive: DB_PASS=... (no key/secret/token-style name) is not caught', async () => {
    const ctx = await project();
    const r = await core.add(ctx, {
      type: 'knowledge',
      title: 'Not caught',
      body: j('DB_PASS=', MIXED, 'x9'),
    });
    assert.ok(r.id);
  });

  it('a rejected write registers nothing: the same request_id can be retried with clean content', async () => {
    const ctx = await project();
    await rejects(
      core.add(ctx, {
        type: 'task',
        title: 'T',
        body: SECRETS['aws-access-key-id'] as string,
        request_id: 'req-sec',
      }),
      'SECRET_DETECTED',
    );
    const ok = await core.add(ctx, {
      type: 'task',
      title: 'T',
      body: 'clean',
      request_id: 'req-sec',
    });
    assert.equal(ok.deduped, false);
  });
});

describe('inbox discard is destructive (preview_token + confirm)', () => {
  it('previews by default; confirm needs the token; a stale token is refused; nothing changes until confirmed', async () => {
    const ctx = await project();
    const a = await core.propose(ctx, { text: 'first idea' });
    const b = await core.propose(ctx, { text: 'second idea' });
    const total = async (): Promise<number> => ((await core.inbox(ctx)) as { total: number }).total;

    const pre = (await core.inbox(ctx, {
      action: 'discard',
      entry_ids: [a.entry_id],
    })) as core.Preview<{ id: string }>;
    assert.equal(pre.preview, true);
    assert.deepEqual(
      pre.affected.map((e) => e.id),
      [a.entry_id],
    );
    assert.equal(await total(), 2);

    // confirm without a token, and with a wrong token, are refused
    await rejects(
      core.inbox(ctx, { action: 'discard', entry_ids: [a.entry_id], confirm: true }),
      'CONFIRM_REQUIRES_TOKEN',
    );
    await rejects(
      core.inbox(ctx, {
        action: 'discard',
        entry_ids: [a.entry_id],
        confirm: true,
        preview_token: '0'.repeat(32),
      }),
      'PREVIEW_MISMATCH',
    );
    assert.equal(await total(), 2);

    // the token binds the entry content: change the entry's text by hand and it is stale
    const inboxPath = mwfFile(ctx, 'inbox.md');
    writeFileSync(inboxPath, readFileSync(inboxPath, 'utf8').replace('first idea', 'changed idea'));
    await rejects(
      core.inbox(ctx, {
        action: 'discard',
        entry_ids: [a.entry_id],
        confirm: true,
        preview_token: pre.preview_token,
      }),
      'PREVIEW_MISMATCH',
    );
    const pre2 = (await core.inbox(ctx, {
      action: 'discard',
      entry_ids: [a.entry_id],
    })) as core.Preview<unknown>;
    const done = (await core.inbox(ctx, {
      action: 'discard',
      entry_ids: [a.entry_id],
      confirm: true,
      preview_token: pre2.preview_token,
    })) as { discarded: string[] };
    assert.deepEqual(done.discarded, [a.entry_id]);
    assert.equal(await total(), 1);
    // a preview token from another operation is not accepted either
    const fg = (await core.forget(ctx, { ids: ['task_aaaaaaaaaa'] }).catch(() => null)) as null;
    assert.equal(fg, null);
    const pre3 = (await core.inbox(ctx, {
      action: 'discard',
      entry_ids: [b.entry_id],
    })) as core.Preview<unknown>;
    assert.notEqual(pre3.preview_token, pre2.preview_token);
  });
});

describe('index.md is updated by every write', () => {
  const diskIndex = (ctx: core.Ctx): string => read(ctx, 'index.md');
  const expected = (ctx: core.Ctx): string => buildIndexMd(loadAll(layoutOf(ctx.root)));

  it('add / edit / handoff save / forget / restore / compact / purge keep index.md equal to a fresh build', async () => {
    const ctx = await project('track');
    const a = await core.add(ctx, { type: 'decision', title: 'Use pnpm', body: 'x' });
    assert.match(diskIndex(ctx), /Use pnpm/);
    assert.equal(diskIndex(ctx), expected(ctx));

    const got = core.get(ctx, { id: a.id });
    await core.edit(ctx, { id: a.id, expected_hash: got.hash, title: 'Use pnpm 9' });
    assert.match(diskIndex(ctx), /Use pnpm 9/);
    assert.equal(diskIndex(ctx), expected(ctx));

    await core.handoff(ctx, {
      action: 'save',
      task: 'tk',
      content: 'body',
      summary: 'sum',
    } as never);
    assert.match(diskIndex(ctx), /\[tk\]\(handoff\/tk\.md\).*sum/);
    assert.equal(diskIndex(ctx), expected(ctx));

    const pre = (await core.forget(ctx, { ids: [a.id] })) as core.Preview<unknown>;
    await core.forget(ctx, { ids: [a.id], confirm: true, preview_token: pre.preview_token });
    assert.doesNotMatch(diskIndex(ctx), /Use pnpm 9/);
    assert.equal(diskIndex(ctx), expected(ctx));

    const trashId = ((await core.restore(ctx)) as { entries: Array<{ trash_id: string }> })
      .entries[0]?.trash_id as string;
    await core.restore(ctx, { id: trashId });
    assert.match(diskIndex(ctx), /Use pnpm 9/);
    assert.equal(diskIndex(ctx), expected(ctx));

    // compact: two identical records collapse into one
    await core.add(ctx, { type: 'task', title: 'Dup', body: 'same' });
    await core.add(ctx, { type: 'task', title: 'Dup', body: 'same' });
    assert.equal(diskIndex(ctx), expected(ctx));
    const cp = (await core.compact(ctx, {})) as core.Preview<unknown>;
    await core.compact(ctx, { confirm: true, preview_token: cp.preview_token });
    assert.equal(diskIndex(ctx), expected(ctx));
    assert.equal((diskIndex(ctx).match(/\bDup\b/g) ?? []).length, 1);
  });

  it('writes that do not touch records or handoffs leave index.md alone, and an unchanged index is not rewritten', async () => {
    const ctx = await project();
    const m0 = readFileSync(mwfFile(ctx, 'index.md'));
    const { statSync } = await import('node:fs');
    const t0 = statSync(mwfFile(ctx, 'index.md')).mtimeMs;
    await core.propose(ctx, { text: 'only the inbox changes' });
    await core.setSession(ctx, { session_id: 's1', handoff: 'x' });
    assert.deepEqual(readFileSync(mwfFile(ctx, 'index.md')), m0);
    assert.equal(statSync(mwfFile(ctx, 'index.md')).mtimeMs, t0);
    // an edit that changes nothing the index shows (body only) does not rewrite it either
    const r = await core.add(ctx, { type: 'task', title: 'Body', body: 'one' });
    const t1 = statSync(mwfFile(ctx, 'index.md')).mtimeMs;
    await core.edit(ctx, {
      id: r.id,
      expected_hash: core.get(ctx, { id: r.id }).hash,
      body: 'two',
    });
    assert.equal(statSync(mwfFile(ctx, 'index.md')).mtimeMs, t1);
  });

  it('a stale index.md left behind by hand is corrected by the next record write', async () => {
    const ctx = await project();
    writeFileSync(mwfFile(ctx, 'index.md'), 'garbage');
    assert.ok((await core.doctor(ctx)).issues.some((i) => i.code === 'index_md_stale'));
    await core.add(ctx, { type: 'task', title: 'Fresh', body: 'b' });
    assert.equal(diskIndex(ctx), expected(ctx));
    assert.ok(!(await core.doctor(ctx)).issues.some((i) => i.code === 'index_md_stale'));
  });

  it('a record-less outcome for a rejected write leaves index.md untouched', async () => {
    const ctx = await project();
    const m0 = diskIndex(ctx);
    await rejects(
      core.add(ctx, { type: 'task', title: 'x', body: SECRETS['gitlab-token'] as string }),
      'SECRET_DETECTED',
    );
    assert.equal(diskIndex(ctx), m0);
  });

  it('kill -9 at every failpoint: after the retry index.md matches the records (same intent / recovery flow)', async () => {
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
    for (const fp of FAILPOINTS) {
      for (let n = 1; n <= 12; n++) {
        const ctx = await project();
        const call = {
          fn: 'add',
          input: { type: 'task', title: `Crash ${fp} ${n}`, body: 'b', request_id: 'req-idx' },
        };
        const killed = await runChild(ctx, [call], { MWF_FAILPOINT: `${fp}@${n}` });
        if (killed.signal !== 'SIGKILL') {
          assert.equal(killed.code, 0, killed.stderr);
          break;
        }
        const retry = await runChild({ ...ctx, waitMs: 5000, lockStaleMs: 300 }, [call]);
        assert.equal(retry.code, 0, `${fp}@${n}: ${retry.stderr}`);
        assert.equal(diskIndex(ctx), expected(ctx), `${fp}@${n}`);
        assert.match(diskIndex(ctx), new RegExp(`Crash ${fp} ${n}`));
        assert.ok(
          !(await core.doctor(ctx)).issues.some((i) => i.code === 'index_md_stale'),
          `${fp}@${n} doctor`,
        );
      }
    }
  });
});

describe('index.md after a crash with NO retry (recovery repairs it)', () => {
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
  const REC = { waitMs: 5000, lockStaleMs: 300 };
  const fresh = (ctx: core.Ctx): string => buildIndexMd(loadAll(layoutOf(ctx.root)));

  interface Case {
    name: string;
    setup?: (ctx: core.Ctx) => Promise<void>;
    call: (ctx: core.Ctx) => Promise<{ fn: string; input: unknown }>;
  }
  const cases: Case[] = [
    {
      name: 'add',
      call: async () => ({
        fn: 'add',
        input: { type: 'decision', title: 'Crash add', body: 'b', request_id: 'r-add' },
      }),
    },
    {
      name: 'edit (title change)',
      setup: async (ctx) => {
        await core.add(ctx, { type: 'task', title: 'Before', body: 'b', request_id: 'seed' });
      },
      call: async (ctx) => {
        const hit = (await core.recall(ctx, { query: 'Before', status: 'all' })).hits[0] as {
          id: string;
        };
        const rec = core.get(ctx, { id: hit.id });
        return {
          fn: 'edit',
          input: { id: rec.id, expected_hash: rec.hash, title: 'After', request_id: 'r-edit' },
        };
      },
    },
    {
      name: 'handoff save',
      call: async () => ({
        fn: 'handoff',
        input: {
          action: 'save',
          task: 'crash-task',
          content: 'c',
          summary: 'crash summary',
          request_id: 'r-ho',
        },
      }),
    },
    {
      name: 'forget (2 records: trash + index + removals)',
      setup: async (ctx) => {
        await core.add(ctx, { type: 'task', title: 'Gone one', body: 'a', request_id: 's1' });
        await core.add(ctx, { type: 'task', title: 'Gone two', body: 'b', request_id: 's2' });
      },
      call: async (ctx) => {
        const ids = (await core.recall(ctx, { query: 'Gone', status: 'all' })).hits.map(
          (h) => (h as { id: string }).id,
        );
        assert.equal(ids.length, 2);
        const pre = (await core.forget(ctx, { ids })) as core.Preview<unknown>;
        return {
          fn: 'forget',
          input: { ids, confirm: true, preview_token: pre.preview_token, request_id: 'r-fg' },
        };
      },
    },
  ];

  for (const c of cases) {
    for (const fp of FAILPOINTS) {
      it(`${c.name} @ ${fp}: a plain read repairs index.md; doctor is clean`, async () => {
        let hits = 0;
        for (let n = 1; n <= 12; n++) {
          const ctx = await project();
          await c.setup?.(ctx);
          const call = await c.call(ctx);
          const killed = await runChild(ctx, [call], { MWF_FAILPOINT: `${fp}@${n}` });
          if (killed.signal !== 'SIGKILL') {
            assert.equal(killed.code, 0, killed.stderr);
            break;
          }
          hits++;
          // NO retry. A plain read (any later process) must leave index.md describing exactly the
          // records on disk, whether the crashed write was rolled forward or discarded.
          const rctx = { ...ctx, ...REC };
          await core.recall(rctx, { query: 'x' });
          assert.equal(
            read(ctx, 'index.md'),
            fresh(ctx),
            `${fp}@${n}: index.md == records on disk`,
          );
          assert.equal(existsSync(mwfFile(ctx, 'mwf.local.intent.json')), false, `${fp}@${n}`);
          const issues = (await core.doctor(rctx)).issues.filter(
            (i) => i.code === 'index_md_stale' || i.level === 'error',
          );
          assert.deepEqual(issues, [], `${fp}@${n}: doctor`);
        }
        assert.ok(hits >= 1, `failpoint ${fp} was never reached`);
      });
    }
  }

  it('regression: index.md written, record never landed -> index.md no longer lists it after a read', async () => {
    const ctx = await project();
    const call = {
      fn: 'add',
      input: { type: 'decision', title: 'Phantom entry', body: 'b', request_id: 'r-ph' },
    };
    // index.md is the first target of the plan; the kill at the 2nd atomic rename of the write
    // happens right after it landed and before the record file does
    const killed = await runChild(ctx, [call], { MWF_FAILPOINT: 'write:target@1' });
    assert.equal(killed.signal, 'SIGKILL');
    assert.match(read(ctx, 'index.md'), /Phantom entry/, 'precondition: index.md ahead of records');
    assert.equal(loadAll(layoutOf(ctx.root)).records.length, 0);
    // doctor is read-only: it reports, it does not repair
    assert.ok(
      (await core.doctor({ ...ctx, ...REC })).issues.some((i) => i.code === 'index_md_stale'),
    );
    await core.recall({ ...ctx, ...REC }, { query: 'x' });
    assert.doesNotMatch(read(ctx, 'index.md'), /Phantom entry/);
    assert.equal(read(ctx, 'index.md'), fresh(ctx));
  });

  it('a live writer is not disturbed: its intent is left alone by readers', async () => {
    const ctx = await project();
    const rec = await core.add(ctx, { type: 'task', title: 'Live', body: 'b' });
    // fake an active writer: live lock held by this very process + an intent
    const layout = layoutOf(ctx.root);
    const { acquireLock } = await import('../src/core/lock.ts');
    const h = await acquireLock(layout, { waitMs: 1000 });
    writeFileSync(layout.intent, JSON.stringify({ request_id: 'x', targets: [] }));
    const before = read(ctx, 'index.md');
    const t0 = Date.now();
    const res = await core.recall({ ...ctx, waitMs: 100 }, { query: 'Live' });
    assert.ok(Date.now() - t0 < 1000, 'the read did not wait for the live writer');
    assert.equal(res.hits.length, 1);
    assert.equal(read(ctx, 'index.md'), before);
    assert.equal(existsSync(layout.intent), true, "the live writer's intent was not removed");
    h.release();
    assert.ok(rec.id);
  });
});

describe('docs and layout', () => {
  it('protocol.md states the secret rule and that inbox discard needs confirmation', async () => {
    const ctx = await project();
    const text = read(ctx, 'protocol.md');
    assert.match(text, /SECRET_DETECTED/);
    assert.match(text, /inbox discard/);
    assert.match(text, /不穷尽/);
    assert.match(text, /DB_PASS/);
  });

  it('protocol.md says only the user confirms, in a terminal, and names the known limitation', async () => {
    const ctx = await project();
    const text = read(ctx, 'protocol.md');
    assert.match(text, /用户本人在自己的交互式终端/);
    assert.match(text, /CONFIRM_REQUIRES_TTY/);
    assert.match(text, /伪终端/);
    assert.doesNotMatch(text, /审批/);
  });
});
