// Time and size budgets for hooks. One table, one deadline for every event.
//
// The host kills a hook at the `timeout` written into its hooks file; mwf must always answer
// BEFORE that, because a hook that is killed shows the user an error (and, in 0.x, issue #33 was a
// Stop hook whose 15 s host timeout and 14.5 s kill fought each other). So:
//
//   lock waits  <  soft deadline  <  supervisor deadline (kills the worker)  <  host timeout
//
// and the order is checked by tests/hooks.test.ts.

/** The supervisor kills the worker after this long and answers with the fallback. */
export const HOOK_DEADLINE_MS = 4_000;

/** The `timeout` (seconds) `mwf install` writes for every hook event. Always above HOOK_DEADLINE_MS. */
export const HOST_TIMEOUT_S = 5;

/** After this long into a run the worker starts no optional write (session bookkeeping). */
export const HOOK_SOFT_MS = 2_500;

/**
 * Lock wait for every lock a hook may take. Very short on purpose: if the lock is busy, a read
 * serves the existing index without recovery or refresh, and a write is given up.
 */
export const HOOK_LOCK_WAIT_MS = 200;

/** The most locks one hook run can try to take (status for the config, recall, host registration, session write). */
export const MAX_LOCK_WAITS = 4;

/** Biggest stdin a hook reads (the host sends the prompt and the last message). */
export const MAX_STDIN_BYTES = 128 * 1024;

/** Biggest stdout the supervisor accepts from the worker. */
export const MAX_STDOUT_BYTES = 64 * 1024;

/** Characters of stored memory a hook injects, per event (the fenced data only). */
export const SESSION_START_CHARS = 8_000;
export const PROMPT_CHARS = 4_000;

/**
 * Relevance a stored record needs to be injected for a user prompt when the project's
 * `[hooks] recall_min_score` cannot be read. Mirrors core's DEFAULT_RECALL_MIN_SCORE (hooks may not
 * import core; tests/recall-threshold.test.ts keeps the two equal).
 */
export const DEFAULT_RECALL_MIN_SCORE = 2;
