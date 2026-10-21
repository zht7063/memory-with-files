import fs from "node:fs";
import path from "node:path";
import { MWFError } from "../../storage/index.js";
function object(raw: string | null): Record<string, unknown> {
  const value = JSON.parse(raw ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MWFError("INVALID_CONFIG", "Expected JSON object.");
  return value;
}
export function piConflicts(root: string) {
  const problems: string[] = [];
  for (const base of [
    process.env.PI_CODING_AGENT_DIR ??
      path.join(process.env.HOME ?? "", ".pi/agent"),
    path.join(root, ".pi"),
  ]) {
    for (const name of ["mcp.json", "settings.json"]) {
      const file = path.join(base, name);
      if (!fs.existsSync(file)) continue;
      const v = object(fs.readFileSync(file, "utf8"));
      if (
        name === "mcp.json" &&
        v.mcpServers &&
        typeof v.mcpServers === "object" &&
        "mwf" in v.mcpServers
      )
        problems.push(file + ": mcpServers.mwf");
      if (
        name === "settings.json" &&
        JSON.stringify([v.packages ?? [], v.extensions ?? []]).includes(
          "pi-mcp-adapter",
        )
      )
        problems.push(file + ": pi-mcp-adapter");
    }
  }
  return problems;
}
