// Pi HarnessAdapter (refactor plan §2, PR-07). Pure planning: reads only;
// never writes (enforced by the adapter-write architecture rule).
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  DiagnosticIssue,
  HarnessAdapter,
  OwnedResource,
  PlannedChange,
} from "../../contracts/harness.js";
import { MWFError, hash, Transaction } from "../../storage/index.js";
import { resolveSession } from "../../core/identity.js";
import { jsonObject, selectRuntime } from "../shared/runtime.js";
import { piConflictList } from "./conflicts.js";

// 0.1 artifacts this adapter can still verify and undo; 0.2 Pi attach writes
// no project files (the extension is loaded from the installed package).
const LEGACY = [
  "legacy.pi.mcp",
  "legacy.pi.extension",
  "skill.memory-with-files",
  "skill.mwf-init",
  "skill.mwf-status",
] as const;

function ownsIntact(raw: string | null, resource: OwnedResource) {
  if (resource.kind === "file") return hash(raw) === resource.installed_hash;
  if (resource.kind === "json")
    return (
      raw !== null &&
      JSON.stringify(JSON.parse(raw).mcpServers?.mwf) ===
        JSON.stringify(resource.installed)
    );
  return false;
}

export const piAdapter: HarnessAdapter = {
  id: "pi",
  managedSurfaces: Object.freeze([...LEGACY]),
  contextInjection: "in-process-extension",
  detect(ctx, hint) {
    const candidates: string[] = [];
    if (hint?.pluginRoot) candidates.push(path.resolve(hint.pluginRoot));
    else
      for (const dir of [
        path.join(ctx.root, ".pi"),
        ctx.env.PI_CODING_AGENT_DIR ??
          path.join(ctx.env.HOME ?? "", ".pi/agent"),
      ]) {
        const file = path.join(dir, "settings.json");
        if (!fs.existsSync(file)) continue;
        const settings = jsonObject(fs.readFileSync(file, "utf8"));
        for (const value of Array.isArray(settings.packages)
          ? settings.packages
          : []) {
          const source = typeof value === "string" ? value : value?.source;
          if (typeof source === "string")
            candidates.push(
              source.startsWith("npm:@zht7063/mwf")
                ? path.join(dir, "npm/node_modules/@zht7063/mwf")
                : path.resolve(dir, source),
            );
        }
      }
    const found = selectRuntime(
      candidates,
      hint?.pluginRoot,
      (base) => base,
      (_base, runtimeRoot, pkg) => {
        if (
          !pkg.pi ||
          !fs.existsSync(
            path.join(runtimeRoot, "dist/integrations/pi/index.js"),
          )
        )
          throw Error("Missing Pi extension");
      },
    );
    return {
      pluginRoot: found.plugin_root,
      runtimePath: found.entry,
      version: found.version,
    };
  },
  conflicts(ctx) {
    return piConflictList(ctx.root, ctx.env);
  },
  planAttach() {
    // 0.2 Pi attach only updates the receipt.
    return [];
  },
  planDetach(ctx, owned): PlannedChange[] {
    const changes: PlannedChange[] = [];
    for (const resource of owned) {
      if (resource.kind === "block") throw new Error("not a Pi resource");
      const raw = ctx.read(resource.surface);
      if (resource.kind === "file") {
        if (raw === null) continue;
        if (hash(raw) !== resource.installed_hash)
          throw new Error("owned file changed");
        changes.push({ surface: resource.surface, after: resource.before });
      } else {
        const obj = jsonObject(raw),
          servers = z.record(z.unknown()).parse(obj.mcpServers ?? {});
        if (!("mwf" in servers)) continue;
        if (JSON.stringify(servers.mwf) !== JSON.stringify(resource.installed))
          throw new Error("owned key changed");
        if (resource.before === null) delete servers.mwf;
        else servers.mwf = resource.before;
        obj.mcpServers = servers;
        changes.push({
          surface: resource.surface,
          after: JSON.stringify(obj, null, 2) + "\n",
        });
      }
    }
    return changes;
  },
  diagnose(ctx, client) {
    const issues: DiagnosticIssue[] = [];
    for (const resource of client.owned) {
      if (resource.kind === "block") continue;
      try {
        if (!ownsIntact(ctx.read(resource.surface), resource))
          throw new Error("changed");
      } catch {
        issues.push({ code: "OWNERSHIP_CONFLICT", surface: resource.surface });
      }
    }
    return issues;
  },
  resolveSession(ctx, sessionRef) {
    const id = resolveSession(new Transaction(ctx.root), sessionRef);
    if (id.client !== "pi")
      throw new MWFError("CONTEXT_REQUIRED", "Pi reference required.");
    return sessionRef;
  },
};
Object.freeze(piAdapter);
