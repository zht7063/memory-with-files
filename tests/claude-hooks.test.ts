import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { add, handoff } from '../src/core/index.ts';
import {
  CLAUDE_CONTEXT_LIMIT,
  CLAUDE_CONTEXT_MAX,
  FAILURE_NOTICE,
  HOOK_DEADLINE_MS,
  PROMPT_CHARS,
  SESSION_START_CHARS,
  UNINITIALIZED_NOTICE,
  fence,
  fallbackOutput,
  formatClaude,
  handleClaude,
  handleCodex,
  isClaudeStopStyle,
  turnKey,
  type HostOutput,
} from '../src/hooks/index.ts';
import { TOOLS } from '../src/mcp/index.ts';
import { ENTRY, SKILLS, renderForHost, renderSkillMd } from '../src/skills/index.ts';
import { gitRepo, project, tmpDir } from './helpers/util.ts';

const BIN = new URL('../src/bin/mwf.ts', import.meta.url).pathname;
const FLAGS = ['--experimental-strip-types', '--no-warnings'];
const toolNames = new Set(TOOLS.map((t) => t.name));

const json = (o: unknown): string => JSON.stringify(o);
const startInput = (cwd: string, source?: string, extra: object = {}): string =>
  json({
    session_id: 'cc-1',
    transcript_path: '/tmp/none.jsonl',
    cwd,
    permission_mode: 'default',
    hook_event_name: 'SessionStart',
    ...(source !== undefined ? { source } : {}),
    ...extra,
  });
const promptInput = (cwd: string, prompt: string, sid = 'cc-1'): string =>
  json({
    session_id: sid,
    prompt_id: '11111111-1111-4111-8111-111111111111',
    cwd,
    hook_event_name: 'UserPromptSubmit',
    prompt,
  });
const stopInput = (cwd: string, extra: object = {}): string =>
  json({
    session_id: 'cc-1',
    prompt_id: '22222222-2222-4222-8222-222222222222',
    cwd,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'done',
    background_tasks: [],
    session_crons: [],
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

describe('tool names per host (D8)', () => {
  it('Claude Code gets mcp__mwf__ names; Codex and others get the text unchanged', () => {
    const text = 'call mwf_recall, then `mwf_save`; also mwf_* and (mwf_bootstrap).';
    assert.equal(
      renderForHost(text, 'claude'),
      'call mcp__mwf__mwf_recall, then `mcp__mwf__mwf_save`; also mcp__mwf__mwf_* and (mcp__mwf__mwf_bootstrap).',
    );
    for (const host of ['codex', 'pi', undefined]) assert.equal(renderForHost(text, host), text);
  });

  it('is idempotent and leaves look-alikes alone', () => {
    const once = renderForHost('use mwf_recall', 'claude');
    assert.equal(renderForHost(once, 'claude'), once);
    assert.equal(
      renderForHost('xmwf_recall my_mwf_recall mwf recall mwf_', 'claude'),
      'xmwf_recall my_mwf_recall mwf recall mwf_',
    );
  });

  it('every rendered tool name is a real MCP tool; no bare name is left in a Claude SKILL.md', () => {
    for (const skill of SKILLS) {
      const md = renderSkillMd(skill, 'claude');
      for (const [, tool] of md.matchAll(/mcp__mwf__(mwf_[a-z]+)/g)) {
        assert.ok(toolNames.has(tool!), `${skill.name}: ${tool}`);
      }
      assert.ok(!/(?<!mcp__mwf__)\bmwf_[a-z]+\b/.test(md), `${skill.name} has a bare tool name`);
      assert.match(md, /^---\nname: /);
      assert.equal(renderSkillMd(skill), renderSkillMd(skill, 'codex'), 'default stays bare');
    }
  });

  it('SessionStart text for Claude names tools as mcp__mwf__…, outside the data fence only', async () => {
    const ctx = await seeded();
    const nonce = 'a'.repeat(24);
    const claude = await handleClaude('session-start', startInput(ctx.root, 'startup'), {
      nonce: () => nonce,
    });
    const text = contextOf(claude!.output);
    assert.match(text, /do not call `mcp__mwf__mwf_bootstrap` again/);
    assert.ok(!/(?<!mcp__mwf__)\bmwf_bootstrap\b/.test(text));
    const codex = await handleCodex('session-start', startInput(ctx.root, 'startup'), {
      nonce: () => nonce,
    });
    assert.match(contextOf(codex!.output), /do not call `mwf_bootstrap` again/);
  });

  it('stored memory is never rewritten, even when it mentions a tool', async () => {
    const ctx = await project();
    await add(ctx, {
      type: 'knowledge',
      title: 'Note that mwf_recall is the search tool',
      body: 'mwf_recall body sqlite',
    });
    const out = await handleClaude('session-start', startInput(ctx.root, 'startup'));
    assert.match(contextOf(out!.output), /Note that mwf_recall is the search tool/);
    const fenced = fence('i mwf_recall', ['x'.repeat(100)], 10, 'n'.repeat(24), (t) =>
      renderForHost(t, 'claude'),
    );
    assert.match(fenced.text, /^i mcp__mwf__mwf_recall/);
    assert.match(fenced.text, /use mcp__mwf__mwf_recall for the rest/);
  });
});

describe('Claude Code output format (D2)', () => {
  it('SessionStart and prompt: additionalContext + systemMessage, like Codex', () => {
    assert.deepEqual(formatClaude('session-start', { inject: 'hi', notice: 'n' }), {
      systemMessage: 'n',
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' },
    });
    assert.deepEqual(formatClaude('prompt', { inject: 'hi' }), {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'hi' },
    });
    assert.deepEqual(formatClaude('prompt', {}), {});
  });

  it('Stop: additionalContext by default (S2), a block only with --stop-style block (S1)', () => {
    assert.deepEqual(formatClaude('stop', { block: 'again' }), {
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'again' },
    });
    assert.deepEqual(formatClaude('stop', { block: 'again' }, 'block'), {
      decision: 'block',
      reason: 'again',
    });
    assert.deepEqual(formatClaude('stop', {}), {});
    assert.deepEqual(formatClaude('stop', { notice: 'ignored' }, 'block'), {});
    assert.ok(isClaudeStopStyle('block') && isClaudeStopStyle('additional-context'));
    assert.ok(!isClaudeStopStyle('exit2') && !isClaudeStopStyle(undefined));
  });
});

