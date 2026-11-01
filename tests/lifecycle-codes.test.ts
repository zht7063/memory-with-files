// F2: the refusal/failure code names are printed in the text output, equal to the --json code.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { lifecycleMain } from '../src/lifecycle/main.ts';
import { sandbox } from './helpers/fake-codex.ts';
import { claudeSandbox } from './helpers/fake-claude.ts';
import { piSandbox } from './helpers/fake-pi.ts';
import { tmpDir } from './helpers/util.ts';

/** A world-writable directory outside every sandbox: the stand-in for /tmp. */
function trapDir(mode = 0o777): string {
  const dir = tmpDir('mwf-trap-');
  chmodSync(dir, mode);
  return dir;
}

// ---- F2: the code names in the text output -------------------------------------------------

interface Prep {
  home: string;
  env: NodeJS.ProcessEnv;
  bin: Record<string, string>;
  entry: string;
}

describe('F2: the text output carries the code names, equal to the --json code', () => {
  const TTY = { stdin: true, stdout: true };

  async function both(
    harness: 'codex' | 'claude' | 'pi',
    prepare: () => Prep,
    cmd: 'install' | 'uninstall',
  ): Promise<{ text: string; json: any; code: number }> {
    const run = async (json: boolean) => {
      const p = prepare();
      const res = { out: '', err: '' };
      const code = await lifecycleMain([cmd, '--harness', harness, ...(json ? ['--json'] : [])], {
        stdout: (t) => (res.out += t),
        stderr: (t) => (res.err += t),
        entry: p.entry,
        env: p.env,
        home: p.home,
        tty: TTY,
        ...p.bin,
      });
      return { code, text: res.out + res.err };
    };
    const t = await run(false);
    const j = await run(true);
    return { text: t.text, json: JSON.parse(j.text).data, code: t.code };
  }

  const unsafePrep = {
    codex: () => {
      const sb = sandbox();
      const trap = trapDir(0o1777);
      mkdirSync(join(sb.home, '.agents'));
      symlinkSync(trap, join(sb.home, '.agents', 'skills'));
      return { home: sb.home, env: sb.env, bin: { codexBin: sb.codex }, entry: sb.mwfJs };
    },
    claude: () => {
      const sb = claudeSandbox();
      const trap = trapDir(0o1777);
      mkdirSync(sb.claudeDir, { recursive: true });
      symlinkSync(trap, join(sb.claudeDir, 'skills'));
      return { home: sb.home, env: sb.env, bin: { claudeBin: sb.claude }, entry: sb.mwfJs };
    },
    pi: () => {
      const sb = piSandbox();
      const trap = trapDir(0o1777);
      mkdirSync(sb.piDir, { recursive: true });
      symlinkSync(trap, join(sb.piDir, 'skills'));
      return { home: sb.home, env: sb.env, bin: { piBin: sb.pi }, entry: sb.mwfJs };
    },
  } as const;

  for (const harness of ['codex', 'claude', 'pi'] as const)
    it(`${harness}: an unsafe skills root prints UNSAFE_TARGET (install and uninstall), the same code as --json`, async () => {
      for (const cmd of ['install', 'uninstall'] as const) {
        const r = await both(harness, unsafePrep[harness] as never, cmd);
        assert.equal(r.code, 1);
        assert.equal(r.json.code, 'UNSAFE_TARGET', `${cmd}`);
        assert.match(r.text, /UNSAFE_TARGET: /, `${cmd}: ${r.text}`);
        assert.match(r.text, /^    mwf[a-z-]*: refused - UNSAFE_TARGET: /m, r.text);
        assert.doesNotMatch(r.text, /_JSON_REFUSED/);
      }
    });

  it('an unsafe config directory is reported as UNSAFE_TARGET, not as HOOKS_JSON_REFUSED / SETTINGS_JSON_REFUSED', async () => {
    const mk = (kind: 'codex' | 'claude'): Prep => {
      if (kind === 'codex') {
        const sb = sandbox();
        mkdirSync(sb.codexHome, { recursive: true });
        writeFileSync(join(sb.codexHome, 'hooks.json'), '{}\n');
        chmodSync(sb.codexHome, 0o777);
        return { home: sb.home, env: sb.env, bin: { codexBin: sb.codex }, entry: sb.mwfJs };
      }
      const sb = claudeSandbox();
      mkdirSync(sb.claudeDir, { recursive: true });
      writeFileSync(join(sb.claudeDir, 'settings.json'), '{}\n');
      chmodSync(sb.claudeDir, 0o777);
      return { home: sb.home, env: sb.env, bin: { claudeBin: sb.claude }, entry: sb.mwfJs };
    };
    for (const kind of ['codex', 'claude'] as const) {
      const r = await both(kind, () => mk(kind), 'install');
      assert.equal(r.json.code, 'UNSAFE_TARGET', kind);
      assert.match(r.text, /^  UNSAFE_TARGET: /m, r.text);
      assert.doesNotMatch(r.text, /_JSON_REFUSED/);
    }
  });

  it('existing refusals are unchanged: a hooks.json / settings.json that is not JSON is still *_JSON_REFUSED', async () => {
    const codex = () => {
      const sb = sandbox();
      mkdirSync(sb.codexHome, { recursive: true });
      writeFileSync(join(sb.codexHome, 'hooks.json'), '{ nope');
      return { home: sb.home, env: sb.env, bin: { codexBin: sb.codex }, entry: sb.mwfJs };
    };
    const claude = () => {
      const sb = claudeSandbox();
      mkdirSync(sb.claudeDir, { recursive: true });
      writeFileSync(join(sb.claudeDir, 'settings.json'), '{ nope');
      return { home: sb.home, env: sb.env, bin: { claudeBin: sb.claude }, entry: sb.mwfJs };
    };
    const a = await both('codex', codex, 'install');
    assert.equal(a.json.code, 'HOOKS_JSON_REFUSED');
    assert.match(a.text, /^  HOOKS_JSON_REFUSED: /m);
    const b = await both('claude', claude, 'install');
    assert.equal(b.json.code, 'SETTINGS_JSON_REFUSED');
    assert.match(b.text, /^  SETTINGS_JSON_REFUSED: /m);
  });

  it('CONFIG_CHANGED_UNEXPECTEDLY is printed on the mcp line (all three harnesses), equal to the --json code', async () => {
    const prep = {
      codex: () => {
        const sb = sandbox();
        return {
          home: sb.home,
          env: { ...sb.env, FAKE_CODEX_MODE: 'clobber' },
          bin: { codexBin: sb.codex },
          entry: sb.mwfJs,
        };
      },
      claude: () => {
        const sb = claudeSandbox();
        return {
          home: sb.home,
          env: { ...sb.env, FAKE_CLAUDE_MODE: 'clobber' },
          bin: { claudeBin: sb.claude },
          entry: sb.mwfJs,
        };
      },
      pi: () => {
        const sb = piSandbox();
        return {
          home: sb.home,
          env: { ...sb.env, FAKE_PI_MODE: 'clobber' },
          bin: { piBin: sb.pi },
          entry: sb.mwfJs,
        };
      },
    } as const;
    for (const h of ['codex', 'claude', 'pi'] as const) {
      const r = await both(h, prep[h], 'install');
      assert.equal(r.json.code, 'CONFIG_CHANGED_UNEXPECTEDLY', h);
      assert.match(r.text, /^  CONFIG_CHANGED_UNEXPECTEDLY: /m, h);
      assert.match(r.text, /^  mcp +unexpected_change - CONFIG_CHANGED_UNEXPECTEDLY: /m, r.text);
    }
  });
});
