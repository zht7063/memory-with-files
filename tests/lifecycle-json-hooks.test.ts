import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HOOK_EVENTS,
  HooksDocError,
  checkOnlyOursChanged,
  hookCommand,
  installHooks,
  isEmptyDoc,
  isOurs,
  removeHooks,
  shellQuote,
  splitCommand,
} from '../src/lifecycle/hooks-doc.ts';
import {
  JsonSyntaxError,
  detectStyle,
  parseStrictJson,
  serializeJson,
} from '../src/lifecycle/json-edit.ts';

const NODE = '/usr/local/bin/node';
const MWF = '/opt/mwf/bin/mwf.js';

describe('strict JSON', () => {
  const bad: Array<[string, string, RegExp]> = [
    ['comment', '{\n  // hi\n  "a": 1\n}', /comments are not allowed \(line 2, column 3\)/],
    ['trailing comma', '{"a":1,}', /expected a string key/],
    ['duplicate key', '{"a":1,\n "a":2}', /duplicate key "a" \(line 2, column 2\)/],
    ['BOM', '\ufeff{}', /byte order mark/],
    ['trailing text', '{} x', /unexpected content after/],
    ['single quotes', "{'a':1}", /expected a string key/],
    ['empty', '', /unexpected character/],
    ['unterminated', '{"a": "x', /unterminated string/],
  ];
  for (const [name, text, re] of bad)
    it(`refuses ${name}`, () => {
      assert.throws(
        () => parseStrictJson(text),
        (e) => e instanceof JsonSyntaxError && re.test(e.message),
      );
    });

  it('accepts what JSON.parse accepts, including nested duplicates in different objects', () => {
    assert.deepEqual(parseStrictJson('{"a":{"x":1},"b":{"x":2},"c":[1,2.5e3,null,true,"é\\n"]}'), {
      a: { x: 1 },
      b: { x: 2 },
      c: [1, 2500, null, true, 'é\n'],
    });
  });

  it('keeps indentation, line endings and the final newline', () => {
    for (const text of ['{\n\t"a": 1\n}\n', '{\n    "a": 1\n}', '{\r\n  "a": 1\r\n}\r\n']) {
      assert.equal(serializeJson(JSON.parse(text), detectStyle(text)), text);
    }
  });
});

