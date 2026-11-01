import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  classifyExtension,
  EXTENSION_COMMAND_MS,
  EXTENSION_HOOK_MS,
  renderExtension,
} from '../src/lifecycle/pi-extension.ts';
import { tmpDir } from './helpers/util.ts';

// A stand-in `mwf`: logs every call (argv + stdin) to $FAKE_MWF_LOG and answers by $FAKE_MWF_MODE.
const FAKE_MWF = `
const fs = require('node:fs');
const argv = process.argv.slice(2);
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_MWF_LOG) fs.appendFileSync(process.env.FAKE_MWF_LOG, JSON.stringify({ argv, stdin, script: process.argv[1] }) + '\\n');
  const mode = process.env.FAKE_MWF_MODE || 'ok';
  if (argv[0] !== 'hook') { process.stdout.write('CLI ' + argv.join(' ') + '\\n'); process.exit(mode === 'cliexit' ? 3 : 0); }
  if (mode === 'exit1') process.exit(1);
  if (mode === 'bad') { process.stdout.write('not json\\n'); return; }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  const event = argv[1];
  if (event === 'stop') { process.stdout.write(JSON.stringify({ decision: 'block', reason: 'REASON' }) + '\\n'); return; }
  process.stdout.write(JSON.stringify({ systemMessage: 'NOTE-' + event, hookSpecificOutput: { hookEventName: 'X', additionalContext: 'CTX-' + event } }) + '\\n');
});
`;

type Handler = (event: any, ctx: any) => any;

interface Harness {
  handlers: Record<string, Handler>;
  commands: Record<string, any>;
  sent: string[];
  notes: Array<{ text: string; level?: string }>;
  ctx: (id: string | null | 'throw', extra?: object) => any;
  calls: () => Array<{ argv: string[]; stdin: any; script: string }>;
}

async function load(spec: { node?: string; mwfJs?: string } = {}, mode = 'ok'): Promise<Harness> {
  const dir = tmpDir('mwf-pix-');
  const mwfJs = spec.mwfJs ?? join(dir, 'mwf.js');
  if (!existsSync(mwfJs)) {
    mkdirSync(join(mwfJs, '..'), { recursive: true });
    writeFileSync(mwfJs, FAKE_MWF);
  }
  const log = join(dir, 'calls.log');
  process.env['FAKE_MWF_LOG'] = log;
  process.env['FAKE_MWF_MODE'] = mode;
  const file = join(dir, 'ext.mjs');
  writeFileSync(
    file,
    renderExtension({ node: spec.node ?? process.execPath, mwfJs, version: 't' }),
  );
  const mod = (await import(pathToFileURL(file).href)) as { default: (pi: unknown) => void };
  const h: Harness = {
    handlers: {},
    commands: {},
    sent: [],
    notes: [],
    ctx: (id, extra = {}) => ({
      cwd: '/proj',
      hasUI: true,
      ui: { notify: (text: string, level?: string) => h.notes.push({ text, level }) },
      sessionManager: {
        getSessionId: () => {
          if (id === 'throw') throw new Error('no session');
          return id;
        },
      },
      ...extra,
    }),
    calls: () => {
      try {
        return readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const c = JSON.parse(l) as { argv: string[]; stdin: string; script: string };
            return { ...c, stdin: c.stdin ? JSON.parse(c.stdin) : null };
          });
      } catch {
        return [];
      }
    },
  };
  mod.default({
    on: (name: string, fn: Handler) => (h.handlers[name] = fn),
    registerCommand: (name: string, opts: unknown) => (h.commands[name] = opts),
    sendUserMessage: async (text: string) => {
      h.sent.push(text);
    },
  });
  return h;
}

const ID = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const user = (prompt: string) => ({ type: 'before_agent_start', messageType: 'user', prompt });

