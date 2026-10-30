import { MAX_STDIN_BYTES } from './budget.ts';
import { handleCodex, isCodexEvent } from './codex.ts';

/**
 * The worker half of `mwf hook <event>` (the supervisor in ./runner.ts starts it as
 * `mwf hook <event> --worker`). It prints the host's JSON as ONE line the moment the answer is
 * ready, then does its optional bookkeeping writes and exits; the supervisor delivers the line even
 * if the worker is still busy (or killed) when the deadline comes. Exit code 1 means "no answer".
 */
export interface WorkerIo {
  stdin: AsyncIterable<Buffer | string>;
  /** Resolves once the text has been flushed. */
  stdout(text: string): Promise<void>;
  cwd: string;
}

async function readAll(stream: AsyncIterable<Buffer | string>): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > MAX_STDIN_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function runWorker(argv: readonly string[], io: WorkerIo): Promise<number> {
  const started = Date.now();
  const event = argv[0];
  if (!isCodexEvent(event)) return 1;
  const hostFlag = argv.indexOf('--host');
  const host = hostFlag >= 0 ? argv[hostFlag + 1] : undefined;
  const text = await readAll(io.stdin);
  if (text === null) return 1;
  const handled = await handleCodex(event, text, {
    cwd: io.cwd,
    started,
    ...(host && /^[a-z][a-z0-9_-]{0,30}$/.test(host) ? { host } : {}),
  });
  if (handled === null) return 1;
  await io.stdout(JSON.stringify(handled.output) + '\n');
  try {
    await handled.after?.();
  } catch {
    // bookkeeping only
  }
  return 0;
}
