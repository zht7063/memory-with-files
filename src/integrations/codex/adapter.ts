// Codex HarnessAdapter (refactor plan §2, PR-06). Pure planning: reads only
// through ctx/the filesystem for runtime discovery and never writes.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import type {
  HarnessAdapter,
  HarnessContext,
  OwnedResource,
  PlannedChange,
} from "../../contracts/harness.js";
import { MWFError } from "../../storage/index.js";
import { jsonObject, selectRuntime } from "../shared/runtime.js";

const SURFACE = "codex.config.block" as const;
const CONFIG = ".codex/config.toml";
const start = "# mwf:mcp:start",
  end = "# mwf:mcp:end";

/** The single MWF-owned block in a Codex config, or null. */
export function block(text: string) {
  const n = text.split(start).length - 1,
    m = text.split(end).length - 1;
  if (n !== m || n > 1 || (n && text.indexOf(end) < text.indexOf(start)))
    throw new MWFError("OWNERSHIP_CONFLICT", "Malformed MWF TOML markers.");
  return n
    ? text.slice(text.indexOf(start), text.indexOf(end) + end.length)
    : null;
}

function semverParts(version: string) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
    version,
  );
}
function compareVersions(a: string, b: string) {
  const x = semverParts(a)!,
    y = semverParts(b)!;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(x[i]) - Number(y[i]);
    if (difference) return difference;
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const left = x[4].split("."),
    right = y[4].split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    if (left[i] === right[i]) continue;
    const ln = /^\d+$/.test(left[i]!),
      rn = /^\d+$/.test(right[i]!);
    if (ln && rn) return Number(left[i]) - Number(right[i]);
    if (ln !== rn) return ln ? -1 : 1;
    return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}

function candidates(ctx: HarnessContext, pluginRoot: string | undefined) {
  if (pluginRoot) return [path.resolve(pluginRoot)];
  const own = fileURLToPath(new URL("../../../", import.meta.url));
  // A bundled runtime can identify its enclosing plugin without a global CLI.
  if (fs.existsSync(path.join(own, "../plugin.json")))
    return [path.resolve(own, "..")];
  const found: string[] = [];
  const cache = path.join(
    ctx.env.CODEX_HOME ?? path.join(ctx.env.HOME ?? "", ".codex"),
    "plugins/cache",
  );
  const directories = (dir: string) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((item) => item.isDirectory())
          .map((item) => item.name)
      : [];
  for (const marketplace of directories(cache)) {
    for (const plugin of directories(path.join(cache, marketplace))) {
      const base = path.join(cache, marketplace, plugin);
      const versions = directories(base);
      const selected = versions.includes("local")
        ? "local"
        : versions
            .filter((version) => semverParts(version) !== null)
            .sort(compareVersions)
            .at(-1);
      if (selected) found.push(path.join(base, selected));
    }
  }
  return found;
}

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  managedSurfaces: Object.freeze([SURFACE]),
  contextInjection: "hook-process",
  detect(ctx, hint) {
    const found = selectRuntime(
      candidates(ctx, hint?.pluginRoot),
      hint?.pluginRoot,
      (base) => path.join(base, "runtime"),
      (base, _root, pkg) => {
        const manifest = jsonObject(
          fs.readFileSync(path.join(base, "plugin.json"), "utf8"),
        );
        if (manifest.name !== "mwf" || manifest.version !== pkg.version)
          throw Error("Plugin/runtime version mismatch");
      },
    );
    return {
      pluginRoot: found.plugin_root,
      runtimePath: found.entry,
      version: found.version,
    };
  },
  conflicts() {
    // Codex conflicts are ownership checks on the config block (planAttach).
    return [];
  },
  planAttach(ctx, runtime, binding): PlannedChange[] {
    const current = ctx.read(SURFACE);
    const created = current === null,
      old = current ?? "",
      parsed = TOML.parse(old),
      existing = block(old);
    const resource = binding.owned.find((v) => v.kind === "block");
    if (existing && (!resource || resource.installed !== existing))
      throw new MWFError(
        "OWNERSHIP_CONFLICT",
        "Codex mwf block is not owned or was modified.",
      );
    if (
      !existing &&
      parsed.mcp_servers &&
      typeof parsed.mcp_servers === "object" &&
      "mwf" in parsed.mcp_servers
    )
      throw new MWFError(
        "OWNERSHIP_CONFLICT",
        "Existing Codex mwf server is not owned.",
      );
    const text = `${start}\n[mcp_servers.mwf]\ncommand = ${JSON.stringify(ctx.nodePath)}\nargs = ${JSON.stringify([runtime.runtimePath, "mcp", "--root", ctx.root, "--harness", "codex", "--binding-generation", binding.generation, "--profile", "agent"])}\n${end}`;
    const merged = existing
      ? old.replace(existing, text)
      : old + (old.endsWith("\n") || !old ? "" : "\n") + text + "\n";
    TOML.parse(merged);
    return [
      {
        surface: SURFACE,
        after: merged,
        resource: {
          kind: "block",
          surface: SURFACE,
          installed: text,
          created: resource ? resource.created : created,
        },
      },
    ];
  },
  planDetach(ctx, owned: readonly OwnedResource[]): PlannedChange[] {
    const changes: PlannedChange[] = [];
    for (const resource of owned) {
      const raw = ctx.read(resource.surface);
      if (raw === null) continue;
      const current = block(raw);
      if (current === null) continue;
      if (current !== resource.installed)
        throw new Error("owned block changed");
      const next = raw.replace(current + "\n", "").replace(current, "");
      TOML.parse(next);
      changes.push({
        surface: resource.surface,
        after: resource.created && !next.trim() ? null : next,
      });
    }
    return changes;
  },
  diagnose(_ctx, client) {
    return client.enabled && !client.ownedCount
      ? [{ code: "OWNERSHIP_MISSING" }]
      : [];
  },
  attachWarnings(ctx) {
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", CONFIG], {
        cwd: ctx.root,
        stdio: "pipe",
      });
      return [
        `${CONFIG} is tracked; absolute local runtime paths will be included. Git index was not changed.`,
      ];
    } catch {
      return [];
    }
  },
};
Object.freeze(codexAdapter);