describe('Claude Code SessionStart source (D3)', () => {
  const injecting = ['startup', 'clear', 'fork', 'resume', 'something-new', undefined];

  it('injects for every source except compact', async () => {
    const ctx = await seeded();
    for (const source of injecting) {
      const out = await handleClaude('session-start', startInput(ctx.root, source));
      assert.match(contextOf(out!.output), /Use SQLite for the index/, String(source));
      assert.equal(out!.output.hookSpecificOutput!.hookEventName, 'SessionStart');
    }
    const compact = await handleClaude('session-start', startInput(ctx.root, 'compact'));
    assert.deepEqual(compact!.output, {});
    assert.equal(compact!.after, undefined, 'compact writes nothing');
  });

  it('a non-string source counts as unknown and still injects', async () => {
    const ctx = await seeded();
    const out = await handleClaude('session-start', startInput(ctx.root, undefined, { source: 7 }));
    assert.match(contextOf(out!.output), /Use SQLite/);
  });

  it('startup, clear and fork reset what was recalled; resume keeps it', async () => {
    const ctx = await seeded();
    const ask = async (): Promise<HostOutput> => {
      const r = await handleClaude(
        'prompt',
        promptInput(ctx.root, 'why did we pick sqlite for the index?'),
      );
      await r!.after?.();
      return r!.output;
    };
    const start = async (source: string): Promise<void> => {
      const r = await handleClaude('session-start', startInput(ctx.root, source));
      await r!.after?.();
    };
    await start('startup');
    assert.match(contextOf(await ask()), /Use SQLite/);
    assert.deepEqual(await ask(), {}, 'recalled once per session');
    await start('resume');
    assert.deepEqual(await ask(), {}, 'resume keeps the recall list');
    await start('compact');
    assert.deepEqual(await ask(), {}, 'compact changes nothing');
    for (const source of ['clear', 'fork', 'startup']) {
      await start(source);
      assert.match(contextOf(await ask()), /Use SQLite/, `${source} starts fresh`);
      assert.deepEqual(await ask(), {});
    }
  });

  it('uninitialized: the one-line hint in a git repo, nothing elsewhere', async () => {
    const repo = gitRepo();
    const out = await handleClaude('session-start', startInput(repo, 'startup'));
    assert.deepEqual(out!.output, { systemMessage: UNINITIALIZED_NOTICE });
    const plain = tmpDir('mwf-claude-plain-');
    assert.deepEqual(
      (await handleClaude('session-start', startInput(plain, 'startup')))!.output,
      {},
    );
  });
});

