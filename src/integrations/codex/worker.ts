import { withLockDeadline } from "../../storage/index.js";
import { HOOK_LOCK_BUDGET_MS } from "./timeouts.js";
import { handleHook } from "./hook.js";
import { failureNotice } from "./notice.js";
let input = "";
let parsed: unknown;
try {
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 131072)
      throw new Error("Hook input too large");
  }
  parsed = JSON.parse(input);
  console.log(
    JSON.stringify(
      withLockDeadline(HOOK_LOCK_BUDGET_MS, () => handleHook(parsed)),
    ),
  );
} catch {
  console.log(
    JSON.stringify(
      failureNotice(
        parsed,
        "read-failed",
        "MWF: memory was not restored; inspect mwf doctor.",
      ),
    ),
  );
}