describe('pi extension file', () => {
  it('starts with the managed marker; the hash covers everything after it; edits are detected', () => {
    const text = renderExtension({
      node: '/usr/bin/node',
      mwfJs: '/opt/mwf/bin/mwf.js',
      version: '1.2.3',
    });
    assert.match(text, /^\/\/ mwf-managed:1\.2\.3:[0-9a-f]{64}\n/);
    assert.deepEqual(classifyExtension(text), { kind: 'intact', version: '1.2.3' });
    assert.deepEqual(classifyExtension(text + '// mine\n'), { kind: 'modified', version: '1.2.3' });
    assert.deepEqual(classifyExtension(text.replace('/opt/mwf', '/opt/other')), {
      kind: 'modified',
      version: '1.2.3',
    });
    assert.deepEqual(classifyExtension('export default function () {}\n'), { kind: 'none' });
    assert.deepEqual(classifyExtension(''), { kind: 'none' });
  });

  it('is deterministic, has no import but node:child_process, and carries the budgets', () => {
    const spec = { node: '/usr/bin/node', mwfJs: '/opt/mwf.js', version: '1' };
    assert.equal(renderExtension(spec), renderExtension(spec));
    const imports = [...renderExtension(spec).matchAll(/^import .* from (".*");$/gm)].map(
      (m) => m[1],
    );
    assert.deepEqual(imports, ['"node:child_process"']);
    assert.match(renderExtension(spec), new RegExp(`const HOOK_MS = ${EXTENSION_HOOK_MS};`));
    assert.match(renderExtension(spec), new RegExp(`const COMMAND_MS = ${EXTENSION_COMMAND_MS};`));
    assert.ok(EXTENSION_HOOK_MS > 4_000, 'above the supervisor deadline of mwf hook');
  });

  it('bakes paths through JSON.stringify: quotes, backslashes, ${}, backticks, newlines, placeholders', async () => {
    const hostile = [
      'q"uote',
      "s'ingle",
      'back\\slash',
      'dollar${process.exit(9)}brace',
      'tick`ing`',
      'new\nline',
      'end*/ // x',
      '__MWF_JS__ and __NODE__',
      'u2028\u2028and\u2029',
      'ünï',
    ];
    for (const name of hostile) {
      const root = tmpDir('mwf-evil-');
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      const mwfJs = join(dir, 'mwf.js');
      writeFileSync(mwfJs, FAKE_MWF);
      const node = join(dir, 'node-link');
      symlinkSync(process.execPath, node);
      chmodSync(mwfJs, 0o644);
      const h = await load({ node, mwfJs });
      const out = await h.handlers['before_agent_start']!(user('hello'), h.ctx(ID));
      assert.match(out.message.content, /CTX-prompt/, JSON.stringify(name));
      const [c] = h.calls();
      assert.equal(c!.script, mwfJs, JSON.stringify(name));
      assert.deepEqual(c!.argv, ['hook', 'session-start', '--host', 'pi']);
      const text = renderExtension({ node, mwfJs, version: 't' });
      assert.ok(text.includes(JSON.stringify(mwfJs)), 'the baked literal is the JSON string');
    }
  });
});

