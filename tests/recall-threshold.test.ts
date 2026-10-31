import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as cli from '../src/cli/index.ts';
import { DEFAULT_RECALL_MIN_SCORE as CORE_DEFAULT } from '../src/core/relevance.ts';
import { add, doctor, recall, status, type Ctx } from '../src/core/index.ts';
import { readConfig } from '../src/core/init.ts';
import { DEFAULT_RECALL_MIN_SCORE as HOOK_DEFAULT } from '../src/hooks/budget.ts';
import { userPrompt, type HookContext } from '../src/hooks/index.ts';
import { callTool, TOOLS } from '../src/mcp/index.ts';
import { project } from './helpers/util.ts';

const READY = 'Reply with exactly the word READY and nothing else.';

async function seeded(): Promise<Ctx> {
  const ctx = await project();
  await add(ctx, {
    type: 'decision',
    title: 'Use SQLite for the index',
    body: 'We chose sqlite because it ships with node and needs no server.',
  });
  await add(ctx, {
    type: 'decision',
    title: 'Deploy with the blue/green script',
    body: 'Production deploys go through scripts/bluegreen.sh and roll back fast.',
  });
  return ctx;
}

async function seededZh(): Promise<Ctx> {
  const ctx = await project();
  await add(ctx, {
    type: 'decision',
    title: '索引使用 SQLite',
    body: '我们决定用 sqlite 作为索引，因为它随 node 自带，不需要单独的服务器。',
  });
  await add(ctx, {
    type: 'decision',
    title: '锁超时是 120 秒',
    body: '项目锁的超时时间是 120 秒，超过后视为过期，由下一个写入者回收。',
  });
  await add(ctx, {
    type: 'knowledge',
    title: '回答用中文',
    body: '请用中文回答，代码注释用英文。我们的习惯是简短。',
  });
  return ctx;
}

function hc(cwd: string, sid = 'sess-0001'): HookContext {
  return { cwd, host: 'codex', session_id: sid };
}

function config(ctx: Ctx, text: string): void {
  appendFileSync(join(ctx.root, '.mwf', 'config.toml'), `\n[hooks]\n${text}\n`);
}

describe('recall min_relevance (core)', () => {
  it('is off unless asked: explicit recall keeps its old behavior', async () => {
    const ctx = await seeded();
    const plain = await recall(ctx, { query: READY });
    assert.ok(plain.hits.length >= 1, 'the old OR search still matches on stopwords like "with"');
    const off = await recall(ctx, { query: READY, min_relevance: 0 });
    assert.deepEqual(
      off.hits.map((h) => h.id),
      plain.hits.map((h) => h.id),
    );
  });

  it('min_relevance filters the READY prompt to nothing, and keeps a relevant prompt', async () => {
    const ctx = await seeded();
    const none = await recall(ctx, { query: READY, min_relevance: 2 });
    assert.deepEqual(none.hits, []);
    assert.equal(none.total_matched, 0);
    const some = await recall(ctx, {
      query: 'why did we pick sqlite for the index?',
      min_relevance: 2,
    });
    assert.deepEqual(
      some.hits.map((h) => h.title),
      ['Use SQLite for the index'],
    );
  });

  it('a query of only stopwords returns nothing instead of everything', async () => {
    const ctx = await seeded();
    const r = await recall(ctx, { query: 'with the and', min_relevance: 1 });
    assert.deepEqual(r.hits, []);
  });

  it('the filter runs before the limit, so a weak hit cannot crowd out a strong one', async () => {
    const ctx = await project();
    for (let i = 0; i < 4; i++) {
      await add(ctx, {
        type: 'knowledge',
        title: `Note ${i}`,
        body: `mentions the zebra number ${i}`,
      });
    }
    await add(ctx, { type: 'knowledge', title: 'Zebra stripes policy', body: 'stripes are black' });
    const r = await recall(ctx, { query: 'zebra stripes', limit: 1, min_relevance: 2 });
    assert.deepEqual(
      r.hits.map((h) => h.title),
      ['Zebra stripes policy'],
    );
  });

  it('rejects values outside the integers 0..20', async () => {
    const ctx = await seeded();
    for (const bad of [-1, 21, 1.5, Number.NaN, '2' as unknown as number]) {
      await assert.rejects(recall(ctx, { query: 'sqlite', min_relevance: bad }), /min_relevance/);
    }
    for (const good of [0, 1, 20]) await recall(ctx, { query: 'sqlite', min_relevance: good });
  });

  it('the CLI and MCP surfaces validate it too and describe it', async () => {
    const ctx = await seeded();
    const env = { cwd: ctx.root };
    for (const bad of [-1, 21, 1.5]) {
      const r = await cli.recall({ query: 'sqlite', min_relevance: bad }, env);
      assert.ok(!r.ok && r.error.code === 'INVALID_ARGUMENT', String(bad));
    }
    const ok = await cli.recall({ query: READY, min_relevance: 2 }, env);
    assert.ok(ok.ok);
    assert.deepEqual((ok.data as any).hits, []);
    const viaMcp = await callTool('mwf_recall', { query: READY, min_relevance: 2 }, env);
    assert.ok(viaMcp.structuredContent.ok);
    assert.deepEqual((viaMcp.structuredContent as any).data.hits, []);
    const tool = TOOLS.find((t) => t.name === 'mwf_recall')!;
    const prop = (tool.inputSchema as any).properties.min_relevance;
    assert.equal(prop.type, 'integer');
    assert.equal(prop.minimum, 0);
    assert.equal(prop.maximum, 20);
  });
});

