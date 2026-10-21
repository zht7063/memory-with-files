import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import TOML from "@iarna/toml";
import { z } from "zod";
import { config, initialize, execute, type Result } from "../core.js";
import {
  canonicalRoot,
  hash,
  MWFError,
  recover,
  Transaction,
  withProjectLock,
} from "../storage/index.js";
import { RUNTIME_VERSION } from "../contracts/version.js";
import {
  receipt,
  receiptFile,
  type Harness,
  type Receipt,
} from "../integrations/shared/binding.js";
const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const start = "# mwf:mcp:start",
  end = "# mwf:mcp:end";
const inputSchema = z
  .object({
    project_root: z.string(),
    harness: z.enum(["pi", "codex", "all"]),
    plugin_root: z.string().optional(),
    apply: z.boolean().default(false),
    dry_run: z.boolean().default(false),
  })
  .strict();
function output(
  op: string,
  root: string,
  data: unknown,
  changed_files: string[] = [],
  ok = true,
  warnings: string[] = [],
): Result {
  return {
    ok,
    operation: op,
    project_root: root,
    runtime_version: RUNTIME_VERSION,
    api_version: 2,
    schema_version: 1,
    changed_files,
    warnings,
    data,
  };
}
function block(text: string) {
  const n = text.split(start).length - 1,
    m = text.split(end).length - 1;
  if (n !== m || n > 1 || (n && text.indexOf(end) < text.indexOf(start)))
    throw new MWFError("OWNERSHIP_CONFLICT", "Malformed MWF TOML markers.");
  return n
    ? text.slice(text.indexOf(start), text.indexOf(end) + end.length)
    : null;
}
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
        JSON.stringify(v.packages ?? []).includes("pi-mcp-adapter")
      )
        problems.push(file + ": pi-mcp-adapter");
    }
  }
  return problems;
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
    const ln = /^\d+$/.test(left[i]),
      rn = /^\d+$/.test(right[i]);
    if (ln && rn) return Number(left[i]) - Number(right[i]);
    if (ln !== rn) return ln ? -1 : 1;
    return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}
