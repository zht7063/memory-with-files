#!/usr/bin/env node
// Entry point only: dispatches to the CLI layer, the MCP server or a hook and holds no logic of its own.

// node:sqlite prints an ExperimentalWarning when it is first imported (Node 22 / 24). It is not
// actionable for a user of the CLI, and hosts show a command's stderr, so drop that one warning.
const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const text =
    typeof warning === 'string' ? warning : ((warning as Error | undefined)?.message ?? '');
  if (/SQLite is an experimental feature/.test(text)) return;
  emitWarning(warning, ...rest);
}) as typeof process.emitWarning;

// Hooks: always exit 0, whatever happens (see src/hooks/runner.ts). `--worker` is the supervised
// process the hook command starts for itself.
if (process.argv[2] === 'hook') {
  const flush = (text: string): Promise<void> =>
    new Promise((resolve) => void process.stdout.write(text, () => resolve()));
  if (process.argv[4] === '--worker') {
    const { runWorker } = await import('../hooks/worker.ts');
    process.exitCode = await runWorker(process.argv.slice(3), {
      stdin: process.stdin,
      stdout: flush,
      cwd: process.cwd(),
    }).catch(() => 1);
  } else {
    const { runHookCommand } = await import('../hooks/runner.ts');
    process.exitCode = await runHookCommand(process.argv.slice(3), {
      stdin: process.stdin,
      stdout: flush,
      stderr: (text) => void process.stderr.write(text),
      entry: process.argv[1] ?? '',
      execArgv: process.execArgv,
    }).catch(() => 0);
  }
  process.exit();
}

if (process.argv[2] === 'mcp') {
  const { serveMcp } = await import('../mcp/server.ts');
  process.exitCode = await serveMcp(process.argv.slice(3), {
    cwd: process.cwd(),
    stderr: (text) => void process.stderr.write(text),
  });
  process.exit();
}

const { main } = await import('../cli/main.ts');
const { readLimited } = await import('../cli/stdin.ts');

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  cwd: process.cwd(),
  tty: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
  stdin: async (maxBytes) => {
    // Refuse to wait on an interactive terminal: `--body-file -` is for pipes and redirects.
    if (process.stdin.isTTY) throw new Error('standard input is a terminal; pipe the text in');
    return readLimited(process.stdin, maxBytes);
  },
});
