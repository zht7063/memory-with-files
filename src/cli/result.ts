import * as core from '../core/index.ts';

export interface CliError {
  /** A core error code, or one of the CLI's own. */
  code: core.MwfErrorCode | 'UNKNOWN_COMMAND' | 'INTERNAL';
  message: string;
  details: Record<string, unknown>;
}

/** What every CLI function returns; it never throws. MCP maps it onto a tool result unchanged. */
export type CliResult<T = unknown> = { ok: true; data: T } | { ok: false; error: CliError };

export function toError(error: unknown): CliError {
  if (error instanceof core.MwfError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  // Anything else is a bug or an environment fault: keep the message, never a stack or file contents.
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}
