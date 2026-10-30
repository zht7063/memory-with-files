import { writeSync } from 'node:fs';

/**
 * Fault injection for crash-safety tests. When MWF_FAILPOINT=<name>[@<n>] is set, the process
 * SIGKILLs itself on the n-th (default 1st) time it reaches the failpoint called <name>.
 * With MWF_FAILPOINT_STALL=<ms> as well it instead announces `failpoint-stalled <name>` on stderr
 * and blocks for that long, so a test can kill it from outside (SIGTERM) at a known point.
 * Without MWF_FAILPOINT this is a no-op.
 */
const hits = new Map<string, number>();

let hook: ((name: string) => void) | null = null;

/** In-process observer of failpoints, for tests that need to interleave an action (e.g. steal a lock). */
export function setFailpointHook(fn: ((name: string) => void) | null): void {
  hook = fn;
}

export function failpoint(name: string): void {
  hook?.(name);
  const spec = process.env['MWF_FAILPOINT'];
  if (!spec) return;
  const [target, nth = '1'] = spec.split('@');
  if (target !== name) return;
  const count = (hits.get(name) ?? 0) + 1;
  hits.set(name, count);
  if (count !== Number(nth)) return;
  const stall = Number(process.env['MWF_FAILPOINT_STALL'] ?? 0);
  if (stall > 0) {
    writeSync(2, `failpoint-stalled ${name}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stall);
    return;
  }
  process.kill(process.pid, 'SIGKILL');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
