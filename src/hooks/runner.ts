import { spawn } from 'node:child_process';
import { HOOK_DEADLINE_MS, MAX_STDIN_BYTES, MAX_STDOUT_BYTES } from './budget.ts';
import { FAILURE_NOTICE } from './messages.ts';

/**
 * `mwf hook <event>`: the supervisor. Hooks must never block or fail the host, and synchronous
 * file / SQLite work cannot be interrupted by a timer in the same process, so the real work runs in
 * a worker process (`mwf hook <event> --worker`) that this process can kill. This file loads
 * nothing but node:* and two constants, so it starts fast.
 *
 * Whatever happens (bad stdin, a crash, a hang, too much output, an unknown event) it prints one
 * JSON object and exits 0. A worker that already printed its answer and is then killed still has
 * that answer delivered. Failure answers: a one-line notice for SessionStart / prompt, `{}` for stop.
 */
export interface RunnerIo {
  stdin: AsyncIterable<Buffer | string>;
  /** Resolves once the text has been flushed. */
  stdout(text: string): Promise<void>;
  stderr(text: string): void;
  /** The script that implements `mwf` (the bin), and the node flags it was started with. */
  entry: string;
  execArgv: readonly string[];
}

const EVENTS = ['session-start', 'prompt', 'stop'] as const;
const KNOWN = new Set<string>(EVENTS);

function fallback(event: string): string {
  return JSON.stringify(event === 'stop' ? {} : { systemMessage: FAILURE_NOTICE });
}

function firstJsonLine(output: string): string | null {
  const line = output.split('\n', 1)[0] ?? '';
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? line : null;
  } catch {
    return null;
  }
}

async function readStdin(stream: AsyncIterable<Buffer | string>): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > MAX_STDIN_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Always resolves 0. `deadlineMs` is a test seam; production uses HOOK_DEADLINE_MS. */
export async function runHookCommand(
  argv: readonly string[],
  io: RunnerIo,
  deadlineMs: number = HOOK_DEADLINE_MS,
): Promise<0> {
  const event = argv[0] ?? '';
  let line = fallback(event);
  try {
    if (!KNOWN.has(event)) {
      io.stderr(`mwf hook: unknown event "${event}" (expected ${EVENTS.join(', ')})\n`);
      line = '{}';
    } else {
      line = await supervise(event, argv.slice(1), io, deadlineMs);
    }
  } catch {
    line = fallback(event);
  }
  try {
    await io.stdout(line + '\n');
  } catch {
    // the host closed the pipe: nothing more to do
  }
  return 0;
}

async function supervise(
  event: string,
  rest: readonly string[],
  io: RunnerIo,
  deadlineMs: number,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let done = false;
    let child: ReturnType<typeof spawn> | undefined;
    let output = '';
    const finish = (line: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve(line);
    };
    // The deadline covers reading stdin, starting the worker and the worker itself.
    const timer = setTimeout(() => finish(firstJsonLine(output) ?? fallback(event)), deadlineMs);
    void (async () => {
      const input = await readStdin(io.stdin);
      if (input === null) return finish(fallback(event));
      if (done) return;
      child = spawn(
        process.execPath,
        [...io.execArgv, io.entry, 'hook', event, '--worker', ...rest],
        { stdio: ['pipe', 'pipe', 'ignore'] },
      );
      child.on('error', () => finish(fallback(event)));
      child.stdin?.on('error', () => undefined);
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output) > MAX_STDOUT_BYTES) finish(fallback(event));
      });
      child.on('close', () => finish(firstJsonLine(output) ?? fallback(event)));
      child.stdin?.end(input);
    })().catch(() => finish(fallback(event)));
  });
}
