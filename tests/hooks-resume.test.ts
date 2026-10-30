import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { acquireLock } from '../src/core/lock.ts';
import { layoutOf } from '../src/core/paths.ts';
import { add, getSession, handoff, setSession } from '../src/core/index.ts';
import { handleClaude, handleCodex, sessionStart, type HostOutput } from '../src/hooks/index.ts';
import { project } from './helpers/util.ts';

/**
 * SessionStart `source=resume`: the host's transcript already holds the overview, so it is not
 * injected again unless memory changed since the last injection for that session (a hash of the
 * overview content, stored in state.toml). Anything doubtful injects.
 */

const SID = 'resume-1';
const json = (o: unknown): string => JSON.stringify(o);
const startInput = (cwd: string, source: string | undefined, sid = SID): string =>
  json({
    session_id: sid,
    cwd,
    hook_event_name: 'SessionStart',
    ...(source !== undefined ? { source } : {}),
  });
const promptInput = (cwd: string, prompt: string, sid = SID): string =>
  json({ session_id: sid, turn_id: 't1', cwd, hook_event_name: 'UserPromptSubmit', prompt });
const contextOf = (out: HostOutput): string => out.hookSpecificOutput?.additionalContext ?? '';
const stateFile = (root: string): string => join(root, '.mwf', 'state.toml');
const stateOf = (root: string): string => readFileSync(stateFile(root), 'utf8');

const HOSTS = [
  { name: 'Claude Code', handle: handleClaude },
  { name: 'Codex', handle: handleCodex },
] as const;

async function seeded() {
  const ctx = await project();
  await add(ctx, {
    type: 'decision',
    title: 'Use SQLite for the index',
    body: 'We chose sqlite because it ships with node.',
  });
  return ctx;
}

