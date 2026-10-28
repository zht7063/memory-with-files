import fs from "node:fs";
import { safePath } from "../../storage/index.js";
import { turnKey } from "./stop.js";
// Defence in depth for the Stop loop guard. The host flag `stop_hook_active` is
// the primary guard; this marker (session_id + turn_id) makes a second Stop for
// the same turn allow even if a host omits the flag. Markers are tiny, exclusive
// files under the project's local state, pruned to a fixed bound.
const DIRECTORY = ".mwf/local/stop-guards";
const MAX_MARKERS = 200;
const KEEP_MARKERS = 100;
export function claimStopGuard(
  root: string,
  sessionId: string,
  turnId: string,
): boolean {
  try {
    const directory = safePath(root, DIRECTORY);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = safePath(
      root,
      `${DIRECTORY}/${turnKey(sessionId, turnId)}.json`,
    );
    let fd: number;
    try {
      fd = fs.openSync(file, "wx", 0o600);
    } catch {
      // Already claimed (this turn was blocked before) or unwritable: allow.
      return false;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ at: new Date().toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
    prune(directory, file);
    return true;
  } catch {
    return false;
  }
}
function prune(directory: string, keep: string) {
  try {
    const entries = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => `${directory}/${name}`)
      .filter((full) => full !== keep)
      .map((full) => {
        return { full, mtime: fs.statSync(full).mtimeMs };
      });
    if (entries.length <= MAX_MARKERS) return;
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const old of entries.slice(KEEP_MARKERS))
      fs.rmSync(old.full, { force: true });
  } catch {
    /* Pruning is best effort. */
  }
}