describe('Claude Code UserPromptSubmit', () => {
  it('recalls for a normal prompt', async () => {
    const ctx = await seeded();
    const out = await handleClaude('prompt', promptInput(ctx.root, 'why did we pick sqlite?'));
    assert.equal(out!.output.hookSpecificOutput!.hookEventName, 'UserPromptSubmit');
    assert.match(contextOf(out!.output), /Use SQLite for the index/);
  });

  it('skips the user’s own /mwf commands (their skill calls the tools), but not other slash lines', async () => {
    const ctx = await seeded();
    for (const own of [
      '/mwf recall sqlite',
      '/mwf',
      '  /mwf-save the sqlite decision',
      '/mwf:status sqlite',
    ]) {
      assert.deepEqual((await handleClaude('prompt', promptInput(ctx.root, own)))!.output, {}, own);
    }
    for (const other of [
      '/mwfx sqlite index',
      '/review sqlite index',
      'please /mwf sqlite index',
    ]) {
      const out = await handleClaude('prompt', promptInput(ctx.root, other, `s-${other.length}`));
      assert.match(contextOf(out!.output), /SQLite/, other);
    }
  });

  it('the Codex adapter does not skip /mwf lines (there it is plain text)', async () => {
    const ctx = await seeded();
    const out = await handleCodex('prompt', promptInput(ctx.root, '/mwf recall sqlite index'));
    assert.match(contextOf(out!.output), /SQLite/);
  });
});

describe('Claude Code Stop (D2, anti-loop, prompt_id)', () => {
  it('continues a turn once and by default says so through additionalContext', async () => {
    const ctx = await seeded();
    const first = await handleClaude('stop', stopInput(ctx.root));
    assert.equal(first!.output.decision, undefined);
    assert.equal(first!.output.hookSpecificOutput!.hookEventName, 'Stop');
    const text = contextOf(first!.output);
    assert.match(text, /mwf end-of-turn check/);
    assert.match(text, /mcp__mwf__mwf_handoff/);
    assert.ok(!/(?<!mcp__mwf__)\bmwf_(save|handoff|recall)\b/.test(text), 'Claude tool names');
    assert.match(stateOf(ctx.root), /stop_turn = "[0-9a-f]{24}"/);
    // the same prompt_id again (host flag absent of memory): the state claim allows the stop
    assert.deepEqual((await handleClaude('stop', stopInput(ctx.root)))!.output, {});
  });

  it('--stop-style block answers with decision/reason instead', async () => {
    const ctx = await seeded();
    const out = await handleClaude('stop', stopInput(ctx.root), { stopStyle: 'block' });
    assert.equal(out!.output.decision, 'block');
    assert.match(out!.output.reason!, /mwf end-of-turn check/);
    assert.equal(out!.output.hookSpecificOutput, undefined);
  });

  it('stop_hook_active true, missing or not exactly false allows the stop without claiming', async () => {
    const ctx = await seeded();
    for (const v of [true, 'false', null, 0]) {
      const out = await handleClaude('stop', stopInput(ctx.root, { stop_hook_active: v }));
      assert.deepEqual(out!.output, {}, String(v));
    }
    const missing = JSON.parse(stopInput(ctx.root));
    delete missing.stop_hook_active;
    assert.deepEqual((await handleClaude('stop', json(missing)))!.output, {});
    assert.ok(!/stop_turn/.test(stateOf(ctx.root)), 'nothing claimed');
  });

  it('the turn is the prompt_id: a new prompt is continued again, even with the same last message', async () => {
    const ctx = await seeded();
    const p = (id: string) => stopInput(ctx.root, { prompt_id: id });
    assert.ok((await handleClaude('stop', p('p1')))!.output.hookSpecificOutput);
    assert.deepEqual((await handleClaude('stop', p('p1')))!.output, {});
    assert.ok((await handleClaude('stop', p('p2')))!.output.hookSpecificOutput);
  });

  it('without a prompt_id the last message identifies the turn; with neither the stop is allowed', async () => {
    const ctx = await seeded();
    const noPrompt = (msg: string) => {
      const o = JSON.parse(stopInput(ctx.root, { last_assistant_message: msg }));
      delete o.prompt_id;
      return json(o);
    };
    assert.ok((await handleClaude('stop', noPrompt('first answer')))!.output.hookSpecificOutput);
    assert.deepEqual((await handleClaude('stop', noPrompt('first answer')))!.output, {});
    assert.ok((await handleClaude('stop', noPrompt('second answer')))!.output.hookSpecificOutput);
    const neither = JSON.parse(noPrompt('  '));
    assert.deepEqual((await handleClaude('stop', json(neither)))!.output, {});
    assert.equal(turnKey('s', { prompt_id: 'a' }), turnKey('s', { prompt_id: 'a' }));
    assert.notEqual(turnKey('s', { prompt_id: 'a' }), turnKey('s', { prompt_id: 'b' }));
    assert.notEqual(turnKey('s', { prompt_id: 'a' }), turnKey('s', { turn_id: 'a' }));
    assert.equal(turnKey('s', { turn_id: 't', prompt_id: 'a' }), turnKey('s', { turn_id: 't' }));
  });

  it('Codex ignores prompt_id (it has turn_id), so one adapter cannot change the other', async () => {
    const ctx = await seeded();
    const noTurn = JSON.parse(stopInput(ctx.root, { last_assistant_message: 'same' }));
    const a = await handleCodex('stop', json(noTurn));
    assert.equal(a!.output.decision, 'block');
    // same prompt_id, different message: for Codex that is a different turn (message-keyed)
    const b = await handleCodex('stop', json({ ...noTurn, last_assistant_message: 'other' }));
    assert.equal(b!.output.decision, 'block');
  });

  it('a Stop that Claude Code sends for a different event name does nothing', async () => {
    const ctx = await seeded();
    const out = await handleClaude('stop', startInput(ctx.root, 'startup'));
    assert.deepEqual(out!.output, {});
  });
});