describe('hooks document edits', () => {
  it('quotes and splits shell words the same way (round trip, odd characters)', () => {
    for (const w of ['/a b/c', "it's", 'a"b', 'x$y`z`', 'ünï/çode', '\\']) {
      assert.deepEqual(splitCommand(shellQuote(w)), [w]);
    }
    assert.throws(() => shellQuote('a\nb'));
    assert.equal(splitCommand('a; b'), null);
    assert.equal(splitCommand('a $(b)'), null);
    assert.equal(splitCommand('a | b'), null);
    assert.equal(splitCommand('"a $HOME"'), null);
  });

  it('adds three handlers with the right matcher, timeout 5 and no matcher where Codex ignores it', () => {
    const { doc, changes } = installHooks({}, NODE, MWF);
    assert.deepEqual(
      changes.map((c) => [c.event, c.action]),
      [
        ['SessionStart', 'add'],
        ['UserPromptSubmit', 'add'],
        ['Stop', 'add'],
      ],
    );
    const hooks = (doc as any).hooks;
    assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|clear|fork');
    assert.equal(hooks.UserPromptSubmit[0].matcher, undefined);
    assert.equal(hooks.Stop[0].matcher, undefined);
    for (const e of HOOK_EVENTS) {
      const h = hooks[e.event][0].hooks[0];
      assert.equal(h.type, 'command');
      assert.equal(h.timeout, 5);
      assert.equal(h.command, hookCommand(NODE, MWF, e.arg));
      assert.ok(isOurs(h));
    }
  });

  it('is idempotent and replaces a stale mwf path in place', () => {
    const once = installHooks({}, NODE, MWF).doc;
    const again = installHooks(once, NODE, MWF);
    assert.deepEqual(again.doc, once);
    assert.ok(again.changes.every((c) => c.action === 'unchanged'));
    const moved = installHooks(once, NODE, '/new/place/mwf.js');
    assert.ok(moved.changes.every((c) => c.action === 'replace'));
    assert.equal((moved.doc as any).hooks.Stop.length, 1);
    assert.match((moved.doc as any).hooks.Stop[0].hooks[0].command, /\/new\/place\/mwf\.js/);
  });

  it('keeps every other handler, event, group field and top-level field exactly as it was', () => {
    const user = {
      note: { keep: [1, 2, { x: null }] },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh', timeout: 30 }] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: 'other-tool stop', extra: true }], custom: 1 },
        ],
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'echo "mwf hook prompt"' }] },
        ],
      },
    };
    const { doc } = installHooks(user, NODE, MWF);
    const d = doc as any;
    assert.deepEqual(d.note, user.note);
    assert.deepEqual(d.hooks.PreToolUse, user.hooks.PreToolUse);
    assert.deepEqual(d.hooks.Stop[0], user.hooks.Stop[0]);
    assert.equal(d.hooks.Stop.length, 2);
    assert.deepEqual(
      d.hooks.SessionStart[0],
      user.hooks.SessionStart[0],
      'a lookalike is not ours',
    );
    checkOnlyOursChanged(user, doc);
    const removed = removeHooks(doc);
    assert.deepEqual(removed.doc, user);
  });

  it('does not take lookalikes for its own handlers', () => {
    const lookalikes = [
      { type: 'command', command: 'node /x/other.js hook prompt' },
      { type: 'command', command: `${NODE} ${MWF} hook prompt; rm -rf x` },
      { type: 'command', command: `${NODE} ${MWF} hook bogus` },
      { type: 'command', command: `${NODE} ${MWF} mcp` },
      { type: 'prompt', command: `${NODE} ${MWF} hook prompt` },
      { type: 'command', command: 'mwf hook prompt' },
      { type: 'command', command: 5 },
      'x',
      null,
    ];
    for (const h of lookalikes) assert.equal(isOurs(h), false, JSON.stringify(h));
  });

  it("uninstall prunes only what it emptied; a user's own empty group stays", () => {
    const user = { hooks: { Stop: [{ hooks: [] }] } };
    const installed = installHooks(user, NODE, MWF).doc;
    assert.deepEqual(removeHooks(installed).doc, user);
    assert.deepEqual(removeHooks(installHooks({}, NODE, MWF).doc).doc, {});
    assert.ok(isEmptyDoc(removeHooks(installHooks({}, NODE, MWF).doc).doc));
    const withTop = { other: 1 };
    assert.deepEqual(removeHooks(installHooks(withTop, NODE, MWF).doc).doc, withTop);
  });

  it('refuses shapes it does not understand instead of guessing', () => {
    for (const doc of [
      [],
      'x',
      { hooks: [] },
      { hooks: { Stop: {} } },
      { hooks: { Stop: [1] } },
      { hooks: { Stop: [{}] } },
    ]) {
      assert.throws(() => installHooks(doc, NODE, MWF), HooksDocError, JSON.stringify(doc));
    }
  });

  it('the difference guard catches an edit that touches something else', () => {
    const before = { a: 1, hooks: { PreToolUse: [{ hooks: [] }] } };
    const after = installHooks(before, NODE, MWF).doc as any;
    checkOnlyOursChanged(before, after);
    after.a = 2;
    assert.throws(() => checkOnlyOursChanged(before, after), HooksDocError);
    const after2 = installHooks(before, NODE, MWF).doc as any;
    delete after2.hooks.PreToolUse;
    assert.throws(() => checkOnlyOursChanged(before, after2), HooksDocError);
  });
});
