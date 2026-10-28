import { handleHook } from "./hook.js";
import { failureNotice, isStopRun } from "./notice.js";
let input = "";
let parsed: unknown;
try {
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 131072)
      throw new Error("Hook input too large");
  }
  parsed = JSON.parse(input);
  console.log(JSON.stringify(handleHook(parsed)));
} catch {
  console.log(
    JSON.stringify(
      isStopRun(process.argv, parsed)
        ? {}
        : failureNotice(
            parsed,
            "read-failed",
            "MWF: memory was not restored; inspect mwf doctor.",
          ),
    ),
  );
}
