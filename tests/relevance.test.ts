import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CJK_MIN_PIECES,
  DEFAULT_RECALL_MIN_SCORE,
  relevanceScore,
  scoringTerms,
} from '../src/core/relevance.ts';

/** The best score `query` gets against any of the records. */
function best(query: string, records: Array<[string, string]>): number {
  const terms = scoringTerms(query);
  return Math.max(0, ...records.map(([title, body]) => relevanceScore(terms, title, body)));
}

const EN: Array<[string, string]> = [
  ['Use SQLite for the index', 'We chose sqlite because it ships with node and needs no server.'],
  ['Deploy with the blue/green script', 'Production deploys go through scripts/bluegreen.sh.'],
];

const ZH: Array<[string, string]> = [
  ['索引使用 SQLite', '我们决定用 sqlite 作为索引，因为它随 node 自带，不需要单独的服务器。'],
  ['锁超时是 120 秒', '项目锁的超时时间是 120 秒，超过后视为过期，由下一个写入者回收。'],
  ['部署用蓝绿脚本', '生产环境部署通过 scripts/bluegreen.sh 完成，为什么这样做：可以快速回滚。'],
  ['回答用中文', '请用中文回答，代码注释用英文。我们的习惯是简短。'],
  ['周五数据库迁移失败', '为什么失败：迁移脚本没有处理空表。怎么办：加入检查，重新执行。'],
  ['接入 CI 流水线', '配置 ci 在每次提交时运行测试，数据库 db 用临时文件。'],
  ['日志格式统一为 JSON', '所有服务的日志输出统一使用 json 格式，方便检索。时间戳使用 UTC。'],
  ['代码评审规则', '每个合并请求至少需要一位评审通过，评审人不能是作者本人。'],
  ['缓存失效策略', '缓存失效时间设为十分钟，用户修改资料后需要主动清除缓存。'],
  ['测试数据库', '测试环境使用独立的数据库，不要连接生产数据库，数据每天凌晨重置。'],
];

describe('relevance scoring (hook auto-recall)', () => {
  it('the default threshold is 2 and CJK runs need 2 matching pieces', () => {
    assert.equal(DEFAULT_RECALL_MIN_SCORE, 2);
    assert.equal(CJK_MIN_PIECES, 2);
  });

  it('the READY prompt scores 0: only stopwords and filler words', () => {
    const q = 'Reply with exactly the word READY and nothing else.';
    assert.deepEqual(
      scoringTerms(q).map((t) => t.pieces[0]),
      ['ready'],
    );
    assert.equal(best(q, EN), 0);
  });

  it('stopwords and 1-2 character words carry no weight', () => {
    assert.deepEqual(scoringTerms('with the and for it is of to'), []);
    assert.deepEqual(scoringTerms('ok'), []);
    assert.deepEqual(scoringTerms('a b'), []);
    assert.equal(best('with the and', EN), 0);
  });

  it('a relevant question is recalled: title 2, body 1, each distinct term once', () => {
    const q =
      'Why did we pick sqlite for the index? Answer in one sentence and do not call any tool.';
    assert.equal(best(q, EN), 4, 'sqlite and index in the title (2 + 2)');
    assert.equal(relevanceScore(scoringTerms('sqlite sqlite SQLITE'), 'x', 'uses sqlite'), 1);
    assert.equal(relevanceScore(scoringTerms('sqlite'), 'Use SQLite', 'body'), 2);
    assert.equal(relevanceScore(scoringTerms('sqlite'), 'title', 'uses sqlite here'), 1);
    assert.equal(relevanceScore(scoringTerms('sqlite'), 'title', 'body'), 0);
  });

  it('one ordinary word in the body is not enough, two distinct words are', () => {
    const rec: Array<[string, string]> = [
      ['Release notes', 'remember to bump the version and tag it'],
    ];
    assert.equal(best('what about the version?', rec), 1);
    assert.equal(best('bump the version', rec), 2);
  });

  it('2-character technical terms count, as whole tokens only', () => {
    const rec: Array<[string, string]> = [
      ['Use db migrations', 'the db is rebuilt from files; google it'],
    ];
    assert.equal(best('db', rec), 2, 'title token');
    assert.equal(best('k8', [['k8 cluster', 'x']]), 2);
    assert.equal(best('ci', [['Run CI on push', 'x']]), 2);
    assert.equal(best('go', [['Written in Go', 'x']]), 1, 'ambiguous words cap at 1');
    assert.equal(
      best('go ahead', [['Algorithm choice', 'google and category']]),
      0,
      'go is not a substring match',
    );
    assert.equal(best('xx yy', [['xx yy', 'xx yy']]), 0, 'other 2-character words do not count');
  });

  it('terms are matched case-insensitively against the full body', () => {
    const body = `${'filler '.repeat(60)}the Deadline is friday`;
    assert.equal(relevanceScore(scoringTerms('DEADLINE'), 't', body), 1);
  });

  it('at most 40 pieces are scored', () => {
    const q = Array.from({ length: 80 }, (_, i) => `word${i}x`).join(' ');
    assert.ok(scoringTerms(q).length <= 40);
  });
});