describe('Claude Code malformed input', () => {
  it('not JSON, not an object, too large: null (the worker prints the fallback)', async () => {
    for (const event of ['session-start', 'prompt', 'stop'] as const) {
      assert.equal(await handleClaude(event, 'not json'), null);
      assert.equal(await handleClaude(event, '[1]'), null);
      assert.equal(await handleClaude(event, 'null'), null);
      assert.equal(await handleClaude(event, ' '.repeat(200_000) + '{}'), null);
    }
  });

  it('wrongly typed fields never throw', async () => {
    const ctx = await seeded();
    const odd = {
      cwd: 5,
      session_id: 7,
      prompt: 3,
      source: [],
      stop_hook_active: {},
      prompt_id: 1,
    };
    for (const event of ['session-start', 'prompt', 'stop'] as const) {
      const out = await handleClaude(event, json(odd), { cwd: ctx.root });
      assert.ok(out === null || typeof out.output === 'object');
    }
    assert.deepEqual(fallbackOutput('stop', 'x'), {});
  });
});

describe('Claude Code output size (10,000-character cap)', () => {
  it('the worst case stays below the limit Claude Code would turn into a file', async () => {
    assert.ok(CLAUDE_CONTEXT_MAX < CLAUDE_CONTEXT_LIMIT);
    const ctx = await project();
    const long = 'long title with sqlite '.repeat(8);
    for (let i = 0; i < 60; i++) {
      await add(ctx, {
        type: 'knowledge',
        title: `${i} ${long}`,
        body: `sqlite body ${i} ${'y '.repeat(500)}`,
      });
    }
    await handoff(
      { root: ctx.root },
      {
        action: 'save',
        task: 'big-task',
        content: 'h '.repeat(20_000),
        summary: 'in progress '.repeat(30),
      },
    );
    const start = await handleClaude('session-start', startInput(ctx.root, 'startup'));
    const sessionText = contextOf(start!.output);
    assert.match(sessionText, /\[mwf: truncated/);
    assert.ok(sessionText.length > SESSION_START_CHARS, 'a genuinely full injection');
    assert.ok(sessionText.length <= CLAUDE_CONTEXT_MAX, `session start ${sessionText.length}`);
    const prompt = await handleClaude(
      'prompt',
      promptInput(ctx.root, 'sqlite long title body index'),
    );
    const promptText = contextOf(prompt!.output);
    assert.ok(
      promptText.length > 0 && promptText.length <= CLAUDE_CONTEXT_MAX,
      `${promptText.length}`,
    );
    assert.ok(PROMPT_CHARS + 1_500 < CLAUDE_CONTEXT_MAX);
    for (const style of ['additional-context', 'block'] as const) {
      const stop = await handleClaude('stop', stopInput(ctx.root, { prompt_id: style }), {
        stopStyle: style,
      });
      const text = contextOf(stop!.output) || stop!.output.reason!;
      assert.ok(
        text.length > 0 && text.length <= CLAUDE_CONTEXT_MAX,
        `stop ${style}: ${text.length}`,
      );
    }
    assert.ok(ENTRY.length < 2_000);
  });
});

function mwfHook(args: string[], input: string, cwd: string) {
  return spawnSync(process.execPath, [...FLAGS, BIN, 'hook', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

describe('mwf hook <event> --host claude (real process)', () => {
  it('answers each event with one JSON line, registers the host as claude, exits 0', async () => {
    const ctx = await seeded();
    const t0 = Date.now();
    const start = mwfHook(
      ['session-start', '--host', 'claude'],
      startInput(ctx.root, 'startup'),
      ctx.root,
    );
    assert.equal(start.status, 0, start.stderr);
    assert.ok(Date.now() - t0 < HOOK_DEADLINE_MS);
    assert.equal(start.stdout.trim().split('\n').length, 1);
    assert.equal(start.stderr, '');
    const startOut = JSON.parse(start.stdout);
    assert.equal(startOut.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(startOut.hookSpecificOutput.additionalContext, /mcp__mwf__mwf_bootstrap/);
    assert.match(readFileSync(join(ctx.root, '.mwf', 'host.local.toml'), 'utf8'), /claude/);
    assert.match(stateOf(ctx.root), /cc-1/);

    const prompt = mwfHook(
      ['prompt', '--host', 'claude'],
      promptInput(ctx.root, 'remind me why sqlite'),
      ctx.root,
    );
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.match(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext, /SQLite/);

    const stop = mwfHook(['stop', '--host', 'claude'], stopInput(ctx.root), ctx.root);
    assert.equal(stop.status, 0);
    assert.equal(JSON.parse(stop.stdout).hookSpecificOutput.hookEventName, 'Stop');
    const again = mwfHook(['stop', '--host', 'claude'], stopInput(ctx.root), ctx.root);
    assert.deepEqual(JSON.parse(again.stdout), {}, 'same prompt, second Stop is allowed');
  });

  it('--stop-style block selects decision/reason; an unknown style falls back to the default', async () => {
    const ctx = await seeded();
    const block = mwfHook(
      ['stop', '--host', 'claude', '--stop-style', 'block'],
      stopInput(ctx.root, { prompt_id: 'b1' }),
      ctx.root,
    );
    assert.equal(JSON.parse(block.stdout).decision, 'block');
    const odd = mwfHook(
      ['stop', '--host', 'claude', '--stop-style', 'nope'],
      stopInput(ctx.root, { prompt_id: 'b2' }),
      ctx.root,
    );
    assert.equal(JSON.parse(odd.stdout).hookSpecificOutput.hookEventName, 'Stop');
  });

  it('garbage in: SessionStart / prompt print the one-line notice, Stop is silent, all exit 0', () => {
    const dir = tmpDir('mwf-claude-bad-');
    for (const event of ['session-start', 'prompt']) {
      const r = mwfHook([event, '--host', 'claude'], 'definitely not json', dir);
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).systemMessage, FAILURE_NOTICE);
    }
    const s = mwfHook(['stop', '--host', 'claude'], 'definitely not json', dir);
    assert.equal(s.status, 0);
    assert.deepEqual(JSON.parse(s.stdout), {});
    assert.equal(mwfHook(['stop', '--host', 'claude'], '', dir).status, 0);
  });

  it('--host codex (or none) keeps the Codex adapter: no mcp__ names', async () => {
    const ctx = await seeded();
    const r = mwfHook(
      ['session-start', '--host', 'codex'],
      startInput(ctx.root, 'startup'),
      ctx.root,
    );
    assert.ok(!/mcp__mwf__/.test(r.stdout));
  });
});
