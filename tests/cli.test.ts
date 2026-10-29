import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as cli from '../src/cli/index.ts';
import { main, type Io } from '../src/cli/main.ts';
import { validate, type ObjectSchema } from '../src/cli/schema.ts';
import { withLock } from '../src/core/write.ts';
import { project, runChild, tmpDir } from './helpers/util.ts';

const FAST = { waitMs: 3000, lockStaleMs: 300 };

type Data = Record<string, any> & { request_id?: string };

async function ok(p: Promise<cli.CliResult>): Promise<Data> {
  const r = await p;
  assert.equal(r.ok, true, r.ok ? '' : `${r.error.code}: ${r.error.message}`);
  return (r as { ok: true; data: Data }).data;
}

async function fails(p: Promise<cli.CliResult>, code: string): Promise<cli.CliError> {
  const r = await p;
  assert.equal(r.ok, false, 'expected a failure');
  assert.equal((r as { ok: false; error: cli.CliError }).error.code, code);
  return (r as { ok: false; error: cli.CliError }).error;
}

function io(cwd: string, stdin?: string): Io & { out: string; err: string } {
  const sink = {
    out: '',
    err: '',
    cwd,
    ...(stdin === undefined ? {} : { stdin: async () => stdin }),
    stdout: (t: string) => void (sink.out += t),
    stderr: (t: string) => void (sink.err += t),
  };
  return sink;
}

async function sh(
  argv: string[],
  cwd: string,
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  const sink = io(cwd, stdin);
  const code = await main(argv, sink);
  return { code, out: sink.out, err: sink.err };
}

describe('CLI schema validation', () => {
  const schema: ObjectSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: {
      a: { type: 'string', minLength: 1, maxLength: 3 },
      n: { type: 'integer', minimum: 1, maximum: 5 },
      e: { type: 'string', enum: ['x', 'y'] },
      l: { type: 'array', items: { type: 'string' }, maxItems: 2 },
      o: { type: 'object', additionalProperties: false, properties: { k: { type: 'boolean' } } },
    },
  };
  const bad = (input: unknown, pattern: RegExp): void =>
    assert.throws(
      () => validate(schema, input),
      (e: { code?: string; message: string }) =>
        e.code === 'INVALID_ARGUMENT' && pattern.test(e.message),
    );

  it('accepts a valid input and an empty optional one', () => {
    assert.deepEqual(validate(schema, { a: 'ok', n: 2, e: 'x', l: ['q'], o: { k: true } }), {
      a: 'ok',
      n: 2,
      e: 'x',
      l: ['q'],
      o: { k: true },
    });
  });

  it('rejects unknown keys, missing fields and wrong types with the offending path', () => {
    bad({ a: 'ok', typo: 1 }, /typo.*not a recognised field/);
    bad({}, /a: is required/);
    bad({ a: 1 }, /a: must be a string/);
    bad({ a: '' }, /shorter/);
    bad({ a: 'long!' }, /longer/);
    bad({ a: 'ok', n: 1.5 }, /n: must be an integer/);
    bad({ a: 'ok', n: 0 }, />= 1/);
    bad({ a: 'ok', n: 6 }, /<= 5/);
    bad({ a: 'ok', e: 'z' }, /one of x, y/);
    bad({ a: 'ok', l: 'x' }, /l: must be an array/);
    bad({ a: 'ok', l: ['a', 'b', 'c'] }, /more than 2/);
    bad({ a: 'ok', l: [1] }, /l\[0\]: must be a string/);
    bad({ a: 'ok', o: { k: 'yes' } }, /o\.k: must be a boolean/);
    bad({ a: 'ok', o: { z: true } }, /o\.z/);
    bad('nope', /must be an object/);
    bad([], /must be an object/);
  });
});

