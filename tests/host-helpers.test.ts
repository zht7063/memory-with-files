import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as cli from '../src/cli/index.ts';
import * as mcp from '../src/mcp/index.ts';
import { gitRepo, project } from './helpers/util.ts';

describe('cli getSession / setSession (host helpers for hooks)', () => {
  it('are exported by the cli and re-exported by mcp, and are not commands or tools', () => {
    assert.equal(mcp.getSession, cli.getSession);
    assert.equal(mcp.setSession, cli.setSession);
    assert.equal(mcp.confirmHost, cli.confirmHost);
    for (const name of ['getSession', 'setSession', 'confirmHost', 'session', 'host']) {
      assert.ok(!cli.COMMANDS.some((c) => c.name === name), name);
    }
    assert.ok(!mcp.TOOLS.some((t) => /session|host/i.test(t.name)));
    assert.ok(!cli.SHELL_COMMANDS.some((n) => /session|host/i.test(n)));
  });

  it('round-trip a session through state.toml, never throwing', async () => {
    const ctx = await project();
    const env = { cwd: ctx.root };
    const none = await cli.getSession('s1', env);
    assert.deepEqual(none, { ok: true, data: { session: null } });
    const set = await cli.setSession(
      { session_id: 's1', injected: ['a', 'b'], handoff: 'task-1', stop_turn: 'turn-1' },
      env,
    );
    assert.ok(set.ok);
    assert.equal((set.data as { claimed: boolean }).claimed, true);
    const got = await cli.getSession('s1', env);
    assert.ok(got.ok);
    assert.deepEqual((got.data as any).session.injected, ['a', 'b']);
    assert.equal((got.data as any).session.handoff, 'task-1');
    assert.equal((got.data as any).session.stop_turn, 'turn-1');
    assert.match(
      readFileSync(join(ctx.root, '.mwf', 'state.toml'), 'utf8'),
      /stop_turn = "turn-1"/,
    );
    // a later partial update keeps the rest
    await cli.setSession({ session_id: 's1', injected: ['c'] }, env);
    const after = (await cli.getSession('s1', env)) as any;
    assert.equal(after.data.session.handoff, 'task-1');
    assert.equal(after.data.session.stop_turn, 'turn-1');
    assert.deepEqual(after.data.session.injected, ['c']);
  });

  it('report failures as {ok:false}, not exceptions', async () => {
    const empty = { cwd: gitRepo() };
    const a = await cli.getSession('s1', empty);
    assert.ok(!a.ok && a.error.code === 'NOT_INITIALIZED');
    const b = await cli.setSession({ session_id: 's1' }, empty);
    assert.ok(!b.ok && b.error.code === 'NOT_INITIALIZED');
    const ctx = await project();
    const bad = await cli.setSession({ session_id: 'no spaces allowed' }, { cwd: ctx.root });
    assert.ok(!bad.ok && bad.error.code === 'INVALID_ARGUMENT');
    const badTurn = await cli.setSession({ session_id: 's', stop_turn: 'a b' }, { cwd: ctx.root });
    assert.ok(!badTurn.ok);
  });

  it('status reports the hook switches (default on)', async () => {
    const ctx = await project();
    const result = await cli.status({}, { cwd: ctx.root });
    assert.ok(result.ok);
    assert.deepEqual((result.data as any).hooks, { stop: true });
  });
});
