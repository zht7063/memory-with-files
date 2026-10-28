import fs from "node:fs";
import path from "node:path";
let text = "";
for await (const chunk of process.stdin) text += chunk;
const event = JSON.parse(text);
const marker = fs.readFileSync(path.join(event.cwd, "memory.txt"), "utf8");
fs.appendFileSync(
  path.join(event.cwd, "hook-events.jsonl"),
  JSON.stringify({
    at: Date.now(),
    event: event.hook_event_name,
    source: event.source,
    cwd: event.cwd,
    session: event.session_id,
    node: process.execPath,
    marker,
  }) + "\n",
);
console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event.hook_event_name,
      additionalContext: marker,
    },
  }),
);
