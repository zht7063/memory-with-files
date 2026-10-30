/**
 * The shell command line that executes a previewed destructive operation. The MCP tools only
 * preview; they hand this command back so the user (or the host's shell approval) can run it.
 * The flags here are the ones src/cli/main.ts parses.
 */

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(text: string): string {
  return SAFE.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * `mwf <name> <the preview's arguments> --confirm --preview-token <token>`, or null when `name`
 * is not a destructive command. `cwd` becomes `--cwd` so it works from any directory.
 */
export function shellCommandFor(
  name: string,
  input: Record<string, unknown>,
  token: string,
  cwd?: string,
): string | null {
  const args: string[] = ['mwf', name];
  const each = (flag: string, values: string[]): void => {
    for (const v of values) args.push(flag, shellQuote(v));
  };
  switch (name) {
    case 'forget':
      each('--id', strings(input['ids']));
      if (typeof input['reason'] === 'string') each('--reason', [input['reason']]);
      break;
    case 'purge':
      each('--id', strings(input['ids']));
      break;
    case 'compact':
      each('--type', strings(input['types']));
      break;
    case 'inbox':
      if (input['action'] !== 'discard') return null;
      args.push('discard');
      each('--entry-id', strings(input['entry_ids']));
      break;
    default:
      return null;
  }
  if (cwd) each('--cwd', [cwd]);
  args.push('--confirm', '--preview-token', shellQuote(token));
  return args.join(' ');
}