export function locateRuntime(
  pluginRoot: string | undefined,
  harness: Harness,
  root: string,
) {
  const own = fileURLToPath(new URL("../../", import.meta.url));
  const candidates: string[] = [];
  if (pluginRoot) candidates.push(path.resolve(pluginRoot));
  else if (harness === "pi") {
    for (const dir of [
      path.join(root, ".pi"),
      process.env.PI_CODING_AGENT_DIR ??
        path.join(process.env.HOME ?? "", ".pi/agent"),
    ]) {
      const file = path.join(dir, "settings.json");
      if (!fs.existsSync(file)) continue;
      const settings = object(fs.readFileSync(file, "utf8"));
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
  } else {
    // A bundled runtime can identify its enclosing plugin without a global CLI.
    if (fs.existsSync(path.join(own, "../plugin.json")))
      candidates.push(path.resolve(own, ".."));
    else {
      const cache = path.join(
        process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex"),
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
          if (selected) candidates.push(path.join(base, selected));
        }
      }
    }
  }
  const valid: { plugin_root: string; entry: string; version: string }[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const base = fs.realpathSync(candidate);
      const runtimeRoot =
        harness === "codex" ? path.join(base, "runtime") : base;
      const pkg = object(
        fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"),
      );
      if (pkg.name !== "@zht7063/mwf" || typeof pkg.version !== "string")
        throw Error("Invalid runtime package");
      if (harness === "codex") {
        const manifest = object(
          fs.readFileSync(path.join(base, "plugin.json"), "utf8"),
        );
        if (manifest.name !== "mwf" || manifest.version !== pkg.version)
          throw Error("Plugin/runtime version mismatch");
      } else if (
        !pkg.pi ||
        !fs.existsSync(path.join(runtimeRoot, "dist/integrations/pi/index.js"))
      )
        throw Error("Missing Pi extension");
      const entry = fs.realpathSync(path.join(runtimeRoot, "dist/cli.js"));
      if (!valid.some((v) => v.entry === entry))
        valid.push({ plugin_root: base, entry, version: pkg.version });
    } catch (error) {
      if (pluginRoot)
        throw new MWFError(
          "PLUGIN_RUNTIME_REQUIRED",
          `Invalid plugin runtime: ${String(error)}`,
        );
    }
  }
  if (valid.length !== 1)
    throw new MWFError(
      "PLUGIN_RUNTIME_REQUIRED",
      valid.length
        ? "Multiple installed runtimes; specify --plugin-root."
        : "Cannot locate an installed plugin runtime; specify --plugin-root.",
    );
  return valid[0];
}
function runtime(
  pluginRoot: string | undefined,
  harness: Harness,
  root: string,
) {
  const target = locateRuntime(pluginRoot, harness, root);
  if (target.version !== RUNTIME_VERSION)
    throw new MWFError(
      "RUNTIME_MISMATCH",
      "Execute the installed plugin runtime version.",
    );
  if (target.entry !== fs.realpathSync(cli))
    throw new MWFError(
      "PLUGIN_RUNTIME_REQUIRED",
      `Run ${target.entry} to bind the installed runtime.`,
    );
  return target.entry;
}
export function persistProbe(
  root: string,
  harness: Harness,
  generation: string,
  evidence: Record<string, unknown>,
) {
  return withProjectLock(root, () => {
    recover(root);
    const tx = new Transaction(root),
      r = receipt(tx);
    const client = r?.clients[harness];
    if (!r || !client?.enabled || client.binding_generation !== generation)
      throw new MWFError("BINDING_STALE", "Binding changed during probing.");
    client.probe = evidence;
    tx.set(receiptFile, JSON.stringify(r, null, 2) + "\n");
    return tx.commit();
  });
}
function legacy(tx: Transaction) {
  const c = config(tx);
  return (
    tx.get(".mwf/local/setup.json") !== null ||
    ["bootstrap_hash", "bootstrap_version", "hooks_required"].some(
      (k) => k in c,
    ) ||
    (tx.get("AGENTS.md") ?? "").includes("<!-- memory-with-files:start -->")
  );
}
function trackedWarning(root: string, harness: string) {
  if (harness !== "codex") return [];
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", ".codex/config.toml"], {
      cwd: root,
      stdio: "pipe",
    });
    return [
      ".codex/config.toml is tracked; absolute local runtime paths will be included. Git index was not changed.",
    ];
  } catch {
    return [];
  }
}
export function lifecycle(
  op: "attach" | "rebind" | "detach",
  input: unknown,
): Result {
  const a = inputSchema.parse(input),
    root = canonicalRoot(a.project_root),
    apply = a.apply && !a.dry_run;
  if (config(new Transaction(root)).schema_version !== 1)
    throw new MWFError("SCHEMA_UNSUPPORTED", "Migrate data before attaching.");
  if (op !== "detach" && a.harness === "all")
    throw new MWFError("INVALID_INPUT", "Attach one client at a time.");
  const plan = (tx: Transaction) => {
    let r = receipt(tx) ?? {
      receipt_version: 2 as const,
      canonical_root: root,
      clients: {},
    };
    const clients: Harness[] =
      a.harness === "all" ? ["pi", "codex"] : [a.harness];
    if (op === "detach") {
      for (const h of clients) {
        const c = r.clients[h];
        if (c) c.enabled = false;
      }
    } else {
      if (legacy(tx))
        throw new MWFError(
          "LEGACY_INTEGRATION_PRESENT",
          "Run migrate --from 0.1 after stopping old entrypoints.",
        );
      const h = a.harness as Harness,
        entry = runtime(a.plugin_root, h, root);
      if (h === "pi") {
        const conflicts = piConflicts(root);
        if (conflicts.length)
          throw new MWFError("OWNERSHIP_CONFLICT", conflicts.join("; "));
      }
      if (r.canonical_root !== root) {
        for (const c of Object.values(r.clients)) c.enabled = false;
        r.canonical_root = root;
      }
      const previous = r.clients[h];
      if (previous?.cleanup_pending)
        throw new MWFError(
          "OWNERSHIP_CONFLICT",
          "Complete pending detach cleanup before enabling.",
        );
      const same =
        previous?.enabled &&
        previous.runtime_path === entry &&
        previous.runtime_version === RUNTIME_VERSION &&
        previous.api_version === 2 &&
        previous.node_path === process.execPath;
      const generation = same ? previous.binding_generation! : randomUUID();
      const owned = previous?.owned_resources ?? [];
      if (h === "codex") {
        const file = ".codex/config.toml",
          created = tx.get(file) === null,
          old = tx.get(file) ?? "",
          parsed = TOML.parse(old),
          existing = block(old);
        const resource = owned.find((v) => v.kind === "block");
        if (
          existing &&
          (!resource ||
            resource.kind !== "block" ||
            resource.installed !== existing)
        )
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
        const text = `${start}\n[mcp_servers.mwf]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([entry, "mcp", "--root", root, "--harness", "codex", "--binding-generation", generation, "--profile", "agent"])}\n${end}`;
        const merged = existing
          ? old.replace(existing, text)
          : old + (old.endsWith("\n") || !old ? "" : "\n") + text + "\n";
        TOML.parse(merged);
        tx.set(file, merged);
        r.clients[h] = {
          enabled: true,
          binding_generation: generation,
          runtime_version: RUNTIME_VERSION,
          api_version: 2,
          runtime_path: entry,
          node_path: process.execPath,
          owned_resources: [
            {
              kind: "block",
              path: file,
              installed: text,
              created: resource?.kind === "block" ? resource.created : created,
            },
          ],
          cleanup_pending: false,
        };
      } else
        r.clients[h] = {
          enabled: true,
          binding_generation: generation,
          runtime_version: RUNTIME_VERSION,
          api_version: 2,
          runtime_path: entry,
          node_path: process.execPath,
          owned_resources: [],
          cleanup_pending: false,
        };
    }
    tx.set(receiptFile, JSON.stringify(r, null, 2) + "\n");
    return { r, clients };
  };
  if (!apply) {
    const tx = new Transaction(root);
    plan(tx);
    return output(op, root, {
      preview: true,
      would_change: tx.changes().map((c) => c.path),
    });
  }
  return withProjectLock(root, () => {
    recover(root);
    let tx = new Transaction(root);
    const { r, clients } = plan(tx);
    let changed = tx.commit();
    const conflicts: string[] = [];
    if (op === "detach") {
      tx = new Transaction(root);
      for (const h of clients) {
        const c = r.clients[h];
        if (!c) continue;
        const remaining: typeof c.owned_resources = [];
        for (const resource of c.owned_resources) {
          try {
            const raw = tx.get(resource.path);
            if (resource.kind === "block") {
              if (raw === null) continue;
              const current = block(raw);
              if (current === null) continue;
              if (current !== resource.installed)
                throw new Error("owned block changed");
              const next = raw.replace(current + "\n", "").replace(current, "");
              TOML.parse(next);
              tx.set(
                resource.path,
                resource.created && !next.trim() ? null : next,
              );
            } else if (resource.kind === "file") {
              if (raw === null) continue;
              if (hash(raw) !== resource.installed_hash)
                throw new Error("owned file changed");
              tx.set(resource.path, resource.before);
            } else {
              const obj = object(raw),
                servers = z.record(z.unknown()).parse(obj.mcpServers ?? {});
              if (!("mwf" in servers)) continue;
              if (
                JSON.stringify(servers.mwf) !==
                JSON.stringify(resource.installed)
              )
                throw new Error("owned key changed");
              if (resource.before === null) delete servers.mwf;
              else servers.mwf = resource.before;
              obj.mcpServers = servers;
              tx.set(resource.path, JSON.stringify(obj, null, 2) + "\n");
            }
          } catch {
            remaining.push(resource);
            conflicts.push(resource.path);
          }
        }
        c.owned_resources = remaining;
        c.cleanup_pending = remaining.length > 0;
      }
      tx.set(receiptFile, JSON.stringify(r, null, 2) + "\n");
      changed.push(...tx.commit());
    }
    return output(
      op,
      root,
      {
        state:
          op === "detach"
            ? conflicts.length
              ? "disabled_cleanup_pending"
              : "disabled_clean"
            : "configured",
        conflicts,
        probed: { direct: "not_run", mcp: "not_run" },
        session_observed: "unknown",
      },
      [...new Set(changed)],
      !conflicts.length,
      op === "detach"
        ? []
        : [
            "Reload the host and verify its real MCP connection.",
            ...trackedWarning(root, a.harness),
          ],
    );
  });
}
export async function setup(input: unknown): Promise<Result> {
  const a = z
    .object({
      project_root: z.string(),
      git_mode: z.enum(["track", "ignore"]).optional(),
      harness: z
        .array(z.enum(["pi", "codex"]))
        .min(1)
        .default(["codex"]),
      plugin_root: z.string().optional(),
      dry_run: z.boolean().default(false),
      apply: z.boolean().default(false),
    })
    .strict()
    .parse(input);
  const root = canonicalRoot(a.project_root),
    tx = new Transaction(root);
  if (!tx.get(".mwf/config.json")) {
    if (!a.git_mode)
      throw new MWFError("INVALID_INPUT", "First setup requires git_mode.");
    if (a.dry_run || !a.apply) {
      initialize(tx, a.git_mode, "auto");
      return output(
        "setup",
        root,
        {
          preview: true,
          would_change: tx.changes().map((c) => c.path),
          next: "attach",
        },
        [],
        true,
        ["setup is deprecated; use init then attach."],
      );
    }
    execute("init", { project_root: root, git_mode: a.git_mode });
  }
  const results = a.harness.map((h) =>
    lifecycle("attach", {
      project_root: root,
      harness: h,
      plugin_root: a.plugin_root,
      apply: a.apply,
      dry_run: a.dry_run,
    }),
  );
  return output(
    "setup",
    root,
    { clients: results },
    results.flatMap((r) => r.changed_files),
    results.every((r) => r.ok),
    ["setup is deprecated; use init then attach."],
  );
}
export function detach(
  root: string,
  apply = false,
  harness: "pi" | "codex" | "all" = "all",
) {
  return lifecycle("detach", { project_root: root, apply, harness });
}