describe('Chinese relevance measurements (10 records)', () => {
  const unrelated = [
    '今天天气怎么样',
    '继续',
    '好的谢谢',
    '你好',
    '我们今天吃什么',
    '为什么天空是蓝色的',
    '怎么办才好',
    '帮我写一首关于春天的诗',
    '可以吗',
    '再说一遍',
    '现在几点了',
    '这个是什么意思',
    '请用简短的话回答我',
    '帮我把这句话翻译成英文',
    '你能不能解释一下什么是量子计算',
    '请继续上面的话题',
    '能不能再详细一点',
    '怎么用中文回答我',
    '数据怎么处理比较好',
    '服务器怎么了',
    '为什么会这样',
    '测试一下你还在不在',
    '评审通过了吗',
    '错误提示是什么意思',
  ];
  const related: Array<[string, number]> = [
    ['为什么索引用 sqlite', 0],
    ['上次定的锁超时是多少', 1],
    ['周五数据库迁移为什么失败', 4],
    ['ci 怎么配置', 5],
    ['日志格式用 json 吗', 6],
  ];

  it('unrelated Chinese chat never reaches the threshold', () => {
    const scores = unrelated.map((q) => [q, best(q, ZH)] as const);
    const leaks = scores.filter(([, s]) => s >= DEFAULT_RECALL_MIN_SCORE);
    assert.deepEqual(leaks, []);
    for (const q of ['今天天气怎么样', '继续']) assert.equal(best(q, ZH), 0, q);
  });

  it('related Chinese questions reach it against the matching record', () => {
    for (const [q, index] of related) {
      const [title, body] = ZH[index] as [string, string];
      const score = relevanceScore(scoringTerms(q), title, body);
      assert.ok(score >= DEFAULT_RECALL_MIN_SCORE, `${q} -> ${score}`);
    }
  });

  it('a single coincidental 3-character piece does not count (stricter CJK rule)', () => {
    // 回答用中文 and 怎么用中文回答我 share only 用中文: one piece, so it scores 0.
    assert.equal(best('怎么用中文回答我', [['回答用中文', 'x']]), 0);
    // With two shared pieces (锁超时 and 超时是) it counts as a term.
    assert.equal(best('锁超时是多少', [['锁超时是 120 秒', 'x']]), 2);
    // A run of exactly 3 characters has one piece, which is enough.
    assert.equal(best('锁超时', [['锁超时是 120 秒', 'x']]), 2);
  });

  it('Chinese question words are stopwords', () => {
    assert.deepEqual(scoringTerms('为什么'), []);
    assert.deepEqual(scoringTerms('怎么样'), []);
    assert.equal(best('为什么天空是蓝色的', [['为什么选 SQLite', '为什么是 sqlite']]), 0);
  });
});
