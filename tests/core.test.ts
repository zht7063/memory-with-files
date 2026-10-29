import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as core from '../src/core/index.ts';
import { dumpIndex, openIndexReadOnly } from '../src/core/db.ts';
import { layoutOf } from '../src/core/paths.ts';
import { gitRepo, project, tmpDir } from './helpers/util.ts';

const DAY = 24 * 60 * 60 * 1000;

async function rejects(p: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  await assert.rejects(
    typeof p === 'function' ? Promise.resolve().then(p) : p,
    (e: { code?: string }) => {
      assert.equal(e.code, code);
      return true;
    },
  );
}

describe('init and git modes', () => {
  it('track mode writes exactly the three .gitignore lines and nothing else outside .mwf/', async () => {
    const root = gitRepo();
    const res = await core.init({ root }, { git_mode: 'track' });
    assert.equal(res.created, true);
    assert.equal(
      readFileSync(join(root, '.gitignore'), 'utf8'),
      '.mwf/trash/\n.mwf/index.db-*\n.mwf/*.local.*\n',
    );
    assert.deepEqual(readdirSync(root).sort(), ['.git', '.gitignore', '.mwf']);
    assert.equal(existsSync(join(root, 'AGENTS.md')), false);
  });

  it('local mode adds only .mwf/ to .gitignore', async () => {
    const root = gitRepo();
    await core.init({ root }, { git_mode: 'local' });
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '.mwf/\n');
    assert.deepEqual(readdirSync(root).sort(), ['.git', '.gitignore', '.mwf']);
  });

  it('preserves existing .gitignore content, appends missing lines, and is idempotent', async () => {
    const root = gitRepo();
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.mwf/trash/');
    await core.init({ root }, { git_mode: 'track' });
    assert.equal(
      readFileSync(join(root, '.gitignore'), 'utf8'),
      'node_modules/\n.mwf/trash/\n.mwf/index.db-*\n.mwf/*.local.*\n',
    );
    const again = await core.init({ root }, { git_mode: 'track' });
    assert.equal(again.created, false);
    assert.deepEqual(again.gitignore_added, []);
    assert.equal(
      readFileSync(join(root, '.gitignore'), 'utf8')
        .split('\n')
        .filter((l) => l === '.mwf/trash/').length,
      1,
    );
  });

  it('refuses to switch git mode after init', async () => {
    const ctx = await project('track');
    await rejects(core.init(ctx, { git_mode: 'local' }), 'GIT_MODE_CONFLICT');
  });

  describe('init only runs at a git repository root', () => {
    it('works where .git/ is, and also where .git is a file (worktree / submodule)', async () => {
      const root = tmpDir();
      writeFileSync(join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
      assert.equal((await core.init({ root }, { git_mode: 'track' })).created, true);
      const plain = gitRepo();
      assert.equal((await core.init({ root: plain }, { git_mode: 'local' })).created, true);
    });

    it('refuses a subdirectory of a repository, names the repo root, and writes nothing', async () => {
      const repo = gitRepo();
      const sub = join(repo, 'packages', 'a');
      mkdirSync(sub, { recursive: true });
      const before = readdirSync(repo).sort();
      await assert.rejects(core.init({ root: sub }, { git_mode: 'track' }), (e: any) => {
        assert.equal(e.code, 'NOT_GIT_ROOT');
        assert.match(e.message, /not its root/);
        assert.equal(e.details.git_root, repo);
        return true;
      });
      assert.deepEqual(readdirSync(sub), []);
      assert.deepEqual(readdirSync(repo).sort(), before);
      assert.equal(existsSync(join(repo, '.gitignore')), false);
    });

    it('refuses a directory with no .git anywhere above it, and writes nothing', async () => {
      const root = tmpDir();
      await assert.rejects(core.init({ root }, { git_mode: 'local' }), (e: any) => {
        assert.equal(e.code, 'NOT_GIT_ROOT');
        assert.match(e.message, /no \.git/);
        return true;
      });
      assert.deepEqual(readdirSync(root), []);
    });

    it('refuses a missing directory without creating it', async () => {
      const root = join(tmpDir(), 'not-there');
      await rejects(core.init({ root }, { git_mode: 'track' }), 'NOT_GIT_ROOT');
      assert.equal(existsSync(root), false);
    });
  });

  it('creates the documented .mwf/ layout', async () => {
    const ctx = await project();
    const mwf = join(ctx.root, '.mwf');
    for (const p of [
      'config.toml',
      'protocol.md',
      'index.md',
      'inbox.md',
      'index.db',
      'state.toml',
      'handoff',
      'memory/preferences',
      'memory/decisions',
      'memory/incidents',
      'memory/tasks',
      'memory/knowledge',
    ])
      assert.ok(existsSync(join(mwf, p)), p);
    // the lock is released after init
    assert.equal(existsSync(join(mwf, 'mwf.local.lock')), false);
  });

  it('operations fail with NOT_INITIALIZED outside a project', async () => {
    await rejects(core.status({ root: tmpDir() }), 'NOT_INITIALIZED');
    assert.equal(core.findProjectRoot(tmpDir()), null);
  });

  it('findProjectRoot walks up to the nearest .mwf', async () => {
    const ctx = await project();
    const sub = join(ctx.root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    assert.equal(core.findProjectRoot(sub), ctx.root);
  });
});

describe('records', () => {
  it('add / get round-trip with scope, frontmatter file on disk', async () => {
    const ctx = await project();
    const r = await core.add(ctx, {
      type: 'decision',
      title: 'Use SQLite',
      body: 'FTS5 index.',
      scope: { paths: ['src/core'], keywords: ['index'] },
    });
    assert.match(r.id, /^dec_[a-z2-7]{10}$/);
    const got = core.get(ctx, { id: r.id });
    assert.equal(got.title, 'Use SQLite');
    assert.deepEqual(got.scope, { paths: ['src/core'], keywords: ['index'] });
    assert.equal(got.hash, r.hash);
    const file = readFileSync(join(ctx.root, '.mwf/memory/decisions', `${r.id}.md`), 'utf8');
    assert.match(file, /^---\nid: dec_/);
    assert.match(file, /status: active/);
  });

  it('supports all five types in their directories', async () => {
    const ctx = await project();
    const dirs = {
      preference: 'preferences',
      decision: 'decisions',
      incident: 'incidents',
      task: 'tasks',
      knowledge: 'knowledge',
    } as const;
    for (const type of core.RECORD_TYPES) {
      const r = await core.add(ctx, { type, title: `t ${type}`, body: 'body text' });
      assert.ok(existsSync(join(ctx.root, '.mwf/memory', dirs[type], `${r.id}.md`)));
    }
  });

  it('validates input', async () => {
    const ctx = await project();
    await rejects(
      core.add(ctx, { type: 'nope' as never, title: 't', body: 'b' }),
      'INVALID_ARGUMENT',
    );
    await rejects(
      core.add(ctx, { type: 'task', title: 'multi\nline', body: 'b' }),
      'INVALID_ARGUMENT',
    );
    await rejects(
      core.add(ctx, { type: 'task', title: 't', body: 'b', scope: { bogus: ['x'] } as never }),
      'INVALID_ARGUMENT',
    );
    await rejects(
      core.add(ctx, { type: 'task', title: 't', body: 'b', request_id: 'bad id!' }),
      'INVALID_ARGUMENT',
    );
    await rejects(() => core.get(ctx, { id: '../../etc/passwd' }), 'INVALID_ARGUMENT');
    await rejects(() => core.get(ctx, { id: 'dec_aaaaaaaaaa' }), 'NOT_FOUND');
  });

  it('edit needs a matching content hash (checked inside the lock) and keeps unknown frontmatter', async () => {
    const ctx = await project();
    const r = await core.add(ctx, { type: 'knowledge', title: 'K', body: 'one' });
    const path = join(ctx.root, '.mwf/memory/knowledge', `${r.id}.md`);
    writeFileSync(path, readFileSync(path, 'utf8').replace('\n---\n', '\nowner: me\n---\n'));
    const fresh = core.get(ctx, { id: r.id });
    await rejects(
      core.edit(ctx, { id: r.id, expected_hash: r.hash, body: 'two' }),
      'HASH_MISMATCH',
    );
    const ok = await core.edit(ctx, {
      id: r.id,
      expected_hash: fresh.hash,
      body: 'two',
      status: 'done',
    });
    assert.equal(ok.changed, true);
    const after = core.get(ctx, { id: r.id });
    assert.equal(after.body, 'two');
    assert.equal(after.status, 'done');
    assert.match(readFileSync(path, 'utf8'), /owner: me/);
    const noop = await core.edit(ctx, { id: r.id, expected_hash: after.hash, body: 'two' });
    assert.equal(noop.changed, false);
    await rejects(core.edit(ctx, { id: r.id, body: 'x' } as never), 'INVALID_ARGUMENT');
  });

  it('flags similar active records on add', async () => {
    const ctx = await project();
    const a = await core.add(ctx, { type: 'preference', title: 'Use  Tabs', body: 'a' });
    const b = await core.add(ctx, { type: 'preference', title: 'use tabs', body: 'b' });
    assert.deepEqual(b.similar, [a.id]);
  });

  it('hand-edited files win: recall reflects the file, not a stale index', async () => {
    const ctx = await project();
    const r = await core.add(ctx, {
      type: 'knowledge',
      title: 'Edited by hand',
      body: 'original text alpha',
    });
    const path = join(ctx.root, '.mwf/memory/knowledge', `${r.id}.md`);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('original text alpha', 'rewritten beta gamma'),
    );
    const hit = await core.recall(ctx, { query: 'beta gamma' });
    assert.equal(hit.hits[0]?.id, r.id);
    const miss = await core.recall(ctx, { query: 'alpha' });
    assert.equal(miss.hits.length, 0);
    assert.equal((await core.status(ctx)).index.in_sync, true);
  });
});

