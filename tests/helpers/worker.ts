// Child-process entry used by the concurrency / crash tests.
// argv[2] = JSON {ctx, calls: [{fn, input}]}; prints JSON array of results (or {error}) to stdout.
import * as core from '../../src/core/index.ts';

const spec = JSON.parse(process.argv[2] ?? '{}') as {
  ctx: core.Ctx;
  calls: Array<{ fn: string; input?: unknown }>;
};
const results: unknown[] = [];
let failed = false;
for (const call of spec.calls) {
  try {
    const fn = (core as unknown as Record<string, (c: core.Ctx, i?: unknown) => Promise<unknown>>)[
      call.fn
    ];
    if (!fn) throw new Error(`unknown fn ${call.fn}`);
    results.push(await fn(spec.ctx, call.input));
  } catch (error) {
    failed = true;
    const e = error as { code?: string; message?: string };
    results.push({ error: { code: e.code ?? 'ERR', message: e.message } });
  }
}
process.stdout.write(JSON.stringify(results));
process.exit(failed ? 1 : 0);