describe('CLI functions', () => {
  it('one function per command, named like the command; names are unique', () => {
    const names = cli.COMMANDS.map((c) => c.name);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(names.sort(), [
      'add',
      'bootstrap',
      'compact',
      'doctor',
      'edit',
      'forget',
      'get',
      'handoff',
      'inbox',
      'init',
      'propose',
      'purge',
      'recall',
      'reindex',
      'restore',
      'status',
    ]);
    for (const name of names) {
      assert.equal(typeof (cli as unknown as Record<string, unknown>)[name], 'function', name);
    }
  });

  it('shell commands: the read-only diagnostics plus add and handoff; destructive ones take confirm + preview_token', () => {
    assert.deepEqual([...cli.SHELL_COMMANDS].sort(), [
      'add',
      'doctor',
      'handoff',
      'recall',
      'status',
    ]);
    for (const c of cli.COMMANDS) {
      if (c.shell) assert.notEqual(c.access, 'destructive', c.name);
      if (c.access === 'destructive') {
        assert.ok('confirm' in c.input.properties && 'preview_token' in c.input.properties, c.name);
      }
      if (c.access !== 'read')
        assert.ok('request_id' in c.input.properties, `${c.name} takes request_id`);
      assert.ok(c.description.length > 10);
      assert.equal(c.input.additionalProperties, false);
    }
    assert.equal(cli.accessOf('forget'), 'destructive');
    assert.equal(cli.accessOf('nope'), undefined);
  });

  it('runs the whole memory lifecycle through the structured functions', async () => {
    const root = tmpDir();
    const env = { cwd: root, ctx: FAST };
    const init = await ok(cli.init({ git_mode: 'track' }, env));
    assert.equal(init['created'], true);

    const added = await ok(
      cli.add(
        {
          type: 'decision',
          title: 'Use SQLite',
          body: 'We index with SQLite FTS5.',
          scope: { tools: ['sqlite'] },
        },
        env,
      ),
    );
    assert.match(added['id'], /^dec_/);
    assert.ok(added.request_id);

    const got = await ok(cli.get({ id: added['id'] }, env));
    assert.equal(got['title'], 'Use SQLite');

    const edited = await ok(
      cli.edit(
        {
          id: added['id'],
          expected_hash: got['hash'],
          body: 'We index with SQLite FTS5 (trigram).',
        },
        env,
      ),
    );
    assert.equal(edited['changed'], true);
    await fails(
      cli.edit({ id: added['id'], expected_hash: got['hash'], title: 'stale' }, env),
      'HASH_MISMATCH',
    );

    const recalled = await ok(cli.recall({ query: 'trigram' }, env));
    assert.equal(recalled['hits'].length, 1);

    const saved = await ok(
      cli.handoff(
        { action: 'save', task: 'cli-work', content: 'step 1 done', summary: 'cli' },
        env,
      ),
    );
    assert.equal(saved['version'], 1);
    const read = await ok(cli.handoff({ action: 'read', task: 'cli-work' }, env));
    assert.match(read['body'], /step 1 done/);
    const boot = await ok(cli.bootstrap({}, env));
    assert.equal(boot['memory'].counts.decision, 1);
    assert.match(boot['handoffs'].full.body, /step 1 done/);

    const proposed = await ok(cli.propose({ text: 'maybe prefer tabs', source: 'user' }, env));
    assert.equal(proposed['inbox_entries'], 1);
    const inbox = await ok(cli.inbox({}, env));
    assert.equal(inbox['total'], 1);

    // forget: preview, then confirm with the token
    const preview = await ok(cli.forget({ ids: [added['id']] }, env));
    assert.equal(preview['preview'], true);
    await fails(cli.forget({ ids: [added['id']], confirm: true }, env), 'CONFIRM_REQUIRES_TOKEN');
    const done = await ok(
      cli.forget(
        { ids: [added['id']], confirm: true, preview_token: preview['preview_token'] },
        env,
      ),
    );
    assert.ok(!done['preview'], 'executed, not a preview');
    const trash = await ok(cli.restore({}, env));
    assert.equal(trash['entries'].length, 1);
    const restored = await ok(cli.restore({ id: added['id'] }, env));
    assert.equal(restored['restored'], true);

    await ok(cli.reindex({}, env));
    const compact = await ok(cli.compact({}, env));
    assert.equal(compact['preview'], true);
    const purge = await ok(cli.purge({}, env));
    assert.equal(purge['preview'], true);
    const status = await ok(cli.status({}, env));
    assert.equal(status['records'].decision.active, 1);
    const doctor = await ok(cli.doctor({}, env));
    assert.equal(doctor['ok'], true);
  });

  it('echoes request_id and is idempotent on retry', async () => {
    const ctx = await project();
    const env = { root: ctx.root, ctx: FAST };
    const input = { type: 'task', title: 'Once', body: 'only once', request_id: 'cli-retry-1' };
    const first = await ok(cli.add(input, env));
    const second = await ok(cli.add(input, env));
    assert.equal(first.request_id, 'cli-retry-1');
    assert.equal(second['deduped'], true);
    assert.equal(second['id'], first['id']);
    await fails(cli.add({ ...input, title: 'Different' }, env), 'REQUEST_ID_REUSED');
  });

  it('finds the project from a subdirectory; init there reuses the project instead of nesting', async () => {
    const ctx = await project();
    const sub = join(ctx.root, 'packages', 'a');
    mkdirSync(sub, { recursive: true });
    const env = { cwd: sub, ctx: FAST };
    await ok(cli.add({ type: 'knowledge', title: 'From sub', body: 'found upwards' }, env));
    const again = await ok(cli.init({ git_mode: 'track' }, env));
    assert.equal(again['created'], false);
    assert.equal(again['root'], ctx.root);
    await fails(cli.init({ git_mode: 'local' }, env), 'GIT_MODE_CONFLICT');
  });

  it('reports NOT_INITIALIZED outside a project, and bad input as INVALID_ARGUMENT', async () => {
    const env = { cwd: tmpDir(), ctx: FAST };
    await fails(cli.status({}, env), 'NOT_INITIALIZED');
    await fails(cli.init({}, env), 'INVALID_ARGUMENT');
    await fails(cli.init({ git_mode: 'maybe' }, env), 'INVALID_ARGUMENT');
    const ctx = await project();
    const e2 = { root: ctx.root, ctx: FAST };
    await fails(cli.add({ type: 'decision', title: 'x' }, e2), 'INVALID_ARGUMENT');
    await fails(
      cli.add({ type: 'decision', title: 'x', body: 'y', extra: 1 }, e2),
      'INVALID_ARGUMENT',
    );
    await fails(cli.get({ id: 'dec_zzzzzzzzzz' }, e2), 'NOT_FOUND');
    await fails(cli.recall({ limit: 0 }, e2), 'INVALID_ARGUMENT');
  });

  it('run() reports an unknown command and never throws for internal faults', async () => {
    await fails(cli.run('mwf_nope', {}), 'UNKNOWN_COMMAND');
    const err = cli.toError(new Error('boom'));
    assert.deepEqual(err, { code: 'INTERNAL', message: 'boom', details: {} });
    assert.equal(cli.toError('plain').message, 'plain');
  });

  it('surfaces core errors with their code and details (secret scan)', async () => {
    const ctx = await project();
    const env = { root: ctx.root, ctx: FAST };
    const secret = `AKIA${'ABCDEFGHIJKLMNOP'}`;
    const error = await fails(
      cli.add({ type: 'knowledge', title: 'creds', body: `key ${secret}` }, env),
      'SECRET_DETECTED',
    );
    assert.ok(!JSON.stringify(error).includes(secret), 'the secret is not echoed back');
  });

  it('results are plain JSON (MCP can return them as they are)', async () => {
    const ctx = await project();
    const env = { root: ctx.root, ctx: FAST };
    const result = await cli.status({}, env);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });
});