describe('pi extension: events', () => {
  it('first run of a session announces SessionStart then recalls; later runs only recall; one message, display:false', async () => {
    const h = await load();
    h.handlers['session_start']!({ reason: 'startup' }, h.ctx(ID));
    h.handlers['input']!({ text: 'hello', source: 'interactive' }, h.ctx(ID));
    const first = await h.handlers['before_agent_start']!(user('expanded hello'), h.ctx(ID));
    assert.deepEqual(first, {
      message: { customType: 'mwf', content: 'CTX-session-start\n\nCTX-prompt', display: false },
    });
    assert.deepEqual(
      h.calls().map((c) => c.argv.slice(1)),
      [
        ['session-start', '--host', 'pi'],
        ['prompt', '--host', 'pi'],
      ],
    );
    const [start, prompt] = h.calls();
    assert.equal(start!.stdin.hook_event_name, 'SessionStart');
    assert.equal(start!.stdin.source, 'startup');
    assert.equal(start!.stdin.session_id, ID);
    assert.equal(start!.stdin.cwd, '/proj');
    assert.equal(prompt!.stdin.hook_event_name, 'UserPromptSubmit');
    assert.equal(prompt!.stdin.prompt, 'hello', 'the raw line, not the expanded one');
    assert.equal(prompt!.stdin.prompt_id, `${ID}:1`);
    assert.deepEqual(
      h.notes.map((n) => n.text),
      ['NOTE-session-start', 'NOTE-prompt'],
    );
    const second = await h.handlers['before_agent_start']!(user('again'), h.ctx(ID));
    assert.equal(second.message.content, 'CTX-prompt');
    assert.equal(h.calls().length, 3);
    assert.equal(h.calls()[2]!.stdin.prompt_id, `${ID}:2`);
    assert.equal(h.calls()[2]!.stdin.prompt, 'again', 'no input event: the event prompt');
  });

  it('maps session_start reasons to the handler sources', async () => {
    const want: Record<string, string> = {
      startup: 'startup',
      reload: 'resume',
      new: 'clear',
      resume: 'resume',
      fork: 'fork',
    };
    for (const [reason, source] of Object.entries(want)) {
      const h = await load();
      h.handlers['session_start']!({ reason }, h.ctx(ID));
      await h.handlers['before_agent_start']!(user('x'), h.ctx(ID));
      assert.equal(h.calls()[0]!.stdin.source, source, reason);
    }
    const h = await load(); // no session_start seen: treated as a fresh start
    await h.handlers['before_agent_start']!(user('x'), h.ctx(ID));
    assert.equal(h.calls()[0]!.stdin.source, 'startup');
  });

  it('runs started by a custom message are left alone', async () => {
    const h = await load();
    const out = await h.handlers['before_agent_start']!(
      { messageType: 'custom', message: {} },
      h.ctx(ID),
    );
    assert.equal(out, undefined);
    assert.equal(h.calls().length, 0);
  });

  it('without a session id nothing is sent as session_id and Stop never continues', async () => {
    for (const id of [null, '', 'throw'] as const) {
      const h = await load();
      const out = await h.handlers['before_agent_start']!(user('x'), h.ctx(id));
      assert.equal(out.message.content, 'CTX-prompt', String(id));
      assert.deepEqual(
        h.calls().map((c) => c.argv[1]),
        ['prompt'],
      );
      assert.equal(h.calls()[0]!.stdin.session_id, undefined);
      assert.equal(h.calls()[0]!.stdin.prompt_id, undefined);
      const stop = await h.handlers['agent_before_settle']!(
        { outcome: 'completed', continue: false, entries: [], context: { canContinue: true } },
        h.ctx(id),
      );
      assert.equal(stop, undefined);
      assert.equal(h.calls().length, 1, 'Stop did not even spawn');
    }
  });

  it('a hook that fails, prints garbage or exits 1 injects nothing and never throws', async () => {
    for (const mode of ['exit1', 'bad']) {
      const h = await load({}, mode);
      assert.equal(await h.handlers['before_agent_start']!(user('x'), h.ctx(ID)), undefined, mode);
      const stop = await h.handlers['agent_before_settle']!(
        { outcome: 'completed', continue: false, entries: [], context: { canContinue: true } },
        h.ctx(ID),
      );
      assert.equal(stop, undefined, mode);
    }
  });

  it('a mwf that cannot be started injects nothing', async () => {
    const h = await load({ node: '/nonexistent/node' });
    assert.equal(await h.handlers['before_agent_start']!(user('x'), h.ctx(ID)), undefined);
  });

  it('a hanging hook is killed at the budget and lets Pi go on', async () => {
    const h = await load({}, 'hang');
    const t0 = Date.now();
    const out = await h.handlers['before_agent_start']!(user('x'), h.ctx(null)); // one hook, one budget
    const took = Date.now() - t0;
    assert.equal(out, undefined);
    assert.ok(took >= EXTENSION_HOOK_MS - 200 && took < EXTENSION_HOOK_MS + 3_000, String(took));
  });
});