describe('recall', () => {
  it('searches English and CJK text, active by default, include-all on request', async () => {
    const ctx = await project();
    const a = await core.add(ctx, {
      type: 'decision',
      title: '索引使用 SQLite',
      body: '全文检索采用 FTS5 trigram 分词',
    });
    const b = await core.add(ctx, {
      type: 'incident',
      title: 'Lock bug',
      body: 'stale lock file blocked writers',
      status: 'done',
    });
    assert.equal((await core.recall(ctx, { query: '全文检索' })).hits[0]?.id, a.id);
    assert.equal((await core.recall(ctx, { query: 'sqlite' })).hits[0]?.id, a.id);
    assert.equal((await core.recall(ctx, { query: 'stale lock' })).hits.length, 0);
    const all = await core.recall(ctx, { query: 'stale lock', status: 'all' });
    assert.equal(all.hits[0]?.id, b.id);
    assert.equal(
      (await core.recall(ctx, { query: 'stale lock', status: 'done' })).hits[0]?.id,
      b.id,
    );
    assert.equal((await core.recall(ctx, { query: 'ab' })).hits.length, 0);
    assert.equal((await core.recall(ctx, { query: '检索' })).hits[0]?.id, a.id); // 2-char term
  });

  it('filters by scope: only records whose scope matches; general records are not returned', async () => {
    const ctx = await project();
    const general = await core.add(ctx, {
      type: 'preference',
      title: 'general pref',
      body: 'always applies',
    });
    const core1 = await core.add(ctx, {
      type: 'preference',
      title: 'core pref',
      body: 'core only',
      scope: { paths: ['src/core/'] },
    });
    const cli = await core.add(ctx, {
      type: 'preference',
      title: 'cli pref',
      body: 'cli only',
      scope: { paths: ['src/cli/**'], tools: ['mwf'] },
    });
    const ids = (r: core.RecallResult): string[] => r.hits.map((h) => h.id);
    // no scope query: everything, general records included
    assert.deepEqual(new Set(ids(await core.recall(ctx))), new Set([core1.id, cli.id, general.id]));
    assert.deepEqual(
      new Set(ids(await core.recall(ctx, { scope: {} }))),
      new Set([core1.id, cli.id, general.id]),
    );
    const forCore = await core.recall(ctx, { scope: { paths: ['src/core/lock.ts'] } });
    assert.deepEqual(ids(forCore), [core1.id]);
    const forCli = await core.recall(ctx, { scope: { paths: ['src/cli/a/b.ts'], tools: ['MWF'] } });
    assert.deepEqual(ids(forCli), [cli.id]);
    // a queried dimension the record declares must match; one it does not declare does not count
    const none = await core.recall(ctx, { scope: { tools: ['git'] } });
    assert.deepEqual(ids(none), []);
    const mismatch = await core.recall(ctx, {
      scope: { paths: ['src/core/x.ts'], tools: ['mwf'] },
    });
    assert.deepEqual(
      ids(mismatch),
      [core1.id],
      'cli is excluded by paths, core1 declares only paths',
    );
    const onlyTool = await core.recall(ctx, { scope: { tools: ['mwf'] } });
    assert.deepEqual(ids(onlyTool), [cli.id]);
    // the scope filter also applies to a text search, and ranks better matches first
    const both = await core.add(ctx, {
      type: 'preference',
      title: 'core tool pref',
      body: 'core and tool',
      scope: { paths: ['src/core/'], tools: ['mwf'] },
    });
    const ranked = await core.recall(ctx, { scope: { paths: ['src/core/a.ts'], tools: ['mwf'] } });
    assert.deepEqual(ids(ranked), [both.id, core1.id]);
    const searched = await core.recall(ctx, {
      query: 'always applies',
      scope: { paths: ['src/core/a.ts'] },
    });
    assert.deepEqual(ids(searched), []);
  });

  it('applies the scope filter before the candidate cap (a later match is not lost)', async () => {
    const ctx = await project();
    // 230 general records first (older), then the one scoped match (newest)
    for (let i = 0; i < 230; i++) {
      await core.add(ctx, {
        type: 'knowledge',
        title: `general note ${i}`,
        body: `shared marker text ${i}`,
        request_id: `bulk-${i}`,
      });
    }
    const target = await core.add(ctx, {
      type: 'knowledge',
      title: 'scoped note',
      body: 'shared marker text scoped',
      scope: { paths: ['src/target/'] },
    });
    const other = await core.add(ctx, {
      type: 'knowledge',
      title: 'other scoped note',
      body: 'shared marker text other',
      scope: { paths: ['src/elsewhere/'] },
    });
    const ids = (r: core.RecallResult): string[] => r.hits.map((h) => h.id);
    // without a query (list path) and with one (search path), the match is found
    const listed = await core.recall(ctx, { scope: { paths: ['src/target/a.ts'] }, limit: 50 });
    assert.deepEqual(ids(listed), [target.id]);
    assert.equal(listed.total_matched, 1);
    const searched = await core.recall(ctx, {
      query: 'shared marker text',
      scope: { paths: ['src/target/a.ts'] },
      limit: 50,
    });
    assert.deepEqual(ids(searched), [target.id]);
    assert.equal(searched.total_matched, 1);
    // short (two-character) terms take the LIKE path
    const short = await core.recall(ctx, { query: 'sc', scope: { paths: ['src/target/'] } });
    assert.deepEqual(ids(short), [target.id]);
    // unscoped recall is still capped at 200 candidates
    const unscoped = await core.recall(ctx, { query: 'shared marker text', limit: 50 });
    assert.ok(unscoped.total_matched <= 200, `capped, got ${unscoped.total_matched}`);
    assert.ok(!ids(await core.recall(ctx, { scope: { paths: ['nowhere/'] } })).includes(other.id));
  });

  it('handoffs are not scope-filtered; records still are', async () => {
    const ctx = await project();
    const inScope = await core.add(ctx, {
      type: 'knowledge',
      title: 'migration in scope',
      body: 'migration steps',
      scope: { paths: ['src/db/'] },
    });
    await core.add(ctx, {
      type: 'knowledge',
      title: 'migration elsewhere',
      body: 'migration steps',
      scope: { paths: ['src/ui/'] },
    });
    await core.add(ctx, { type: 'knowledge', title: 'migration general', body: 'migration steps' });
    await core.handoff(ctx, {
      action: 'save',
      task: 'db-migration',
      content: 'migration progress notes',
    });
    await core.handoff(ctx, {
      action: 'save',
      task: 'old-migration',
      content: 'migration finished long ago',
      status: 'done',
    });
    const scope = { paths: ['src/db/schema.ts'] };

    const withHandoffs = await core.recall(ctx, {
      query: 'migration',
      scope,
      include_handoffs: true,
    });
    const kindsAndIds = withHandoffs.hits.map((h) => `${h.kind}:${h.id}`);
    // the in-scope record ranks first; the active handoff is returned despite the scope
    assert.deepEqual(kindsAndIds, [`record:${inScope.id}`, 'handoff:db-migration']);
    assert.equal(withHandoffs.total_matched, 2);

    // without include_handoffs the same query returns only the matching record
    const records = await core.recall(ctx, { query: 'migration', scope });
    assert.deepEqual(
      records.hits.map((h) => h.id),
      [inScope.id],
    );
    // no scope at all: every record and the handoff
    const unscoped = await core.recall(ctx, { query: 'migration', include_handoffs: true });
    assert.equal(unscoped.hits.length, 4);
    // a scope that matches no record still returns the handoff, and only it
    const noRecords = await core.recall(ctx, {
      query: 'migration',
      scope: { tools: ['nothing'] },
      include_handoffs: true,
    });
    assert.deepEqual(
      noRecords.hits.map((h) => `${h.kind}:${h.id}`),
      ['handoff:db-migration'],
    );
    // handoffs still obey status and the text query
    const all = await core.recall(ctx, {
      query: 'migration',
      scope: { tools: ['nothing'] },
      include_handoffs: true,
      status: 'all',
    });
    assert.deepEqual(all.hits.map((h) => h.id).sort(), ['db-migration', 'old-migration']);
    const other = await core.recall(ctx, {
      query: 'unrelatedterm',
      scope,
      include_handoffs: true,
    });
    assert.deepEqual(other.hits, []);
    // list path (no query)
    const listed = await core.recall(ctx, { scope, include_handoffs: true });
    assert.deepEqual(listed.hits.map((h) => `${h.kind}:${h.id}`).sort(), [
      'handoff:db-migration',
      `record:${inScope.id}`,
    ]);
  });

  it('is bounded by limit and max_chars', async () => {
    const ctx = await project();
    for (let i = 0; i < 12; i++)
      await core.add(ctx, {
        type: 'knowledge',
        title: `note ${i}`,
        body: `common keyword ${'x'.repeat(300)}`,
      });
    const limited = await core.recall(ctx, { query: 'common keyword', limit: 5 });
    assert.equal(limited.hits.length, 5);
    assert.equal(limited.truncated, true);
    assert.equal(limited.total_matched, 12);
    const small = await core.recall(ctx, { query: 'common keyword', limit: 50, max_chars: 600 });
    assert.ok(small.hits.length >= 1 && small.hits.length < 12);
    assert.equal(small.truncated, true);
    assert.ok(small.hits.every((h) => h.snippet.length <= 160));
    await rejects(core.recall(ctx, { limit: 1000 }), 'INVALID_ARGUMENT');
  });

  it('reads handoffs by task', async () => {
    const ctx = await project();
    await core.handoff(ctx, {
      action: 'save',
      task: 'task-a',
      content: 'done: 1\nnext: 2',
      summary: 'one liner',
    });
    const r = await core.recall(ctx, { task: 'task-a' });
    assert.equal(r.handoff?.version, 1);
    assert.match(r.handoff?.body ?? '', /next: 2/);
    await rejects(core.recall(ctx, { task: 'missing' }), 'NOT_FOUND');
    await rejects(core.recall(ctx, { task: '../x' }), 'INVALID_ARGUMENT');
  });
});