describe('mwf command line', () => {
  it('status prints a readable summary; --json prints the envelope', async () => {
    const ctx = await project();
    await cli.add({ type: 'decision', title: 'Cli seed', body: 'seed' }, { root: ctx.root });
    const text = await sh(['status'], ctx.root);
    assert.equal(text.code, 0);
    assert.match(text.out, /git_mode=track/);
    assert.match(text.out, /decision 1/);
    assert.match(text.out, /lock: free/);
    const json = await sh(['status', '--json'], ctx.root);
    assert.equal(json.code, 0);
    const parsed = JSON.parse(json.out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.records.decision.active, 1);
  });

  it('recall maps flags to the input and renders hits', async () => {
    const ctx = await project();
    const env = { root: ctx.root };
    await cli.add(
      {
        type: 'decision',
        title: 'Pick sqlite',
        body: 'sqlite trigram search',
        scope: { tools: ['db'] },
      },
      env,
    );
    await cli.add({ type: 'preference', title: 'Tabs', body: 'prefer tabs for sqlite files' }, env);
    await cli.handoff({ action: 'save', task: 'job-1', content: 'sqlite migration notes' }, env);

    const all = await sh(['recall', 'sqlite'], ctx.root);
    assert.equal(all.code, 0);
    assert.match(all.out, /Pick sqlite/);
    assert.match(all.out, /Tabs/);
    const typed = await sh(['recall', 'sqlite', '--type', 'preference'], ctx.root);
    assert.doesNotMatch(typed.out, /Pick sqlite/);
    assert.match(typed.out, /Tabs/);
    const scoped = await sh(['recall', '--scope', 'tools=db', '--json'], ctx.root);
    // --scope returns only records whose scope matches (not the unscoped 'Tabs')
    const scopedHits = JSON.parse(scoped.out).data.hits as Array<{ title: string }>;
    assert.deepEqual(
      scopedHits.map((h) => h.title),
      ['Pick sqlite'],
    );
    const noScopeMatch = await sh(['recall', '--scope', 'tools=git', '--json'], ctx.root);
    assert.deepEqual(JSON.parse(noScopeMatch.out).data.hits, []);
    const limited = await sh(['recall', 'sqlite', '--limit', '1', '--json'], ctx.root);
    assert.equal(JSON.parse(limited.out).data.hits.length, 1);
    const handoff = await sh(['recall', '--task', 'job-1'], ctx.root);
    assert.match(handoff.out, /# handoff job-1/);
    assert.match(handoff.out, /migration notes/);
    const withHandoffs = await sh(['recall', 'migration', '--handoffs'], ctx.root);
    assert.match(withHandoffs.out, /job-1/);
    const none = await sh(['recall', 'zzzznothing'], ctx.root);
    assert.match(none.out, /no matches/);
  });

  it('--cwd selects the project (relative to the current directory)', async () => {
    const ctx = await project();
    const parent = join(ctx.root, '..');
    const rel = ctx.root.slice(parent.length + 1);
    const r = await sh(['status', '--cwd', rel], parent);
    assert.equal(r.code, 0, r.err);
  });

  it('doctor exits 0 for a healthy project and 1 when it reports an error', async () => {
    const ctx = await project();
    const good = await sh(['doctor'], ctx.root);
    assert.equal(good.code, 0);
    assert.match(good.out, /error\(s\)|no issues/);
    mkdirSync(join(ctx.root, '.mwf/memory/decisions'), { recursive: true });
    writeFileSync(join(ctx.root, '.mwf/memory/decisions/dec_aaaaaaaaaa.md'), 'not a record');
    const bad = await sh(['doctor'], ctx.root);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /ERROR invalid_record/);
    assert.equal((await sh(['doctor', '--json'], ctx.root)).code, 1);
  });

  it('exit codes and messages: failures 1, usage 2, stdout kept clean of errors', async () => {
    const empty = tmpDir();
    const notInit = await sh(['status'], empty);
    assert.equal(notInit.code, 1);
    assert.match(notInit.err, /NOT_INITIALIZED/);
    // the shell has no init: the hint points at the MCP tool / install, never at "run init"
    assert.match(notInit.err, /MCP tool mwf_init/);
    assert.match(notInit.err, /`mwf install`/);
    assert.match(notInit.err, /no init command/);
    assert.doesNotMatch(notInit.err, /run init/);
    assert.equal(notInit.out, '');
    const json = await sh(['status', '--json'], empty);
    assert.equal(json.code, 1);
    assert.equal(JSON.parse(json.out).error.code, 'NOT_INITIALIZED');

    const ctx = await project();
    for (const argv of [
      ['recall', '--scope', 'nokey=1'],
      ['recall', '--scope', 'tools'],
      ['recall', '--limit', 'ten'],
      ['recall', '--limit', '0'],
      ['recall', '--bogus'],
      ['status', 'extra-positional'],
      ['frobnicate'],
    ]) {
      const r = await sh(argv, ctx.root);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err, /^mwf: /);
    }
  });

  it('writes are not reachable from the shell; later-PR commands say so', async () => {
    const ctx = await project();
    for (const name of [
      'forget',
      'init',
      'purge',
      'edit',
      'propose',
      'inbox',
      'compact',
      'reindex',
      'restore',
    ]) {
      const r = await sh([name], ctx.root);
      assert.equal(r.code, 2);
      assert.match(r.err, /MCP tool/);
    }
    for (const name of ['hook', 'mcp', 'install', 'uninstall', 'update']) {
      const r = await sh([name], ctx.root);
      assert.equal(r.code, 2);
      assert.match(r.err, /not part of this build yet/);
    }
  });

  it('help and version; hook / mcp stay out of --help', async () => {
    const ctx = await project();
    const help = await sh(['--help'], ctx.root);
    assert.equal(help.code, 0);
    assert.match(help.out, /status/);
    assert.match(help.out, /recall/);
    assert.match(help.out, /doctor/);
    assert.doesNotMatch(help.out, /^\s+(hook|mcp)\b/m);
    // "read-only" is about memory: status / recall may recover a crashed write, doctor never writes
    assert.match(help.out, /status and recall may take the project lock and write under \.mwf\//);
    assert.match(help.out, /recover a leftover\s+intent/);
    assert.match(help.out, /doctor never takes the lock or writes/);
    assert.match(help.out, /mwf_init/);
    // writes from the shell: add and handoff, with the retry rule and the secret scan
    assert.match(help.out, /^\s+add\s/m);
    assert.match(help.out, /handoff read\|save/);
    assert.match(help.out, /LOCK_LOST or LOCK_TIMEOUT/);
    assert.match(help.out, /same --request-id/);
    assert.match(help.out, /secret scan/);
    assert.match(help.out, /only records whose scope matches/);
    assert.equal((await sh([], ctx.root)).code, 2);
    assert.equal((await sh(['status', '--help'], ctx.root)).code, 0);
    const version = await sh(['--version'], ctx.root);
    assert.match(version.out, /^\d+\.\d+\.\d+/);
  });

  it('the mwf executable works end to end (type-stripped source)', async () => {
    const ctx = await project();
    await cli.add({ type: 'knowledge', title: 'E2E', body: 'bin check' }, { root: ctx.root });
    const bin = new URL('../src/bin/mwf.ts', import.meta.url).pathname;
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', bin, ...args], {
        cwd: ctx.root,
        encoding: 'utf8',
      });
    const status = run(['status', '--json']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).data.records.knowledge.active, 1);
    const recall = run(['recall', 'bin check']);
    assert.match(recall.stdout, /E2E/);
    const usage = run(['nonsense']);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /unknown command/);
  });
});