describe('pi extension: Stop (agent_before_settle)', () => {
  const settle = (extra: object = {}) => ({
    type: 'agent_before_settle',
    outcome: 'completed',
    continue: false,
    entries: [{ type: 'custom', customType: 'other', data: 1 }],
    context: { canContinue: true },
    ...extra,
  });

  it('continues once per user prompt with a custom_message entry appended to the proposed ones', async () => {
    const h = await load();
    await h.handlers['before_agent_start']!(user('work'), h.ctx(ID));
    const out = await h.handlers['agent_before_settle']!(settle(), h.ctx(ID));
    assert.deepEqual(out, {
      entries: [
        { type: 'custom', customType: 'other', data: 1 },
        { type: 'custom_message', customType: 'mwf', content: 'REASON', display: false },
      ],
      continue: true,
    });
    const stop = h.calls().find((c) => c.argv[1] === 'stop')!;
    assert.deepEqual(stop.argv.slice(1), ['stop', '--host', 'pi']);
    assert.equal(stop.stdin.hook_event_name, 'Stop');
    assert.equal(stop.stdin.session_id, ID);
    assert.equal(stop.stdin.prompt_id, `${ID}:1`);
    assert.equal(stop.stdin.stop_hook_active, false);
    // the settle that follows the continuation: no second continuation, and no spawn
    const n = h.calls().length;
    assert.equal(await h.handlers['agent_before_settle']!(settle(), h.ctx(ID)), undefined);
    assert.equal(h.calls().length, n);
    // a new user prompt is a new turn
    await h.handlers['before_agent_start']!(user('more'), h.ctx(ID));
    assert.equal((await h.handlers['agent_before_settle']!(settle(), h.ctx(ID))).continue, true);
  });

  it('the continue-once counter is per session', async () => {
    const h = await load();
    const A = `${ID}-a`;
    const B = `${ID}-b`;
    await h.handlers['before_agent_start']!(user('a'), h.ctx(A));
    await h.handlers['before_agent_start']!(user('b'), h.ctx(B));
    assert.equal((await h.handlers['agent_before_settle']!(settle(), h.ctx(A))).continue, true);
    assert.equal(await h.handlers['agent_before_settle']!(settle(), h.ctx(A)), undefined);
    assert.equal((await h.handlers['agent_before_settle']!(settle(), h.ctx(B))).continue, true);
  });

  it('only a completed run is continued; never when already continuing, cannot continue or no prompt seen', async () => {
    const h = await load();
    await h.handlers['before_agent_start']!(user('work'), h.ctx(ID));
    const spawned = () => h.calls().filter((c) => c.argv[1] === 'stop').length;
    for (const outcome of ['aborted', 'error']) {
      assert.equal(
        await h.handlers['agent_before_settle']!(settle({ outcome }), h.ctx(ID)),
        undefined,
      );
    }
    assert.equal(
      await h.handlers['agent_before_settle']!(settle({ continue: true }), h.ctx(ID)),
      undefined,
    );
    assert.equal(
      await h.handlers['agent_before_settle']!(
        settle({ context: { canContinue: false } }),
        h.ctx(ID),
      ),
      undefined,
    );
    assert.equal(spawned(), 0);
    const fresh = await load();
    assert.equal(await fresh.handlers['agent_before_settle']!(settle(), fresh.ctx(ID)), undefined);
    assert.equal(fresh.calls().length, 0);
  });

  it('a failed or silent Stop still counts as the one try for that prompt', async () => {
    const h = await load({}, 'bad');
    await h.handlers['before_agent_start']!(user('work'), h.ctx(ID));
    assert.equal(await h.handlers['agent_before_settle']!(settle(), h.ctx(ID)), undefined);
    assert.equal(await h.handlers['agent_before_settle']!(settle(), h.ctx(ID)), undefined);
    assert.equal(h.calls().filter((c) => c.argv[1] === 'stop').length, 1);
  });
});

