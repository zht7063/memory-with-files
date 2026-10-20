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
function runtime(
  pluginRoot: string | undefined,
  harness: Harness,
  root: string,
) {
  const base = fs.realpathSync(
    pluginRoot ?? fileURLToPath(new URL("../../", import.meta.url)),
  );
  if (harness === "pi" && !pluginRoot) {
    const bases = [
      path.join(root, ".pi"),
      process.env.PI_CODING_AGENT_DIR ??
        path.join(process.env.HOME ?? "", ".pi/agent"),
    ];
    const installed = bases.some((dir) => {
      const file = path.join(dir, "settings.json");
      if (!fs.existsSync(file)) return false;
      const settings = object(fs.readFileSync(file, "utf8"));
      return (
        Array.isArray(settings.packages) &&
        settings.packages.some((value) => {
          const source = typeof value === "string" ? value : value?.source;
          if (typeof source !== "string") return false;
          const candidate = source.startsWith("npm:@zht7063/mwf")
            ? path.join(dir, "npm/node_modules/@zht7063/mwf")
            : path.resolve(dir, source);
          try {
            return fs.realpathSync(candidate) === base;
          } catch {
            return false;
          }
        })
      );
    });
    if (!installed)
      throw new MWFError(
        "PLUGIN_RUNTIME_REQUIRED",
        "Use the Pi-installed package runtime, or explicitly pass its --plugin-root.",
      );
  }
  let runtimeRoot = base;
  if (harness === "codex") {
    const manifest = path.join(base, "plugin.json");
    if (!fs.existsSync(manifest))
      throw new MWFError(
        "PLUGIN_RUNTIME_REQUIRED",
        "Pass --plugin-root for the installed Codex plugin.",
      );
    const m = object(fs.readFileSync(manifest, "utf8"));
    if (m.name !== "mwf" || m.version !== RUNTIME_VERSION)
      throw new MWFError(
        "RUNTIME_MISMATCH",
        "Plugin version differs; execute its own runtime.",
      );
    runtimeRoot = path.join(base, "runtime");
  }
  const pkg = object(
    fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"),
  );
  if (pkg.name !== "@zht7063/mwf" || pkg.version !== RUNTIME_VERSION)
    throw new MWFError(
      "RUNTIME_MISMATCH",
      "Execute the installed plugin runtime version.",
    );
  if (
    harness === "pi" &&
    (!pkg.pi ||
      !fs.existsSync(path.join(runtimeRoot, "dist/integrations/pi/index.js")))
  )
    throw new MWFError(
      "PLUGIN_RUNTIME_REQUIRED",
      "Pi package extension is missing.",
    );
  const entry = fs.realpathSync(path.join(runtimeRoot, "dist/cli.js"));
  if (entry !== fs.realpathSync(cli))
    throw new MWFError(
      "PLUGIN_RUNTIME_REQUIRED",
      `Run ${entry} to bind the installed runtime.`,
    );
  return entry;
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
