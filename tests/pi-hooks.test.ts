import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { add } from '../src/core/index.ts';
import { handleCodex, handlePi, formatPi, type HostOutput } from '../src/hooks/index.ts';
import { project } from './helpers/util.ts';

const BIN = new URL('../src/bin/mwf.ts', import.meta.url).pathname;
const FLAGS = ['--experimental-strip-types', '--no-warnings'];
const json = (o: unknown): string => JSON.stringify(o);
const SID = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

const startInput = (cwd: string, source = 'startup'): string =>
  json({ session_id: SID, cwd, hook_event_name: 'SessionStart', source });
const promptInput = (cwd: string, prompt: string, promptId = `${SID}:1`): string =>
  json({ session_id: SID, prompt_id: promptId, cwd, hook_event_name: 'UserPromptSubmit', prompt });
const stopInput = (cwd: string, promptId = `${SID}:1`, extra: object = {}): string =>
  json({
    session_id: SID,
    prompt_id: promptId,
    cwd,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    ...extra,
  });

async function seeded() {
  const ctx = await project();
  await add(ctx, {
    type: 'decision',
    title: 'Use SQLite for the index',
    body: 'We chose sqlite because it ships with node.',
  });
  return ctx;
}
const contextOf = (out: HostOutput): string => out.hookSpecificOutput?.additionalContext ?? '';
const stateOf = (root: string): string => {
  const path = join(root, '.mwf', 'state.toml');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

describe('Pi hooks adapter (mwf hook <event> --host pi)', () => {
  it('SessionStart and prompt: the shared context format, tools named mcp__mwf__mwf_*', async () => {
    const ctx = await seeded();
    const start = await handlePi('session-start', startInput(ctx.root));
    const text = contextOf(start!.output);
    assert.match(text, /do not call `mcp__mwf__mwf_bootstrap` again/);
    assert.ok(!/(?<!mcp__mwf__)\bmwf_bootstrap\b/.test(text));
    assert.equal(start!.output.hookSpecificOutput!.hookEventName, 'SessionStart');
    const prompt = await handlePi('prompt', promptInput(ctx.root, 'remind me why sqlite'));
    assert.match(contextOf(prompt!.output), /SQLite/);
    // Codex keeps bare names: the Pi adapter is its own profile
    const codex = await handleCodex('session-start', startInput(ctx.root));
    assert.match(contextOf(codex!.output), /do not call `mwf_bootstrap` again/);
  });

  it('skips the user’s own /mwf commands and /skill:mwf lines, not other lines', async () => {
    const ctx = await seeded();
    for (const line of ['/mwf save x', '/mwf', '/mwf-save', '/skill:mwf-save', '/skill:mwf']) {
      const out = await handlePi('prompt', promptInput(ctx.root, line));
      assert.deepEqual(out!.output, {}, line);
    }
    for (const line of ['/mwfx', '/skill:other', 'sqlite please']) {
      const out = await handlePi('prompt', promptInput(ctx.root, line));
      assert.ok(out, line);
    }
  });

  it('Stop: a block with reason once per prompt_id (the turn key); a new prompt is asked again', async () => {
    const ctx = await seeded();
    const first = await handlePi('stop', stopInput(ctx.root));
    assert.equal(first!.output.decision, 'block');
    assert.match(first!.output.reason!, /mwf end-of-turn check/);
    assert.match(first!.output.reason!, /mcp__mwf__mwf_handoff/);
    assert.match(stateOf(ctx.root), /stop_turn = "[0-9a-f]{24}"/);
    assert.deepEqual((await handlePi('stop', stopInput(ctx.root)))!.output, {});
    const next = await handlePi('stop', stopInput(ctx.root, `${SID}:2`));
    assert.equal(next!.output.decision, 'block');
  });

  it('Stop never continues without a session id or with stop_hook_active not exactly false', async () => {
    const ctx = await seeded();
    const noSession = json({
      cwd: ctx.root,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      prompt_id: 'p',
    });
    assert.deepEqual((await handlePi('stop', noSession))!.output, {});
    for (const extra of [
      { stop_hook_active: true },
      { stop_hook_active: undefined },
      { stop_hook_active: 'no' },
    ]) {
      const out = await handlePi('stop', stopInput(ctx.root, `${SID}:9`, extra));
      assert.deepEqual(out!.output, {}, JSON.stringify(extra));
    }
  });

  it('formatPi: nothing to say is {}', () => {
    assert.deepEqual(formatPi('stop', {}), {});
    assert.deepEqual(formatPi('prompt', {}), {});
  });

  it('a Stop sent under another event name does nothing; garbage input is null', async () => {
    const ctx = await seeded();
    assert.deepEqual(
      (await handlePi(
        'stop',
        stopInput(ctx.root, `${SID}:3`, { hook_event_name: 'SessionStart' }),
      ))!.output,
      {},
    );
    assert.equal(await handlePi('stop', 'not json'), null);
  });

  it('real process: --host pi answers one JSON line, registers the host as pi, exits 0', async () => {
    const ctx = await seeded();
    const run = (event: string, input: string) =>
      spawnSync(process.execPath, [...FLAGS, BIN, 'hook', event, '--host', 'pi'], {
        cwd: ctx.root,
        input,
        encoding: 'utf8',
        timeout: 20_000,
      });
    const start = run('session-start', startInput(ctx.root));
    assert.equal(start.status, 0, start.stderr);
    assert.equal(start.stdout.trim().split('\n').length, 1);
    assert.match(
      JSON.parse(start.stdout).hookSpecificOutput.additionalContext,
      /mcp__mwf__mwf_bootstrap/,
    );
    assert.match(readFileSync(join(ctx.root, '.mwf', 'host.local.toml'), 'utf8'), /pi/);
    const stop = run('stop', stopInput(ctx.root));
    assert.equal(JSON.parse(stop.stdout).decision, 'block');
    assert.deepEqual(JSON.parse(run('stop', stopInput(ctx.root)).stdout), {});
    const garbage = run('prompt', 'garbage');
    assert.equal(garbage.status, 0);
    assert.equal(JSON.parse(garbage.stdout.trim()).systemMessage !== undefined, true);
  });
});
