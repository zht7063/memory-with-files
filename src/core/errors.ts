export type MwfErrorCode =
  | 'NOT_INITIALIZED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'LOCK_TIMEOUT'
  | 'LOCK_LOST'
  | 'HASH_MISMATCH'
  | 'ID_COLLISION'
  | 'REQUEST_ID_REUSED'
  | 'CONFIRM_REQUIRES_TOKEN'
  | 'PREVIEW_MISMATCH'
  | 'SECRET_DETECTED'
  | 'GIT_MODE_CONFLICT'
  | 'NOT_GIT_ROOT'
  | 'INDEX_UNAVAILABLE';

/** Error with a stable machine-readable code (surfaced unchanged by the CLI/MCP layers). */
export class MwfError extends Error {
  readonly code: MwfErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: MwfErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'MwfError';
    this.code = code;
    this.details = details;
  }
}

export function invalid(message: string, details: Record<string, unknown> = {}): MwfError {
  return new MwfError('INVALID_ARGUMENT', message, details);
}
