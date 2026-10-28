// Hook deadlines (ms). hooks.json timeouts are in seconds and must stay above the
// runner's kill time for the same event (tests/hook-latency.test.ts checks this).
// Session/prompt hooks are on the critical path of every turn and are tokenizer
// free (issue #30), so they get a short deadline; the Stop hook (see hooks.json)
// keeps its own longer one. Values are provisional until measured on real hosts.
export const HOOK_KILL_MS = 4_500;
export const STOP_HOOK_KILL_MS = 14_500;
// Total time all project-lock acquisitions of one hook run may wait; leaves the
// rest of HOOK_KILL_MS for startup and work so lock contention fails open with
// a notice instead of a SIGKILL timeout.
export const HOOK_LOCK_BUDGET_MS = 2_000;
export const killAfterMs = (argv: readonly string[]) =>
  argv.includes("--stop") ? STOP_HOOK_KILL_MS : HOOK_KILL_MS;