describe('[hooks] recall_min_score (config, status, doctor)', () => {
  it('defaults to 2 and the hooks layer mirrors the core default', async () => {
    assert.equal(CORE_DEFAULT, 2);
    assert.equal(HOOK_DEFAULT, CORE_DEFAULT);
    const ctx = await seeded();
    assert.equal((await status(ctx)).hooks.recall_min_score, 2);
    assert.equal(
      (await doctor(ctx)).issues.filter((i) => i.code.startsWith('config_recall')).length,
      0,
    );
  });

  it('reads 0..20 from config', async () => {
    for (const [text, want] of [
      ['recall_min_score = 0', 0],
      ['recall_min_score = 3', 3],
      ['recall_min_score = 20', 20],
    ] as const) {
      const ctx = await seeded();
      config(ctx, text);
      assert.equal(
        readConfig(readFileSync(join(ctx.root, '.mwf', 'config.toml'), 'utf8'))!
          .hooks_recall_min_score,
        want,
      );
      assert.equal((await status(ctx)).hooks.recall_min_score, want);
    }
  });

  it('an invalid value falls back to 2 and doctor warns about it', async () => {
    for (const text of [
      'recall_min_score = -1',
      'recall_min_score = 21',
      'recall_min_score = 1.5',
      'recall_min_score = "high"',
      'recall_min_score = true',
    ]) {
      const ctx = await seeded();
      config(ctx, text);
      assert.equal((await status(ctx)).hooks.recall_min_score, 2, text);
      const issue = (await doctor(ctx)).issues.find(
        (i) => i.code === 'config_recall_min_score_invalid',
      );
      assert.ok(issue, text);
      assert.equal(issue!.level, 'warn');
      assert.match(issue!.message, /recall_min_score/);
    }
  });
});

describe('userPrompt relevance threshold', () => {
  it('the READY prompt injects nothing even though memory exists', async () => {
    const ctx = await seeded();
    assert.deepEqual(await userPrompt({ prompt: READY }, hc(ctx.root)), {});
  });

  it('a relevant prompt still injects only the matching record', async () => {
    const ctx = await seeded();
    const out = await userPrompt(
      { prompt: 'Why did we pick sqlite for the index? Answer in one sentence.' },
      hc(ctx.root),
    );
    assert.match(out.inject!, /Use SQLite for the index/);
    assert.doesNotMatch(out.inject!, /blue\/green/);
  });

  it('chit-chat with a stray ambiguous word stays quiet ("go")', async () => {
    const ctx = await seeded();
    assert.deepEqual(await userPrompt({ prompt: 'ok thanks, go ahead' }, hc(ctx.root)), {});
  });

  it('[hooks] recall_min_score = 0 turns the filter off; a high value silences it', async () => {
    const off = await seeded();
    config(off, 'recall_min_score = 0');
    const loose = await userPrompt({ prompt: READY }, hc(off.root));
    assert.ok(loose.inject, 'with the filter off the old behavior returns');

    const strict = await seeded();
    config(strict, 'recall_min_score = 5');
    const prompt = 'why did we pick sqlite for the index?';
    assert.deepEqual(await userPrompt({ prompt }, hc(strict.root)), {}, 'score 4 < 5');
    const mid = await seeded();
    config(mid, 'recall_min_score = 4');
    assert.ok((await userPrompt({ prompt }, hc(mid.root))).inject);
  });

  it('an invalid config value behaves like the default', async () => {
    const ctx = await seeded();
    config(ctx, 'recall_min_score = "oops"');
    assert.deepEqual(await userPrompt({ prompt: READY }, hc(ctx.root)), {});
    assert.ok((await userPrompt({ prompt: 'why sqlite for the index?' }, hc(ctx.root))).inject);
  });

  it('Chinese: unrelated chat is not injected', async () => {
    const ctx = await seededZh();
    for (const prompt of [
      '今天天气怎么样',
      '继续',
      '好的谢谢',
      '怎么用中文回答我',
      '为什么天空是蓝色的',
    ]) {
      assert.deepEqual(await userPrompt({ prompt }, hc(ctx.root)), {}, prompt);
    }
  });

  it('Chinese: related questions recall the matching record', async () => {
    const ctx = await seededZh();
    const a = await userPrompt({ prompt: '为什么索引用 sqlite' }, hc(ctx.root));
    assert.match(a.inject!, /索引使用 SQLite/);
    const b = await userPrompt({ prompt: '上次定的锁超时是多少' }, hc(ctx.root));
    assert.match(b.inject!, /锁超时是 120 秒/);
    assert.doesNotMatch(b.inject!, /回答用中文/);
  });
});