type Save = core.HandoffSaveResult & { request_id: string; deduped: boolean };
const save = (ctx: core.Ctx, input: Record<string, unknown>): Promise<Save> =>
  core.handoff(ctx, { action: 'save', ...input } as never) as Promise<Save>;

describe('handoff', () => {
  it('saves with version check; conflicts append 「并行更新」 and never overwrite', async () => {
    const ctx = await project();
    const v1 = await save(ctx, { task: 't1', content: 'first body', summary: 's' });
    assert.equal(v1.version, 1);
    assert.equal(v1.conflict, false);
    const v2 = await save(ctx, { task: 't1', content: 'second body', base_version: 1 });
    assert.equal(v2.version, 2);
    assert.equal(v2.conflict, false);
    // a second session still on base 1
    const v3 = await save(ctx, { task: 't1', content: 'parallel body', base_version: 1 });
    assert.equal(v3.conflict, true);
    assert.equal(v3.version, 3);
    const read = core.readHandoffFile(ctx, 't1');
    assert.match(read.body, /second body/);
    assert.match(read.body, /## 并行更新/);
    assert.match(read.body, /parallel body/);
    assert.equal(read.summary, 's');
    // no base_version on an existing handoff is also a conflict (never a blind overwrite)
    const v4 = await save(ctx, { task: 't1', content: 'blind' });
    assert.equal(v4.conflict, true);
    assert.match(core.readHandoffFile(ctx, 't1').body, /parallel body/);
  });

  it('marks done, and done handoffs leave the default index', async () => {
    const ctx = await project();
    await core.handoff(ctx, { action: 'save', task: 'a', content: 'x', summary: 'sa' });
    await core.handoff(ctx, { action: 'save', task: 'b', content: 'y', summary: 'sb' });
    const done = await save(ctx, { task: 'a', content: 'x done', base_version: 1, status: 'done' });
    assert.equal(done.status, 'done');
    const list = await core.handoff(ctx, { action: 'read' });
    assert.ok('items' in list);
    assert.deepEqual(
      list.items.map((i) => i.task),
      ['b'],
    );
    const all = await core.handoff(ctx, { action: 'read', status: 'all' });
    assert.ok('items' in all && all.items.length === 2);
  });

  it('rejects unsafe task names', async () => {
    const ctx = await project();
    for (const task of ['../evil', 'a/b', '.hidden', '', 'x'.repeat(81)]) {
      await rejects(core.handoff(ctx, { action: 'save', task, content: 'c' }), 'INVALID_ARGUMENT');
    }
    await core.handoff(ctx, { action: 'save', task: '修复-bug_1.2', content: 'ok' });
  });
});

describe('bootstrap', () => {
  it('lists memory index + open handoff index; full text only when exactly one is open', async () => {
    const ctx = await project();
    await core.add(ctx, { type: 'decision', title: 'D1', body: 'b' });
    await core.add(ctx, { type: 'preference', title: 'P1', body: 'b' });
    let b = await core.bootstrap(ctx);
    assert.equal(b.memory.counts.decision, 1);
    assert.equal(b.memory.entries.length, 2);
    assert.deepEqual(b.handoffs.open, []);
    assert.equal(b.handoffs.full, null);
    await core.handoff(ctx, {
      action: 'save',
      task: 'one',
      content: 'full text here',
      summary: 'wip',
    });
    b = await core.bootstrap(ctx);
    assert.equal(b.handoffs.open.length, 1);
    assert.match(b.handoffs.full?.body ?? '', /full text here/);
    await core.handoff(ctx, { action: 'save', task: 'two', content: 'other' });
    b = await core.bootstrap(ctx);
    assert.equal(b.handoffs.open.length, 2);
    assert.equal(b.handoffs.full, null);
    assert.ok(b.handoffs.open.every((h) => h.updated && 'summary' in h));
    const small = await core.bootstrap(ctx, { max_entries: 1 });
    assert.equal(small.memory.truncated, true);
  });
});

describe('inbox', () => {
  it('propose appends to inbox.md; accept turns an entry into a record; discard needs preview/confirm', async () => {
    const ctx = await project();
    const p1 = await core.propose(ctx, { text: 'maybe prefer pnpm?', source: 'agent' });
    const p2 = await core.propose(ctx, { text: 'line one\n## ib_aaaaaaaaaa | x | y\nline three' });
    assert.equal(p2.inbox_entries, 2);
    const list = await core.inbox(ctx);
    assert.ok('entries' in list);
    assert.equal(list.total, 2);
    assert.match(list.entries[1]?.text ?? '', /line three/);

    const acc = await core.inbox(ctx, {
      action: 'accept',
      entry_id: p1.entry_id,
      type: 'preference',
      title: 'Prefer pnpm',
    });
    assert.ok('id' in acc);
    assert.equal(core.get(ctx, { id: acc.id }).body, 'maybe prefer pnpm?');
    assert.equal(((await core.inbox(ctx)) as { total: number }).total, 1);

    const pre = (await core.inbox(ctx, {
      action: 'discard',
      entry_ids: [p2.entry_id],
    })) as core.Preview<unknown>;
    assert.equal(pre.preview, true);
    assert.equal(((await core.inbox(ctx)) as { total: number }).total, 1);
    await core.inbox(ctx, {
      action: 'discard',
      entry_ids: [p2.entry_id],
      confirm: true,
      preview_token: pre.preview_token,
    });
    assert.equal(((await core.inbox(ctx)) as { total: number }).total, 0);
  });
});

describe('destructive operations: preview_token', () => {
  it('forget: preview by default; confirm needs a matching token; recomputed inside the lock', async () => {
    const ctx = await project();
    const r = await core.add(ctx, { type: 'incident', title: 'Oops', body: 'details' });
    const pre = (await core.forget(ctx, { ids: [r.id] })) as core.Preview<{ id: string }>;
    assert.equal(pre.preview, true);
    assert.deepEqual(
      pre.affected.map((a) => a.id),
      [r.id],
    );
    assert.equal(core.get(ctx, { id: r.id }).id, r.id); // preview changed nothing

    await rejects(
      core.forget(ctx, { ids: [r.id], confirm: true }) as Promise<unknown>,
      'CONFIRM_REQUIRES_TOKEN',
    );
    await rejects(
      core.forget(ctx, {
        ids: [r.id],
        confirm: true,
        preview_token: 'deadbeef',
      }) as Promise<unknown>,
      'PREVIEW_MISMATCH',
    );
    assert.equal(core.get(ctx, { id: r.id }).id, r.id);

    // content changes between preview and confirm -> token no longer matches
    const cur = core.get(ctx, { id: r.id });
    await core.edit(ctx, { id: r.id, expected_hash: cur.hash, body: 'changed after preview' });
    await rejects(
      core.forget(ctx, {
        ids: [r.id],
        confirm: true,
        preview_token: pre.preview_token,
      }) as Promise<unknown>,
      'PREVIEW_MISMATCH',
    );
    assert.equal(core.get(ctx, { id: r.id }).body, 'changed after preview');

    const pre2 = (await core.forget(ctx, { ids: [r.id] })) as core.Preview<unknown>;
    assert.notEqual(pre2.preview_token, pre.preview_token);
    const done = await core.forget(ctx, {
      ids: [r.id],
      confirm: true,
      preview_token: pre2.preview_token,
    });
    assert.equal((done as { preview: boolean }).preview, false);
    await rejects(() => core.get(ctx, { id: r.id }), 'NOT_FOUND');
    const trash = (await core.restore(ctx)) as { entries: Array<{ id: string }> };
    assert.deepEqual(
      trash.entries.map((e) => e.id),
      [r.id],
    );
  });

  it('forget a record that does not exist fails; the token of another operation is rejected', async () => {
    const ctx = await project();
    const a = await core.add(ctx, { type: 'task', title: 'A', body: 'a' });
    const b = await core.add(ctx, { type: 'task', title: 'B', body: 'b' });
    await rejects(core.forget(ctx, { ids: ['task_aaaaaaaaaa'] }) as Promise<unknown>, 'NOT_FOUND');
    const preA = (await core.forget(ctx, { ids: [a.id] })) as core.Preview<unknown>;
    await rejects(
      core.forget(ctx, {
        ids: [b.id],
        confirm: true,
        preview_token: preA.preview_token,
      }) as Promise<unknown>,
      'PREVIEW_MISMATCH',
    );
  });

  it('restore is non-destructive: lists, restores, and reports a conflict without overwriting', async () => {
    const ctx = await project();
    const r = await core.add(ctx, { type: 'knowledge', title: 'Keep me', body: 'original' });
    const pre = (await core.forget(ctx, { ids: [r.id] })) as core.Preview<unknown>;
    await core.forget(ctx, { ids: [r.id], confirm: true, preview_token: pre.preview_token });
    // someone recreates the path before the restore
    const path = join(ctx.root, '.mwf/memory/knowledge', `${r.id}.md`);
    writeFileSync(
      path,
      '---\nid: ' +
        r.id +
        '\ntype: knowledge\ntitle: "squatter"\nstatus: active\nscope: {}\ncreated: x\nupdated: x\n---\n\nsquatter\n',
    );
    const res = (await core.restore(ctx, { id: r.id })) as {
      restored: boolean;
      conflict?: { existing_hash: string };
    };
    assert.equal(res.restored, false);
    assert.ok(res.conflict);
    assert.match(readFileSync(path, 'utf8'), /squatter/);
    assert.equal(((await core.restore(ctx)) as { entries: unknown[] }).entries.length, 1); // still in trash
    // free the path and restore for real
    const { rmSync } = await import('node:fs');
    rmSync(path);
    const ok = (await core.restore(ctx, { id: r.id })) as { restored: boolean };
    assert.equal(ok.restored, true);
    assert.equal(core.get(ctx, { id: r.id }).body, 'original');
    assert.equal(((await core.restore(ctx)) as { entries: unknown[] }).entries.length, 0);
    await rejects(core.restore(ctx, { id: r.id }), 'NOT_FOUND');
  });

  it('trash expiry: bootstrap note, doctor lists near/expired, purge previews then deletes only on a matching token', async () => {
    let t = Date.parse('2026-01-01T00:00:00Z');
    const ctx = await project('track', { now: () => t });
    const a = await core.add(ctx, { type: 'incident', title: 'Old', body: 'x' });
    const pre = (await core.forget(ctx, { ids: [a.id] })) as core.Preview<unknown>;
    await core.forget(ctx, { ids: [a.id], confirm: true, preview_token: pre.preview_token });
    t += 10 * DAY;
    const b = await core.add(ctx, { type: 'incident', title: 'Newer', body: 'y' });
    const pre2 = (await core.forget(ctx, { ids: [b.id] })) as core.Preview<unknown>;
    await core.forget(ctx, { ids: [b.id], confirm: true, preview_token: pre2.preview_token });

    assert.equal((await core.bootstrap(ctx)).trash.note, null);
    t = Date.parse('2026-01-01T00:00:00Z') + 26 * DAY; // a: 26 days (near)
    let boot = await core.bootstrap(ctx);
    assert.equal(boot.trash.near, 1);
    assert.match(boot.trash.note ?? '', /临近过期/);
    t = Date.parse('2026-01-01T00:00:00Z') + 31 * DAY; // a: 31 days (expired), b: 21
    boot = await core.bootstrap(ctx);
    assert.equal(boot.trash.expired, 1);
    assert.match(boot.trash.note ?? '', /已过期/);
    const doc = await core.doctor(ctx);
    assert.ok(doc.issues.some((i) => i.code === 'trash_expired'));
    assert.deepEqual(
      doc.trash.items.map((i) => i.state),
      ['expired'],
    );

    const prev = (await core.purge(ctx)) as core.Preview<{ id: string }>;
    assert.deepEqual(
      prev.affected.map((x) => x.id),
      [a.id],
    ); // only the expired one
    await rejects(core.purge(ctx, { confirm: true }) as Promise<unknown>, 'CONFIRM_REQUIRES_TOKEN');
    await rejects(
      core.purge(ctx, { confirm: true, preview_token: 'nope' }) as Promise<unknown>,
      'PREVIEW_MISMATCH',
    );
    assert.equal(((await core.restore(ctx)) as { entries: unknown[] }).entries.length, 2);
    await core.purge(ctx, { confirm: true, preview_token: prev.preview_token });
    const left = (await core.restore(ctx)) as { entries: Array<{ id: string }> };
    assert.deepEqual(
      left.entries.map((e) => e.id),
      [b.id],
    );
  });

  it('compact merges exact duplicates into the oldest (scopes unioned), previews first', async () => {
    let t = Date.parse('2026-02-01T00:00:00Z');
    const ctx = await project('track', { now: () => (t += 1000) });
    const k = await core.add(ctx, {
      type: 'knowledge',
      title: 'Same',
      body: 'identical body',
      scope: { paths: ['a/'] },
    });
    const d = await core.add(ctx, {
      type: 'knowledge',
      title: 'same',
      body: 'identical   body',
      scope: { paths: ['b/'] },
    });
    const other = await core.add(ctx, { type: 'knowledge', title: 'Same', body: 'different body' });
    const pre = (await core.compact(ctx)) as core.Preview<{ keep: string; merge: string[] }>;
    assert.equal(pre.affected.length, 1);
    assert.equal(pre.affected[0]?.keep, k.id);
    assert.deepEqual(pre.affected[0]?.merge, [d.id]);
    assert.equal(core.get(ctx, { id: d.id }).id, d.id);
    await rejects(
      core.compact(ctx, { confirm: true, preview_token: 'x' }) as Promise<unknown>,
      'PREVIEW_MISMATCH',
    );
    await core.compact(ctx, { confirm: true, preview_token: pre.preview_token });
    assert.deepEqual(core.get(ctx, { id: k.id }).scope, { paths: ['a/', 'b/'] });
    await rejects(() => core.get(ctx, { id: d.id }), 'NOT_FOUND');
    assert.equal(core.get(ctx, { id: other.id }).id, other.id);
    const trash = (await core.restore(ctx)) as { entries: Array<{ id: string; reason: string }> };
    assert.deepEqual(
      trash.entries.map((e) => e.id),
      [d.id],
    );
    assert.match(trash.entries[0]?.reason ?? '', /merged into/);
  });
});

describe('reindex, doctor and the index as a derived artefact', () => {
  async function populate(ctx: core.Ctx): Promise<void> {
    const a = await core.add(ctx, {
      type: 'decision',
      title: 'D',
      body: 'decision body',
      scope: { phases: ['design'] },
    });
    const b = await core.add(ctx, { type: 'preference', title: '偏好', body: '中文正文 内容' });
    await core.add(ctx, { type: 'incident', title: 'I', body: 'incident' });
    await core.handoff(ctx, {
      action: 'save',
      task: 'ho',
      content: 'handoff text',
      summary: 'sum',
    });
    await core.edit(ctx, { id: a.id, expected_hash: a.hash, status: 'done' });
    const pre = (await core.forget(ctx, { ids: [b.id] })) as core.Preview<unknown>;
    await core.forget(ctx, { ids: [b.id], confirm: true, preview_token: pre.preview_token });
    await core.propose(ctx, { text: 'inbox note' });
  }

  function dump(ctx: core.Ctx): unknown {
    const db = openIndexReadOnly(layoutOf(ctx.root));
    assert.ok(db);
    try {
      return dumpIndex(db);
    } finally {
      db.close();
    }
  }

  it('incrementally maintained index equals a rebuilt one; index.md is deterministic', async () => {
    const ctx = await project();
    await populate(ctx);
    const incremental = JSON.stringify(dump(ctx));
    await core.reindex(ctx);
    const rebuilt = JSON.stringify(dump(ctx));
    assert.equal(rebuilt, incremental);
    const md1 = readFileSync(join(ctx.root, '.mwf/index.md'), 'utf8');
    await core.reindex(ctx);
    assert.equal(readFileSync(join(ctx.root, '.mwf/index.md'), 'utf8'), md1);
    assert.match(md1, /## Handoff/);
    // delete the index entirely: reindex (and even plain reads) rebuild from the records
    const { rmSync } = await import('node:fs');
    rmSync(join(ctx.root, '.mwf/index.db'));
    for (const f of readdirSync(join(ctx.root, '.mwf')).filter((f) => f.startsWith('index.db-')))
      rmSync(join(ctx.root, '.mwf', f));
    assert.equal(
      (await core.recall(ctx, { query: 'handoff text', include_handoffs: true })).hits.length,
      1,
    );
    assert.equal(JSON.stringify(dump(ctx)), incremental);
  });

  it('a corrupt (e.g. merge-conflicted) index.db is quarantined and rebuilt from records', async () => {
    const ctx = await project();
    await populate(ctx);
    const before = JSON.stringify(dump(ctx));
    writeFileSync(
      join(ctx.root, '.mwf/index.db'),
      '<<<<<<< ours\nnot a database\n=======\n>>>>>>> theirs\n',
    );
    for (const f of readdirSync(join(ctx.root, '.mwf')).filter((f) => f.startsWith('index.db-'))) {
      (await import('node:fs')).rmSync(join(ctx.root, '.mwf', f));
    }
    const d = await core.doctor(ctx);
    assert.ok(d.issues.some((i) => i.code === 'index_unusable'));
    await core.reindex(ctx);
    assert.equal(JSON.stringify(dump(ctx)), before);
    assert.ok(readdirSync(join(ctx.root, '.mwf')).some((f) => f.startsWith('index.db-corrupt-')));
    assert.equal((await core.doctor(ctx)).ok, true);
  });

  it('doctor reports temp leftovers, pending intents, mismatches and invalid records (read-only)', async () => {
    const ctx = await project();
    const r = await core.add(ctx, { type: 'knowledge', title: 'K', body: 'b' });
    const mwf = join(ctx.root, '.mwf');
    writeFileSync(join(mwf, 'memory/knowledge/.tmp-123-abcd-x.md'), 'partial');
    writeFileSync(join(mwf, 'memory/knowledge/kn_bbbbbbbbbb.md'), 'not a record');
    const file = join(mwf, 'memory/knowledge', `${r.id}.md`);
    writeFileSync(file, readFileSync(file, 'utf8') + '\nhand edit\n');
    const d = await core.doctor(ctx);
    const codes = d.issues.map((i) => i.code);
    assert.ok(codes.includes('temp_leftover'));
    assert.ok(codes.includes('invalid_record'));
    assert.ok(codes.includes('index_hash_mismatch'));
    assert.equal(d.ok, false);
    assert.equal(d.temp_files.length, 1);
    assert.ok(existsSync(join(mwf, 'memory/knowledge/.tmp-123-abcd-x.md'))); // doctor never repairs
    // the next lock holder cleans the temp file and refreshes the index
    await core.add(ctx, { type: 'knowledge', title: 'K2', body: 'b2' });
    assert.equal(existsSync(join(mwf, 'memory/knowledge/.tmp-123-abcd-x.md')), false);
    const after = await core.doctor(ctx);
    assert.equal(after.index.mismatches, 0);
  });
});

describe('host confirmation and session mapping', () => {
  it('confirmHost writes host.local.toml (gitignored name) once; sessions live in state.toml', async () => {
    const ctx = await project();
    const a = await core.confirmHost(ctx, { host: 'codex', channel: 'hook' });
    assert.equal(a.changed, true);
    assert.equal((await core.confirmHost(ctx, { host: 'codex', channel: 'hook' })).changed, false);
    assert.match(readFileSync(join(ctx.root, '.mwf/host.local.toml'), 'utf8'), /\[hosts\.codex\]/);
    assert.deepEqual(Object.keys((await core.status(ctx)).host), ['codex']);
    await core.setSession(ctx, {
      session_id: 's1',
      handoff: 'task-x',
      injected: ['dec_aaaaaaaaaa'],
    });
    assert.deepEqual(core.getSession(ctx, 's1')?.injected, ['dec_aaaaaaaaaa']);
    assert.match(readFileSync(join(ctx.root, '.mwf/state.toml'), 'utf8'), /\[sessions\.s1\]/);
  });
});
