import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as cli from '../src/cli/index.ts';
import { callTool, MAX_WAIT_MS, TOOLS, type ToolResult } from '../src/mcp/index.ts';
import { hostFromClientName } from '../src/mcp/server.ts';
import { gitRepo, project, tmpDir } from './helpers/util.ts';

const BIN = new URL('../src/bin/mwf.ts', import.meta.url).pathname;
const NODE_FLAGS = ['--experimental-strip-types', '--no-warnings'];

type Data = Record<string, any>;

function data(result: ToolResult): Data {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.ok(result.structuredContent.ok);
  return result.structuredContent.data as Data;
}

function errorOf(result: ToolResult): Data {
  assert.equal(result.isError, true);
  assert.ok(!result.structuredContent.ok);
  return result.structuredContent.error as Data;
}

/** A project plus an env to call tools against it. */
async function setup() {
  const ctx = await project();
  return { root: ctx.root, env: { cwd: ctx.root } };
}

/** `mwf` on PATH that runs this checkout, so a printed `execute_with` command runs as the user would. */
function mwfOnPath(): string {
  const dir = tmpDir('mwf-bin-');
  const script = join(dir, 'mwf');
  writeFileSync(
    script,
    `#!/bin/sh\nexec "${process.execPath}" ${NODE_FLAGS.join(' ')} "${BIN}" "$@"\n`,
  );
  chmodSync(script, 0o755);
  return dir;
}