describe('CLI read commands and a leftover crash intent', () => {
  it('doctor only reports it; status and recall recover it (take the lock and write)', async () => {
    for (const reader of [['status'], ['recall', 'crash']]) {
      const ctx = await project('track', { waitMs: 5000 });
      await cli.add({ type: 'decision', title: 'Before crash', body: 'seed' }, { root: ctx.root });
      const crashed = await runChild(
        ctx,
        [{ fn: 'add', input: { type: 'decision', title: 'Crash me', body: 'crash body' } }],
        { MWF_FAILPOINT: 'write:target@1' },
      );
      assert.equal(crashed.signal, 'SIGKILL');
      const intent = join(ctx.root, '.mwf/mwf.local.intent.json');
      assert.ok(existsSync(intent), 'the dead writer left an intent');

      const doctor = await sh(['doctor', '--json'], ctx.root);
      assert.ok(existsSync(intent), 'doctor must not recover');
      const codes = (JSON.parse(doctor.out).data.issues as Array<{ code: string }>).map(
        (i) => i.code,
      );
      assert.ok(codes.includes('pending_intent'));

      const read = await sh([...reader, '--json'], ctx.root);
      assert.equal(read.code, 0, read.err);
      assert.equal(existsSync(intent), false, `${reader[0]} recovered the intent`);
      const after = await sh(['doctor', '--json'], ctx.root);
      const codesAfter = (JSON.parse(after.out).data.issues as Array<{ code: string }>).map(
        (i) => i.code,
      );
      assert.equal(codesAfter.includes('pending_intent'), false);
    }
  });
});

