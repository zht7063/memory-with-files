// Fixed one-line messages hooks show to the user. No imports: the supervisor loads this file.

/** SessionStart / UserPromptSubmit failed, timed out or crashed (never shown for Stop). */
export const FAILURE_NOTICE = 'mwf: the memory hook could not run; run `mwf doctor`.';

/** SessionStart inside a git repository that has no `.mwf/`. */
export const UNINITIALIZED_NOTICE =
  'mwf: this git repository has no memory yet; run /mwf init to enable it.';
