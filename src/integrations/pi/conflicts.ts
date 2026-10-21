import fs from "node:fs";
import path from "node:path";
import type { Conflict } from "../../contracts/harness.js";
import { jsonObject } from "../shared/runtime.js";

/** Pi configuration that would load a second `mwf` MCP server. `path` is
 * absolute; `reason` names the conflicting entry. */
export function piConflictList(
  root: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Conflict[] {
  const problems: Conflict[] = [];
  for (const base of [
    env.PI_CODING_AGENT_DIR ?? path.join(env.HOME ?? "", ".pi/agent"),
    path.join(root, ".pi"),
  ]) {
    for (const name of ["mcp.json", "settings.json"]) {
      const file = path.join(base, name);
      if (!fs.existsSync(file)) continue;
      const v = jsonObject(fs.readFileSync(file, "utf8"));
      if (
        name === "mcp.json" &&
        v.mcpServers &&
        typeof v.mcpServers === "object" &&
        "mwf" in v.mcpServers
      )
        problems.push({ path: file, reason: "mcpServers.mwf" });
      if (
        name === "settings.json" &&
        JSON.stringify([v.packages ?? [], v.extensions ?? []]).includes(
          "pi-mcp-adapter",
        )
      )
        problems.push({ path: file, reason: "pi-mcp-adapter" });
    }
  }
  return problems;
}
/** Legacy string form (`<file>: <reason>`), kept for existing callers. */
export function piConflicts(root: string) {
  return piConflictList(root).map((c) => `${c.path}: ${c.reason}`);
}