describe('SessionStart resume does not re-inject an unchanged overview', () => {
  for (const { name, handle } of HOSTS) {
    describe(name, () => {
      const start = async (root: string, source: string | undefined, sid = SID) => {
        const r = await handle('session-start', startInput(root, source, sid));
        assert.ok(r, 'the hook answered');
        await r.after?.();
        return contextOf(r.output);
      };

      it('resume with nothing changed injects nothing and writes nothing but a no-op', async () => {
        const ctx = await seeded();
        assert.match(await start(ctx.root, 'startup'), /Use SQLite for the index/);
        const before = stateOf(ctx.root);
        const r = await handle('session-start', startInput(ctx.root, 'resume'));
        assert.deepEqual(r!.output, {});
        await r!.after?.();
        assert.equal(stateOf(ctx.root), before, 'state.toml is untouched');
      });

      it('resume after memory changed injects, and the next unchanged resume skips', async () => {
        const ctx = await seeded();
        await start(ctx.root, 'startup');
        await add(ctx, {
          type: 'knowledge',
          title: 'Deploy with the blue/green script',
          body: 'x',
        });
        const again = await start(ctx.root, 'resume');
        assert.match(again, /Deploy with the blue\/green script/);
        assert.equal(await start(ctx.root, 'resume'), '', 'the new hash was stored');
      });

      it('resume after a handoff changed injects', async () => {
        const ctx = await seeded();
        await start(ctx.root, 'startup');
        await handoff(ctx, {
          action: 'save',
          task: 'ship-it',
          content: 'Working on shipping.',
          summary: 'in progress',
        });
        assert.match(await start(ctx.root, 'resume'), /ship-it/);
      });

      it('resume keeps the recalled-once list; startup/clear/fork still reset it', async () => {
        const ctx = await seeded();
        const ask = async (): Promise<string> => {
          const r = await handle(
            'prompt',
            promptInput(ctx.root, 'why did we pick sqlite for the index?'),
          );
          await r!.after?.();
          return contextOf(r!.output);
        };
        await start(ctx.root, 'startup');
        assert.match(await ask(), /Use SQLite/);
        assert.equal(await ask(), '');
        assert.equal(await start(ctx.root, 'resume'), '');
        assert.equal(await ask(), '', 'still recalled once');
        for (const source of ['startup', 'clear', 'fork']) {
          assert.match(await start(ctx.root, source), /Use SQLite for the index/, source);
          assert.match(await ask(), /Use SQLite/, `${source} resets the recall list`);
        }
      });

      it('startup, clear, fork and an unknown or missing source inject even when unchanged', async () => {
        const ctx = await seeded();
        await start(ctx.root, 'startup');
        for (const source of ['startup', 'clear', 'fork', 'something-new', undefined]) {
          assert.match(await start(ctx.root, source), /Use SQLite for the index/, String(source));
        }
      });

      it('no session entry, or an entry without a hash, injects on resume', async () => {
        const ctx = await seeded();
        assert.match(await start(ctx.root, 'resume', 'never-started'), /Use SQLite/);
        await setSession(ctx, { session_id: 'old-entry', handoff: 'some-task' });
        assert.equal(getSession(ctx, 'old-entry')?.overview, undefined);
        assert.match(await start(ctx.root, 'resume', 'old-entry'), /Use SQLite/);
      });

      it('a corrupt state.toml injects on resume and is left as it is', async () => {
        const ctx = await seeded();
        await start(ctx.root, 'startup');
        writeFileSync(stateFile(ctx.root), 'not = [toml\n');
        const r = await handle('session-start', startInput(ctx.root, 'resume'));
        assert.match(contextOf(r!.output), /Use SQLite/);
        await r!.after?.();
        assert.equal(stateOf(ctx.root), 'not = [toml\n');
      });

      it('a missing state.toml injects on resume', async () => {
        const ctx = await seeded();
        assert.equal(
          contextOf(
            (await handle('session-start', startInput(ctx.root, 'resume')))!.output,
          ).includes('Use SQLite'),
          true,
        );
      });

      it('a session id the host did not give (or an invalid one) injects on resume', async () => {
        const ctx = await seeded();
        await start(ctx.root, 'startup');
        const noId = json({ cwd: ctx.root, hook_event_name: 'SessionStart', source: 'resume' });
        assert.match(contextOf((await handle('session-start', noId))!.output), /Use SQLite/);
        assert.match(await start(ctx.root, 'resume', 'bad id with spaces'), /Use SQLite/);
      });
    });
  }

  it('the other hook writes keep the stored hash', async () => {
    const ctx = await seeded();
    const hc = { cwd: ctx.root, host: 'codex', session_id: SID };
    await (await sessionStart({ source: 'startup' }, hc)).after?.();
    const claimed = await setSession(ctx, {
      session_id: SID,
      stop_turn: 'turn-1',
      claim_stop_turn: true,
    });
    assert.equal(claimed.claimed, true);
    assert.match(stateOf(ctx.root), new RegExp(`overview = "[0-9a-f]{32}"`));
    const out = await sessionStart({ source: 'resume' }, hc);
    assert.equal(out.inject, undefined);
    assert.equal(out.notice, undefined);
  });

  it('the hash is a plain hex digest of 32 characters and is validated by setSession', async () => {
    const ctx = await seeded();
    await (
      await sessionStart({ source: 'startup' }, { cwd: ctx.root, host: 'codex', session_id: SID })
    ).after?.();
    assert.match(stateOf(ctx.root), /overview = "[0-9a-f]{32}"/);
    await assert.rejects(
      setSession(ctx, { session_id: SID, overview: 'NOT HEX' }),
      /invalid overview hash/,
    );
    await assert.rejects(
      setSession(ctx, { session_id: SID, overview: 'abc' }),
      /invalid overview hash/,
    );
    assert.equal(getSession(ctx, SID)?.overview?.length, 32);
  });

  it('a busy lock when the hash would be stored means the next resume injects', async () => {
    const ctx = await seeded();
    const hc = { cwd: ctx.root, host: 'codex', session_id: SID };
    const lock = await acquireLock(layoutOf(ctx.root), { waitMs: 1000 });
    try {
      const out = await sessionStart({ source: 'startup' }, hc);
      assert.ok(out.inject, 'served from the existing index');
      await out.after?.();
    } finally {
      lock.release();
    }
    const next = await sessionStart({ source: 'resume' }, hc);
    assert.ok(next.inject, 'no hash was stored, so resume injects');
  });

  it('a stored hash from an older overview never matches a changed one (hash is of the content)', async () => {
    const ctx = await seeded();
    const hc = { cwd: ctx.root, host: 'codex', session_id: SID };
    await (await sessionStart({ source: 'startup' }, hc)).after?.();
    const a = (getSession(ctx, SID) as { overview?: string }).overview;
    await add(ctx, { type: 'preference', title: 'Prefer tabs', body: 'tabs' });
    const out = await sessionStart({ source: 'resume' }, hc);
    assert.ok(out.inject);
    await out.after?.();
    const b = (getSession(ctx, SID) as { overview?: string }).overview;
    assert.notEqual(a, b);
  });
});
