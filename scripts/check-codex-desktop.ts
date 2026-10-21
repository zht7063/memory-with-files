import fs from "node:fs";
import { summarizeDesktop } from "./lib/codex-evidence.ts";
const file = process.argv[2] ?? "docs/validation/codex-desktop-t08.json";
try {
  console.log(
    JSON.stringify(
      summarizeDesktop(JSON.parse(fs.readFileSync(file, "utf8"))),
      null,
      2,
    ),
  );
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