describe('mwf add and handoff from the shell', () => {
  const FAKE_SECRET = `AKIA${'ABCDEFGHIJKLMNOP'}`;
  const jsonOf = (r: { out: string }): { ok: boolean; data: Data; error: cli.CliError } =>
    JSON.parse(r.out);

  it('add: flags, body from a file and from stdin, scope, --json; recall finds it', async () => {
    const ctx = await project();
    const a = await sh(
      [
        'add',
        '--type',
        'decision',
        '--title',
        'Use WAL',
        '--body',
        'wal mode for sqlite',
        '--scope',
        'paths=src/core/',
        '--scope',
        'tools=db',
        '--json',
      ],
      ctx.root,
    );
    assert.equal(a.code, 0, a.err);
    const added = jsonOf(a);
    assert.equal(added.ok, true);
    assert.match(added.data['id'], /^dec_/);
    assert.match(String(added.data['request_id']), /^cli-/);
    assert.equal(added.data['deduped'], false);
    const got = await ok(cli.get({ id: added.data['id'] }, { root: ctx.root }));
    assert.equal(got['title'], 'Use WAL');
    assert.deepEqual(got['scope'], { paths: ['src/core/'], tools: ['db'] });

    writeFileSync(join(ctx.root, 'body.md'), 'from a file\n\nwith two paragraphs');
    const f = await sh(
      ['add', '--type', 'knowledge', '--title', 'File body', '--body-file', 'body.md'],
      ctx.root,
    );
    assert.equal(f.code, 0, f.err);
    assert.match(f.out, /^added kn_\w+ \[knowledge\] File body\n/);
    assert.match(f.out, /request_id: cli-/);

    const sub = join(ctx.root, 'sub');
    mkdirSync(sub);
    // file arguments are relative to the shell's directory; --cwd only selects the project
    const viaCwd = await sh(
      [
        'add',
        '--type',
        'knowledge',
        '--title',
        'Relative',
        '--body-file',
        'body.md',
        '--cwd',
        'sub',
      ],
      ctx.root,
    );
    assert.equal(viaCwd.code, 0, viaCwd.err);

    const piped = await sh(
      ['add', '--type', 'preference', '--title', 'Piped', '--body-file', '-'],
      ctx.root,
      'body from stdin with unicode 检索',
    );
    assert.equal(piped.code, 0, piped.err);
    const id = /added (\S+)/.exec(piped.out)![1]!;
    assert.equal(
      (await ok(cli.get({ id }, { root: ctx.root })))['body'],
      'body from stdin with unicode 检索',
    );

    const found = await sh(['recall', 'wal', '--scope', 'paths=src/core/x.ts'], ctx.root);
    assert.match(found.out, /Use WAL/);
    assert.doesNotMatch(found.out, /Piped/);
  });

  it('add: the same --request-id applies once; reusing it for different input fails', async () => {
    const ctx = await project();
    const argv = [
      'add',
      '--type',
      'task',
      '--title',
      'Once',
      '--body',
      'b',
      '--request-id',
      'req-1',
    ];
    const first = await sh([...argv, '--json'], ctx.root);
    const second = await sh([...argv, '--json'], ctx.root);
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.equal(jsonOf(second).data['deduped'], true);
    assert.equal(jsonOf(second).data['id'], jsonOf(first).data['id']);
    assert.match((await sh([...argv], ctx.root)).out, /^already added /);
    const status = jsonOf(await sh(['status', '--json'], ctx.root));
    assert.equal(status.data['records'].task.active, 1);
    const other = await sh(
      [
        'add',
        '--type',
        'task',
        '--title',
        'Different',
        '--body',
        'b',
        '--request-id',
        'req-1',
        '--json',
      ],
      ctx.root,
    );
    assert.equal(other.code, 1);
    assert.equal(jsonOf(other).error.code, 'REQUEST_ID_REUSED');
  });

  it('add: usage errors exit 2 and write nothing', async () => {
    const ctx = await project();
    for (const argv of [
      ['add', '--title', 't', '--body', 'b'],
      ['add', '--type', 'task', '--body', 'b'],
      ['add', '--type', 'task', '--title', 't'],
      ['add', '--type', 'task', '--title', 't', '--body', 'b', '--body-file', 'x'],
      ['add', '--type', 'task', '--title', 't', '--body-file', 'missing.md'],
      ['add', '--type', 'task', '--title', 't', '--body-file', '-'], // no stdin available
      ['add', '--type', 'nonsense', '--title', 't', '--body', 'b'],
      ['add', '--type', 'task', '--title', 'two\nlines', '--body', 'b'],
      ['add', '--type', 'task', '--title', 't', '--body', 'b', '--status', 'bogus'],
      ['add', '--type', 'task', '--title', 't', '--body', 'b', '--wait-ms', 'soon'],
      ['add', '--type', 'task', '--title', 't', '--body', 'b', '--bogus'],
      ['add', '--type', 'task', '--title', 't', '--body', 'b', 'extra'],
      ['add', '--type', 'task', '--title', 't', '--body', 'b', '--scope', 'nokey=x'],
      ['add', '--type', 'task', '--title', 't', '--body', 'b', '--request-id', 'bad id!'],
    ]) {
      const r = await sh(argv, ctx.root);
      assert.equal(r.code, 2, `${argv.join(' ')} -> ${r.err}`);
      assert.match(r.err, /^mwf: /);
      assert.equal(r.out, '');
    }
    const big = await sh(
      ['add', '--type', 'task', '--title', 't', '--body-file', '-'],
      ctx.root,
      'x'.repeat(60_000),
    );
    assert.equal(big.code, 2, 'over core limit is invalid input');
    const status = jsonOf(await sh(['status', '--json'], ctx.root));
    assert.equal(status.data['records'].task.active, 0);
  });

  it('add: the secret scan is unchanged: refused, exit 1, nothing written, value never printed', async () => {
    const ctx = await project();
    for (const extra of [[], ['--json']]) {
      const r = await sh(
        [
          'add',
          '--type',
          'knowledge',
          '--title',
          'creds',
          '--body',
          `key ${FAKE_SECRET}`,
          ...extra,
        ],
        ctx.root,
      );
      assert.equal(r.code, 1);
      assert.doesNotMatch(r.out + r.err, new RegExp(FAKE_SECRET));
      if (extra.length) assert.equal(jsonOf(r).error.code, 'SECRET_DETECTED');
      else assert.match(r.err, /SECRET_DETECTED/);
    }
    const viaStdin = await sh(
      ['add', '--type', 'knowledge', '--title', 'creds', '--body-file', '-'],
      ctx.root,
      `key ${FAKE_SECRET}`,
    );
    assert.equal(viaStdin.code, 1);
    assert.doesNotMatch(viaStdin.out + viaStdin.err, new RegExp(FAKE_SECRET));
    const status = jsonOf(await sh(['status', '--json'], ctx.root));
    assert.equal(status.data['records'].knowledge.active, 0);
  });

  it('a failed write reports its request_id; LOCK_TIMEOUT is repeated with the same one, exactly once', async () => {
    const ctx = await project('track', { waitMs: 5000 });
    const argv = ['add', '--type', 'task', '--title', 'Retry me', '--body', 'b', '--wait-ms', '0'];
    let blocked!: { code: number; out: string; err: string };
    await withLock(ctx, 1000, async () => {
      blocked = await sh(argv, ctx.root);
    });
    assert.equal(blocked.code, 1);
    assert.match(blocked.err, /LOCK_TIMEOUT/);
    const id = /request_id: (cli-\S+) \(repeat the command with --request-id \1/.exec(
      blocked.err,
    )?.[1];
    assert.ok(id, `retry hint with the request id in: ${blocked.err}`);

    await withLock(ctx, 1000, async () => {
      blocked = await sh([...argv, '--json'], ctx.root);
    });
    assert.equal(jsonOf(blocked).error.code, 'LOCK_TIMEOUT');
    assert.match(String(jsonOf(blocked).error.details['request_id']), /^cli-/);

    const retried = await sh([...argv.slice(0, -2), '--request-id', id!, '--json'], ctx.root);
    assert.equal(retried.code, 0, retried.err);
    const again = await sh([...argv.slice(0, -2), '--request-id', id!, '--json'], ctx.root);
    assert.equal(jsonOf(again).data['deduped'], true);
    assert.equal(jsonOf(again).data['id'], jsonOf(retried).data['id']);
    const status = jsonOf(await sh(['status', '--json'], ctx.root));
    assert.equal(status.data['records'].task.active, 1);
  });

  it('a crashed attempt (as after LOCK_LOST) leaves an intent; the same request_id then applies exactly once', async () => {
    const ctx = await project('track', { waitMs: 5000, lockStaleMs: 300 });
    const crashed = await runChild(
      ctx,
      [{ fn: 'add', input: { type: 'task', title: 'Lost', body: 'b', request_id: 'lost-1' } }],
      { MWF_FAILPOINT: 'write:target@1' },
    );
    assert.equal(crashed.signal, 'SIGKILL');
    const retried = await sh(
      [
        'add',
        '--type',
        'task',
        '--title',
        'Lost',
        '--body',
        'b',
        '--request-id',
        'lost-1',
        '--json',
      ],
      ctx.root,
    );
    assert.equal(retried.code, 0, retried.err);
    const again = await sh(
      [
        'add',
        '--type',
        'task',
        '--title',
        'Lost',
        '--body',
        'b',
        '--request-id',
        'lost-1',
        '--json',
      ],
      ctx.root,
    );
    assert.equal(jsonOf(again).data['id'], jsonOf(retried).data['id']);
    const status = jsonOf(await sh(['status', '--json'], ctx.root));
    assert.equal(status.data['records'].task.active, 1);
  });

  it('handoff: save, list, read, version conflict, stdin; usage errors', async () => {
    const ctx = await project();
    const save = await sh(
      ['handoff', 'save', '--task', 'job-9', '--content', 'step one done', '--summary', 'halfway'],
      ctx.root,
    );
    assert.equal(save.code, 0, save.err);
    assert.match(save.out, /^saved handoff job-9 v1 \[active\]/);
    assert.match(save.out, /request_id: cli-/);

    const list = await sh(['handoff', 'read'], ctx.root);
    assert.match(list.out, /job-9 \[active\] v1 · .* · halfway/);
    const listJson = jsonOf(await sh(['handoff', 'read', '--json'], ctx.root));
    assert.equal(listJson.data['items'][0].task, 'job-9');

    const second = await sh(
      [
        'handoff',
        'save',
        '--task',
        'job-9',
        '--content-file',
        '-',
        '--base-version',
        '1',
        '--json',
      ],
      ctx.root,
      'step two done',
    );
    assert.equal(jsonOf(second).data['version'], 2);
    assert.equal(jsonOf(second).data['conflict'], false);

    const stale = await sh(
      ['handoff', 'save', '--task', 'job-9', '--content', 'late writer', '--base-version', '1'],
      ctx.root,
    );
    assert.equal(stale.code, 0, stale.err);
    assert.match(stale.out, /conflict: .*appended as a 「并行更新」 section/);

    const read = await sh(['handoff', 'read', '--task', 'job-9'], ctx.root);
    assert.match(read.out, /^# handoff job-9 \[active\] v3/);
    assert.match(read.out, /step two done/);
    assert.match(read.out, /late writer/);

    const done = await sh(
      ['handoff', 'save', '--task', 'job-9', '--content', 'all done', '--status', 'done', '--json'],
      ctx.root,
    );
    assert.equal(jsonOf(done).data['status'], 'done');
    assert.match((await sh(['handoff', 'read'], ctx.root)).out, /no handoffs/);
    assert.match(
      (await sh(['handoff', 'read', '--status', 'all'], ctx.root)).out,
      /job-9 \[done\]/,
    );

    for (const argv of [
      ['handoff'],
      ['handoff', 'frobnicate'],
      ['handoff', 'read', 'save'],
      ['handoff', 'save', '--content', 'x'],
      ['handoff', 'save', '--task', 't'],
      ['handoff', 'save', '--task', 't', '--content', 'x', '--content-file', 'y'],
      ['handoff', 'save', '--task', 't', '--content', 'x', '--base-version', '-1'],
      ['handoff', 'save', '--task', 'bad task!', '--content', 'x'],
      ['handoff', 'read', '--content', 'x'],
      ['handoff', 'read', '--request-id', 'r'],
      ['handoff', 'save', '--task', 't', '--content', '   '],
    ]) {
      const r = await sh(argv, ctx.root);
      assert.equal(r.code, 2, `${argv.join(' ')} -> ${r.err}`);
    }
    assert.equal(
      (await sh(['handoff', 'read', '--task', 'nonexistent-task-name'], ctx.root)).code,
      1,
    );
  });

  it('handoff save: the secret scan refuses it (exit 1, nothing written)', async () => {
    const ctx = await project();
    const r = await sh(
      ['handoff', 'save', '--task', 'job-s', '--content', `token ${FAKE_SECRET}`],
      ctx.root,
    );
    assert.equal(r.code, 1);
    assert.match(r.err, /SECRET_DETECTED/);
    assert.doesNotMatch(r.out + r.err, new RegExp(FAKE_SECRET));
    assert.match((await sh(['handoff', 'read'], ctx.root)).out, /no handoffs/);
  });

  it('other writes stay MCP-only; the executable pipes stdin through', async () => {
    const ctx = await project();
    for (const name of ['edit', 'propose', 'forget']) {
      const r = await sh([name, '--help'], ctx.root);
      assert.equal(r.code, 2);
    }
    const bin = new URL('../src/bin/mwf.ts', import.meta.url).pathname;
    const spawn = (args: string[], input?: string) =>
      spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', bin, ...args], {
        cwd: ctx.root,
        encoding: 'utf8',
        ...(input === undefined ? {} : { input }),
      });
    const added = spawn(
      ['add', '--type', 'knowledge', '--title', 'Via pipe', '--body-file', '-'],
      'piped body text',
    );
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /added kn_/);
    const saved = spawn(
      ['handoff', 'save', '--task', 'pipe-task', '--content-file', '-', '--json'],
      'handoff body',
    );
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(JSON.parse(saved.stdout).data.version, 1);
    assert.match(spawn(['recall', 'piped body']).stdout, /Via pipe/);
    assert.match(spawn(['recall', '--task', 'pipe-task']).stdout, /handoff body/);
    const secret = spawn(
      ['add', '--type', 'knowledge', '--title', 'c', '--body-file', '-'],
      `k ${FAKE_SECRET}`,
    );
    assert.equal(secret.status, 1);
    assert.doesNotMatch(secret.stdout + secret.stderr, new RegExp(FAKE_SECRET));
  });
});
