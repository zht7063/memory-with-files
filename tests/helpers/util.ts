import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { init, type Ctx, type GitMode } from '../../src/core/index.ts';

const WORKER = new URL('./worker.ts', import.meta.url).pathname;

export function tmpDir(prefix = 'mwf-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A temporary directory that is a git repository root (holds `.git/`), as init requires. */
export function gitRepo(prefix = 'mwf-test-'): string {
  const dir = tmpDir(prefix);
  mkdirSync(join(dir, '.git'));
  return dir;
}

export async function project(mode: GitMode = 'track', extra: Partial<Ctx> = {}): Promise<Ctx> {
  const ctx: Ctx = { root: gitRepo(), ...extra };
  await init(ctx, { git_mode: mode });
  return ctx;
}

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  results: Array<Record<string, unknown>>;
  stderr: string;
}

export function runChild(
  ctx: Ctx,
  calls: Array<{ fn: string; input?: unknown }>,
  env: Record<string, string> = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', WORKER, JSON.stringify({ ctx, calls })],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      let results: ChildResult['results'] = [];
      try {
        results = out ? (JSON.parse(out) as ChildResult['results']) : [];
      } catch {
        // killed mid-output
      }
      resolve({ code, signal, results, stderr: err });
    });
  });
}
