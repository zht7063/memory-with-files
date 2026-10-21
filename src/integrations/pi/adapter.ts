// Pi HarnessAdapter (refactor plan §2, PR-07). Pure planning: reads only;
// never writes (enforced by the adapter-write architecture rule).
import fs from "node:fs";
import path from "node:path";
import type { HarnessAdapter, PlannedChange } from "../../contracts/harness.js";
import { MWFError, Transaction } from "../../storage/index.js";
import { resolveSession } from "../../core/identity.js";
import { jsonObject, selectRuntime } from "../shared/runtime.js";
import { piConflictList } from "./conflicts.js";

export const piAdapter: HarnessAdapter = {
  id: "pi",
  // 0.2+ Pi attach writes no project files; the extension loads from the
  // installed package. (0.1 legacy files are no longer managed in 0.3.)
  managedSurfaces: Object.freeze([]),
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
  planDetach(_ctx, owned): PlannedChange[] {
    if (owned.length) throw new Error("Pi owns no project resources");
    return [];
  },
  diagnose() {
    return [];
  },
  resolveSession(ctx, sessionRef) {
    const id = resolveSession(new Transaction(ctx.root), sessionRef);
    if (id.client !== "pi")
      throw new MWFError("CONTEXT_REQUIRED", "Pi reference required.");
    return sessionRef;
  },
};
Object.freeze(piAdapter);
