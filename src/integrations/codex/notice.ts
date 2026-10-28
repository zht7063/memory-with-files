import fs from "node:fs";
import { z } from "zod";
import { discover } from "../shared/binding.js";
import { hash, safePath } from "../../storage/index.js";
// Diagnostic markers are exclusive files; they must not wait on the data lock at the hook deadline.
export function failureNotice(
  input: unknown,
  category: string,
  message: string,
) {
  const parsed = z
    .object({ cwd: z.string(), session_id: z.string().min(1).max(1000) })
    .safeParse(input);
  if (parsed.success) {
    try {
      const root = discover(parsed.data.cwd);
      if (root) {
        const directory = safePath(root, ".mwf/local/hook-notices");
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = safePath(
          root,
          `.mwf/local/hook-notices/${hash(JSON.stringify([parsed.data.session_id, category]))}.json`,
        );
        let fd: number;
        try {
          fd = fs.openSync(file, "wx", 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return {};
          throw error;
        }
        try {
          fs.writeFileSync(
            fd,
            JSON.stringify({ category, at: new Date().toISOString() }),
          );
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      /* A damaged or unavailable project must not block the task. */
    }
  }
  return { systemMessage: message };
}
// A Stop failure must never hold the turn open or add per-turn noise: allow the stop.
export function isStopEvent(input: unknown) {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { hook_event_name?: unknown }).hook_event_name === "Stop"
  );
}
// The Stop hook command carries `--stop` (see hooks.json), so failures are
// recognised even when stdin is empty, malformed, not an object or oversized.
export function isStopRun(argv: readonly string[], input: unknown) {
  return argv.includes("--stop") || isStopEvent(input);
}
