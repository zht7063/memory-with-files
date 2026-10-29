#!/usr/bin/env node
// Entry point only: dispatches to the CLI layer and holds no logic of its own.

// node:sqlite prints an ExperimentalWarning when it is first imported (Node 22 / 24). It is not
// actionable for a user of the CLI, and hosts show a command's stderr, so drop that one warning.
const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const text =
    typeof warning === 'string' ? warning : ((warning as Error | undefined)?.message ?? '');
  if (/SQLite is an experimental feature/.test(text)) return;
  emitWarning(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import('../cli/main.ts');

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  cwd: process.cwd(),
});