function shell(command: string, cwd: string, binDir: string) {
  return spawnSync('sh', ['-c', command], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env['PATH']}` },
  });
}

describe('tool registry', () => {
  it('has one mwf_<command> tool per CLI command, with object schemas and annotations', () => {
    assert.deepEqual(
      TOOLS.map((t) => t.name),
      cli.COMMANDS.map((c) => `mwf_${c.name}`),
    );
    assert.equal(TOOLS.length, 16);
    for (const tool of TOOLS) {
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.ok(tool.description.length > 20, tool.name);
      assert.equal(tool.annotations.openWorldHint, false);
      assert.equal(tool.annotations.destructiveHint, false, 'nothing destructive can run here');
    }
  });

  it('read tools say they may take the lock and write .mwf/; doctor says it never does', () => {
    for (const name of ['mwf_recall', 'mwf_status', 'mwf_bootstrap', 'mwf_get']) {
      const tool = TOOLS.find((t) => t.name === name)!;
      assert.match(
        tool.description,
        /Does not change memory content but may take the lock and write \.mwf\//,
        name,
      );
      assert.equal(tool.annotations.readOnlyHint, true, name);
    }
    const doctor = TOOLS.find((t) => t.name === 'mwf_doctor')!;
    assert.match(doctor.description, /Never takes the lock and never writes/);
  });

  it('destructive tools advertise no confirm / preview_token and say they only preview', () => {
    for (const name of ['mwf_forget', 'mwf_purge', 'mwf_compact', 'mwf_inbox']) {
      const tool = TOOLS.find((t) => t.name === name)!;
      const props = tool.inputSchema['properties'] as Record<string, unknown>;
      assert.equal('confirm' in props, false, name);
      assert.equal('preview_token' in props, false, name);
      assert.match(tool.description, /PREVIEW ONLY/, name);
    }
    assert.equal(TOOLS.find((t) => t.name === 'mwf_add')!.annotations.readOnlyHint, false);
    assert.equal(TOOLS.find((t) => t.name === 'mwf_inbox')!.annotations.readOnlyHint, false);
    assert.equal(TOOLS.find((t) => t.name === 'mwf_forget')!.annotations.readOnlyHint, true);
  });

  it('no tool takes a project path; wait_ms is capped below the host timeout', () => {
    for (const tool of TOOLS) {
      const props = tool.inputSchema['properties'] as Record<string, any>;
      for (const key of ['project_root', 'root', 'cwd', 'path']) {
        assert.equal(key in props, false, `${tool.name} has ${key}`);
      }
      if (props['wait_ms']) assert.equal(props['wait_ms'].maximum, MAX_WAIT_MS);
    }
    assert.ok(MAX_WAIT_MS < 60_000);
  });
});

describe('callTool: results and errors', () => {
  it('init works at a git root and refuses elsewhere, writing nothing', async () => {
    const root = gitRepo();
    const sub = join(root, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const refused = errorOf(await callTool('mwf_init', { git_mode: 'track' }, { cwd: sub }));
    assert.equal(refused['code'], 'NOT_GIT_ROOT');
    assert.equal(refused['retryable'], false);
    assert.match(refused['hint'], /root of a git repository/);
    assert.equal(existsSync(join(sub, '.mwf')), false);
    assert.equal(existsSync(join(root, '.mwf')), false);

    const none = tmpDir();
    assert.equal(
      errorOf(await callTool('mwf_init', { git_mode: 'track' }, { cwd: none }))['code'],
      'NOT_GIT_ROOT',
    );
    assert.deepEqual(readdirSync(none), []);

    const made = data(await callTool('mwf_init', { git_mode: 'track' }, { cwd: root }));
    assert.equal(made['git_mode'], 'track');
    assert.ok(existsSync(join(root, '.mwf')));
    // other tools find the project from a subdirectory
    assert.ok(data(await callTool('mwf_status', {}, { cwd: sub })));
  });

  it('text and structuredContent carry the same envelope; failures set isError', async () => {
    const { env } = await setup();
    const added = await callTool(
      'mwf_add',
      { type: 'decision', title: 'Use SQLite', body: 'for the index' },
      env,
    );
    assert.deepEqual(JSON.parse(added.content[0]!.text), added.structuredContent);
    const id = data(added)['id'];
    const got = data(await callTool('mwf_get', { id }, env));
    assert.equal(got['title'], 'Use SQLite');

    const missing = await callTool('mwf_get', { id: 'nope' }, env);
    assert.equal(missing.isError, true);
    assert.match(missing.content[0]!.text, /^(NOT_FOUND|INVALID_ARGUMENT): /);
  });

  it('errors tell the agent what to do', async () => {
    const empty = { cwd: tmpDir() };
    const e = errorOf(await callTool('mwf_status', {}, empty));
    assert.equal(e['code'], 'NOT_INITIALIZED');
    assert.match(e['hint'], /ask the user/);
    assert.equal(e['retryable'], false);

    const { env } = await setup();
    const bad = errorOf(await callTool('mwf_add', { type: 'decision', title: 'x' }, env));
    assert.equal(bad['code'], 'INVALID_ARGUMENT');
    assert.match(bad['details']['request_id'] ?? 'cli-', /^cli-/);

    const secret = errorOf(
      await callTool(
        'mwf_add',
        { type: 'knowledge', title: 'key', body: 'AKIAIOSFODNN7EXAMPLE and more' },
        env,
      ),
    );
    assert.equal(secret['code'], 'SECRET_DETECTED');
    assert.match(secret['hint'], /Remove or redact/);
  });

  it('unknown tools and non-object arguments are errors, not throws', async () => {
    const { env } = await setup();
    assert.equal(errorOf(await callTool('mwf_nope', {}, env))['code'], 'UNKNOWN_COMMAND');
    assert.equal(errorOf(await callTool('mwf_status', [], env))['code'], 'INVALID_ARGUMENT');
    assert.equal(errorOf(await callTool('mwf_status', 'x', env))['code'], 'INVALID_ARGUMENT');
    assert.ok(data(await callTool('mwf_status', undefined, env)));
    assert.ok(data(await callTool('mwf_status', null, env)));
  });

  it('an oversized wait_ms is clamped, not rejected', async () => {
    const { env } = await setup();
    const added = await callTool(
      'mwf_add',
      { type: 'knowledge', title: 'W', body: 'w', wait_ms: 10_000_000 },
      env,
    );
    assert.ok(data(added)['id']);
  });

  it('parallel writes are serialized and all succeed', async () => {
    const { env, root } = await setup();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        callTool('mwf_add', { type: 'knowledge', title: `Fact ${i}`, body: `body ${i}` }, env),
      ),
    );
    const ids = results.map((r) => data(r)['id']);
    assert.equal(new Set(ids).size, 8);
    const recalled = data(await callTool('mwf_recall', { query: 'body' }, { cwd: root }));
    assert.equal(recalled['hits'].length, 8);
  });
});

describe('request_id: a replayed write takes effect once', () => {
  it('the same request_id and arguments through MCP is deduped', async () => {
    const { env } = await setup();
    const args = {
      type: 'knowledge',
      title: 'Once',
      body: 'only once',
      request_id: 'mcp-replay-1',
    };
    const first = data(await callTool('mwf_add', args, env));
    const second = data(await callTool('mwf_add', args, env));
    assert.equal(first['deduped'], false);
    assert.equal(second['deduped'], true);
    assert.equal(second['id'], first['id']);
    const recalled = data(await callTool('mwf_recall', { query: 'only once' }, env));
    assert.equal(recalled['hits'].length, 1);
  });

  it('the same request_id for different arguments is refused', async () => {
    const { env } = await setup();
    data(
      await callTool(
        'mwf_add',
        { type: 'knowledge', title: 'A', body: 'a', request_id: 'mcp-replay-2' },
        env,
      ),
    );
    const clash = errorOf(
      await callTool(
        'mwf_add',
        { type: 'knowledge', title: 'B', body: 'b', request_id: 'mcp-replay-2' },
        env,
      ),
    );
    assert.equal(clash['code'], 'REQUEST_ID_REUSED');
  });

  it('a call without one gets a generated id, reported on failure for a retry', async () => {
    const { env } = await setup();
    const ok = data(await callTool('mwf_add', { type: 'knowledge', title: 'G', body: 'g' }, env));
    assert.match(ok['request_id'], /^cli-/);
  });
});

describe('destructive tools only preview', () => {
  async function seeded() {
    const { env, root } = await setup();
    const id = data(
      await callTool('mwf_add', { type: 'knowledge', title: 'Keep me', body: 'precious' }, env),
    )['id'] as string;
    return { env, root, id };
  }
  const active = async (env: { cwd: string }) =>
    (data(await callTool('mwf_recall', { query: 'precious' }, env))['hits'] as unknown[]).length;

  it('forget previews with a token and the shell command, and changes nothing', async () => {
    const { env, id } = await seeded();
    const preview = data(await callTool('mwf_forget', { ids: [id], reason: 'obsolete' }, env));
    assert.equal(preview['preview'], true);
    assert.match(preview['preview_token'], /^[0-9a-f]{32}$/);
    assert.match(
      preview['execute_with'],
      new RegExp(
        `^mwf forget --id ${id} --reason obsolete .*--confirm --preview-token ${preview['preview_token']}$`,
      ),
    );
    assert.match(preview['note'], /only previews/);
    assert.equal(await active(env), 1);
  });

  it('confirm and preview_token are refused, and nothing is deleted', async () => {
    const { env, id } = await seeded();
    const token = data(await callTool('mwf_forget', { ids: [id] }, env))['preview_token'];
    for (const extra of [
      { confirm: true },
      { confirm: true, preview_token: token },
      { preview_token: token },
    ]) {
      const e = errorOf(await callTool('mwf_forget', { ids: [id], ...extra }, env));
      assert.equal(e['code'], 'INVALID_ARGUMENT');
      assert.match(e['message'], /only previews/);
    }
    for (const tool of ['mwf_purge', 'mwf_compact', 'mwf_inbox']) {
      const e = errorOf(await callTool(tool, { confirm: true }, env));
      assert.equal(e['code'], 'INVALID_ARGUMENT', tool);
    }
    assert.equal(await active(env), 1);
  });

  it('purge, compact and inbox discard preview too and keep their data', async () => {
    const { env, root, id } = await seeded();
    await callTool('mwf_add', { type: 'knowledge', title: 'Keep me', body: 'precious' }, env);
    const entry = data(await callTool('mwf_propose', { text: 'maybe?' }, env))['entry_id'];
    const compact = data(await callTool('mwf_compact', {}, env));
    assert.equal(compact['preview'], true);
    assert.match(compact['execute_with'], /^mwf compact .*--confirm --preview-token /);
    const discard = data(
      await callTool('mwf_inbox', { action: 'discard', entry_ids: [entry] }, env),
    );
    assert.equal(discard['preview'], true);
    assert.match(discard['execute_with'], /^mwf inbox discard --entry-id /);
    assert.equal(data(await callTool('mwf_inbox', {}, env))['total'], 1);

    // something in the trash: forget it through the CLI (shell-equivalent), then preview a purge over MCP
    const cliEnv = { root };
    const t = (await cli.run('forget', { ids: [id] }, cliEnv)) as { ok: true; data: Data };
    await cli.run(
      'forget',
      { ids: [id], confirm: true, preview_token: t.data['preview_token'] },
      cliEnv,
    );
    const purge = data(await callTool('mwf_purge', { ids: [id] }, env));
    assert.equal(purge['preview'], true);
    assert.match(purge['execute_with'], new RegExp(`^mwf purge --id ${id} `));
    const trash = data(await callTool('mwf_restore', {}, env));
    assert.equal((trash['entries'] as unknown[]).length, 1, 'still in the trash');
    assert.equal(await active(env), 1, 'the duplicate record is untouched by compact');
  });

  it('the printed command is refused when run from a pipe or an agent shell, and deletes nothing', async () => {
    const { env, root, id } = await seeded();
    const preview = data(
      await callTool('mwf_forget', { ids: [id], reason: 'it is "old"; $(rm -rf x)' }, env),
    );
    const bin = mwfOnPath();
    for (const command of [
      preview['execute_with'],
      `echo y | ${preview['execute_with']}`,
      `${preview['execute_with']} < /dev/null`,
    ]) {
      const ran = shell(command, root, bin);
      assert.equal(ran.status, 1, ran.stdout + ran.stderr);
      assert.match(ran.stderr, /CONFIRM_REQUIRES_TTY/);
      assert.equal(await active(env), 1, 'still there');
    }
    assert.equal(existsSync(join(root, 'x')), false);
    const trash = data(await callTool('mwf_restore', {}, env));
    assert.equal((trash['entries'] as unknown[]).length, 0);
  });

  it(
    'the printed command executes it in a terminal, and only there',
    {
      skip: spawnSync('script', ['--version'], { encoding: 'utf8' }).status !== 0,
    },
    async () => {
      const { env, root, id } = await seeded();
      const preview = data(
        await callTool('mwf_forget', { ids: [id], reason: 'it is "old"; $(rm -rf x)' }, env),
      );
      const bin = mwfOnPath();
      // `script` gives the command a pseudo terminal, which is what a person's terminal is
      const ran = spawnSync('script', ['-qec', preview['execute_with'], '/dev/null'], {
        cwd: root,
        encoding: 'utf8',
        input: '',
        env: { ...process.env, PATH: `${bin}:${process.env['PATH']}` },
      });
      assert.equal(ran.status, 0, ran.stdout + ran.stderr);
      assert.equal(await active(env), 0);
      assert.equal(existsSync(join(root, 'x')), false);
      const trash = data(await callTool('mwf_restore', {}, env));
      assert.equal((trash['entries'] as unknown[]).length, 1);
    },
  );

  it('the notes tell the user to run it in their own terminal; nothing offers host approval', async () => {
    const { env, id } = await seeded();
    const preview = data(await callTool('mwf_forget', { ids: [id] }, env));
    assert.match(preview['note'], /themselves in their own terminal/);
    assert.match(preview['note'], /do not run it from your shell/);
    assert.doesNotMatch(preview['note'], /approve/i);
    for (const name of ['mwf_forget', 'mwf_purge', 'mwf_compact', 'mwf_inbox']) {
      const description = TOOLS.find((t) => t.name === name)!.description;
      assert.match(description, /own terminal/, name);
      assert.doesNotMatch(description, /approv/i, name);
    }
  });
});

describe('hostFromClientName', () => {
  it('turns client names into host names', () => {
    assert.equal(hostFromClientName('codex-mcp-client'), 'codex-mcp-client');
    assert.equal(hostFromClientName('Codex CLI'), 'codex-cli');
    assert.equal(hostFromClientName('9 lives'), 'lives');
    assert.equal(hostFromClientName(''), null);
    assert.equal(hostFromClientName(undefined), null);
    assert.equal(hostFromClientName('###'), null);
    assert.ok((hostFromClientName('x'.repeat(80)) ?? '').length <= 31);
  });
});

// ---- the real server over stdio ----

async function connect(
  cwd: string,
  options: { args?: string[]; env?: Record<string, string>; clientName?: string } = {},
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...NODE_FLAGS, BIN, 'mcp', ...(options.args ?? [])],
    cwd,
    env: options.env ?? {},
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => (stderr += String(chunk)));
  const client = new Client({ name: options.clientName ?? 'mwf-test-client', version: '1.0.0' });
  const started = performance.now();
  await client.connect(transport);
  return {
    client,
    transport,
    startupMs: performance.now() - started,
    stderr: () => stderr,
  };
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>;

describe('mwf mcp over stdio', () => {
  it('handshakes, lists the tools, serves calls and exits when stdin closes', async () => {
    const { root } = await setup();
    const s = await connect(root);
    try {
      assert.ok(
        s.startupMs < 10_000,
        `ready within the host's 10 s (${s.startupMs.toFixed(0)} ms)`,
      );
      console.log(`# mwf mcp ready in ${s.startupMs.toFixed(0)} ms`);
      assert.equal(s.client.getServerVersion()?.name, 'mwf');
      assert.match(s.client.getInstructions() ?? '', /mwf_bootstrap/);
      const { tools } = await s.client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        TOOLS.map((t) => t.name),
      );
      assert.equal(tools.find((t) => t.name === 'mwf_recall')?.annotations?.readOnlyHint, true);

      const added = await call(s.client, 'mwf_add', {
        type: 'decision',
        title: 'Wire check',
        body: 'over the wire',
      });
      assert.ok(added.structuredContent.ok);
      const recalled = data(await call(s.client, 'mwf_recall', { query: 'over the wire' }));
      assert.equal(recalled['hits'].length, 1);
      const refused = await call(s.client, 'mwf_forget', { id: 'x', confirm: true });
      assert.equal(refused.isError, true);
      const bad = await call(s.client, 'mwf_get', { id: 7 });
      assert.equal(bad.isError, true);
      assert.match(bad.content[0]!.text, /^INVALID_ARGUMENT: /);
      // a non-numeric wait_ms is rejected by the schema, not coerced or clamped
      for (const wait_ms of ['abc', '5', null, {}, [1]]) {
        const worse = await call(s.client, 'mwf_add', {
          type: 'knowledge',
          title: 'W',
          body: 'w',
          wait_ms,
        });
        assert.equal(worse.isError, true, JSON.stringify(wait_ms));
        assert.match(
          worse.content[0]!.text,
          /^INVALID_ARGUMENT: .*wait_ms/,
          JSON.stringify(wait_ms),
        );
      }
    } finally {
      await s.client.close();
    }
    assert.equal(s.stderr(), '', 'stdout is protocol only and stderr is quiet');
  });

  it('registers the host (--host, else the client name) after the first call', async () => {
    const a = await setup();
    const s = await connect(a.root, { args: ['--host', 'codex'], clientName: 'whatever' });
    try {
      await call(s.client, 'mwf_status');
      await call(s.client, 'mwf_status');
    } finally {
      await s.client.close();
    }
    const hostFile = join(a.root, '.mwf', 'host.local.toml');
    await waitFor(() => existsSync(hostFile));
    assert.match(readFileSync(hostFile, 'utf8'), /\[hosts\.codex\]\s+mcp = /);

    const b = await setup();
    const t = await connect(b.root, { clientName: 'Codex CLI' });
    try {
      await call(t.client, 'mwf_status');
    } finally {
      await t.client.close();
    }
    await waitFor(() => existsSync(join(b.root, '.mwf', 'host.local.toml')));
    assert.match(
      readFileSync(join(b.root, '.mwf', 'host.local.toml'), 'utf8'),
      /\[hosts\.codex-cli\]/,
    );
  });

  it('registers the host only once the project exists', async () => {
    const root = gitRepo();
    const s = await connect(root, { args: ['--host', 'pi'] });
    try {
      assert.equal((await call(s.client, 'mwf_status')).isError, true);
      assert.equal(existsSync(join(root, '.mwf')), false);
      data(await call(s.client, 'mwf_init', { git_mode: 'track' }));
      await waitFor(() => existsSync(join(root, '.mwf', 'host.local.toml')));
    } finally {
      await s.client.close();
    }
    assert.match(readFileSync(join(root, '.mwf', 'host.local.toml'), 'utf8'), /\[hosts\.pi\]/);
  });

  it('rejects bad arguments on the command line', () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [...NODE_FLAGS, BIN, 'mcp', ...args], { encoding: 'utf8' });
    const bad = run('--host', 'Not Valid');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--host/);
    assert.equal(bad.stdout, '');
    assert.equal(run('--wat').status, 2);
    assert.equal(run('--help').status, 0);
  });

  it('SIGTERM in the middle of a write leaves lock + intent that the next process recovers', async () => {
    const { root } = await setup();
    const request = {
      type: 'decision',
      title: 'Torn',
      body: 'killed mid-write',
      request_id: 'sigterm-1',
    };
    const s = await connect(root, {
      env: { MWF_FAILPOINT: 'write:target', MWF_FAILPOINT_STALL: '60000' },
    });
    const pid = s.transport.pid;
    assert.ok(pid);
    const exited = new Promise<void>((resolve) => (s.transport.onclose = resolve));
    const abort = new AbortController();
    const pending = s.client
      .callTool({ name: 'mwf_add', arguments: request }, { signal: abort.signal })
      .catch(() => null);
    await waitFor(() => s.stderr().includes('failpoint-stalled write:target'), 15_000);
    process.kill(pid, 'SIGTERM');
    await exited;
    abort.abort();
    await s.client.close().catch(() => undefined);
    assert.equal(await pending, null, 'the interrupted call never got an answer');

    const mwf = join(root, '.mwf');
    assert.ok(existsSync(join(mwf, 'mwf.local.lock')), 'the lock was left behind');
    assert.ok(existsSync(join(mwf, 'mwf.local.intent.json')), 'the intent was left behind');

    const next = await connect(root);
    try {
      // the same request, replayed: recovered, applied exactly once
      const replay = data(await call(next.client, 'mwf_add', request));
      assert.ok(replay['id']);
      const recalled = data(await call(next.client, 'mwf_recall', { query: 'killed mid-write' }));
      assert.equal(recalled['hits'].length, 1);
      const doctor = data(await call(next.client, 'mwf_doctor'));
      assert.deepEqual(
        (doctor['issues'] as Array<{ level: string }>).filter((i) => i.level !== 'info'),
        [],
      );
    } finally {
      await next.client.close();
    }
    assert.equal(existsSync(join(mwf, 'mwf.local.lock')), false, 'no lock left');
    assert.equal(existsSync(join(mwf, 'mwf.local.intent.json')), false, 'no intent left');
  });
});

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
