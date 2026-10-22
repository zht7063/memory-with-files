import { failureNotice } from "./notice.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// A supervisor can terminate synchronous filesystem/lock work at the hook deadline.
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("./worker.js", import.meta.url))],
  { stdio: ["pipe", "pipe", "pipe"] },
);
let input = "";
process.stdin.on("data", (chunk) => {
  if (Buffer.byteLength(input) < 131072) input += String(chunk);
});
function notice(category: string, message: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {}
  return failureNotice(parsed, category, message);
}
let output = "",
  startFailed = false,
  expired = false;
const timer = setTimeout(() => {
  expired = true;
  child.kill("SIGKILL");
}, 14_500);
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
child.stdout.on("data", (chunk) => {
  output += String(chunk);
  if (Buffer.byteLength(output) > 65536) child.kill("SIGKILL");
});
child.stderr.resume();
child.on("error", () => {
  startFailed = true;
  clearTimeout(timer);
  console.log(
    JSON.stringify(
      notice(
        "runtime-start",
        "MWF: local runtime could not start; memory was not restored.",
      ),
    ),
  );
});
child.on("close", (code) => {
  if (startFailed) return;
  clearTimeout(timer);
  if (code === 0 && !expired) process.stdout.write(output);
  else
    console.log(
      JSON.stringify(
        notice(
          expired ? "timeout" : "read-failed",
          expired
            ? "MWF: memory read timed out; continue and inspect mwf status."
            : "MWF: memory was not restored; inspect mwf doctor.",
        ),
      ),
    );
});