describe('pi extension: input handling and /mwf', () => {
  it('the input event always lets the input through', () => {
    return load().then((h) => {
      assert.deepEqual(
        h.handlers['input']!({ text: '/mwf save', source: 'interactive' }, h.ctx(ID)),
        {
          action: 'continue',
        },
      );
    });
  });

  it('a raw /mwf line is what the hook sees (so the adapter skips recall)', async () => {
    const h = await load();
    h.handlers['input']!({ text: '/skill:mwf-save things' }, h.ctx(ID));
    await h.handlers['before_agent_start']!(
      user('<skill name="mwf-save">…expanded…</skill>'),
      h.ctx(ID),
    );
    const prompt = h.calls().find((c) => c.argv[1] === 'prompt')!;
    assert.equal(prompt.stdin.prompt, '/skill:mwf-save things');
  });

  it('registers /mwf with completions for init|status|recall|save|handoff|tidy', async () => {
    const h = await load();
    const cmd = h.commands['mwf'];
    assert.match(cmd.description, /init, status, recall, save, handoff, tidy/);
    assert.deepEqual(
      (await cmd.getArgumentCompletions('')).map((i: any) => i.value),
      ['init', 'status', 'recall', 'save', 'handoff', 'tidy'],
    );
    assert.deepEqual(
      (await cmd.getArgumentCompletions('s')).map((i: any) => i.value),
      ['status', 'save'],
    );
    assert.equal(await cmd.getArgumentCompletions('zzz'), null);
    assert.equal(await cmd.getArgumentCompletions('status x'), null);
  });

  it('/mwf status and recall in the UI: CLI output shown as a transient notification only', async () => {
    const h = await load();
    const cmd = h.commands['mwf'];
    await cmd.handler('status', h.ctx(ID));
    await cmd.handler('recall why sqlite', h.ctx(ID));
    assert.deepEqual(
      h.calls().map((c) => c.argv),
      [
        ['status', '--cwd', '/proj'],
        ['recall', 'why sqlite', '--cwd', '/proj', '--max-chars', '2000'],
      ],
    );
    assert.deepEqual(
      h.notes.map((n) => n.text),
      ['CLI status --cwd /proj', 'CLI recall why sqlite --cwd /proj --max-chars 2000'],
    );
    assert.deepEqual(h.sent, [], 'nothing is sent to the model or written to the session');
  });

  it('/mwf status without a UI asks the agent to use the MCP tool instead', async () => {
    const h = await load();
    await h.commands['mwf'].handler('status', h.ctx(ID, { hasUI: false }));
    assert.equal(h.calls().length, 0);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0]!, /mcp__mwf__mwf_status/);
    assert.ok(!/(?<!mcp__mwf__)\bmwf_status\b/.test(h.sent[0]!));
  });

  it('init/save/handoff/tidy send our fixed instruction (rendered for Pi), with the user text appended', async () => {
    const h = await load();
    const cmd = h.commands['mwf'];
    await cmd.handler('save always use tabs', h.ctx(ID));
    await cmd.handler('handoff', h.ctx(ID));
    await cmd.handler('tidy', h.ctx(ID));
    await cmd.handler('init', h.ctx(ID));
    assert.equal(h.sent.length, 4);
    assert.match(h.sent[0]!, /mwf-save/);
    assert.match(h.sent[0]!, /\n\nText: always use tabs$/);
    assert.match(h.sent[1]!, /mwf-handoff/);
    assert.match(h.sent[2]!, /mwf-tidy/);
    assert.equal(h.calls().length, 0);
    // the run these start is not recalled for
    await h.handlers['before_agent_start']!(user(h.sent[3]!), h.ctx(ID));
    assert.equal(h.calls().find((c) => c.argv[1] === 'prompt')!.stdin.prompt, '/mwf');
    await h.handlers['before_agent_start']!(user('later'), h.ctx(ID));
    assert.equal(h.calls().filter((c) => c.argv[1] === 'prompt')[1]!.stdin.prompt, 'later');
  });

  it('unknown or inherited names print the usage, send nothing and run nothing', async () => {
    const h = await load();
    for (const arg of ['', 'help', 'bogus', 'constructor', '__proto__', 'toString']) {
      await h.commands['mwf'].handler(arg, h.ctx(ID));
    }
    assert.deepEqual(h.sent, []);
    assert.equal(h.calls().length, 0);
    assert.equal(h.notes.length, 6);
    assert.ok(
      h.notes.every((n) => /\/mwf init/.test(n.text) && /\/mwf recall <query>/.test(n.text)),
    );
    assert.equal(h.notes[0]!.level, 'info');
    assert.equal(h.notes[2]!.level, 'warning');
  });
});
