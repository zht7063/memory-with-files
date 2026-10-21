import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  config,
  initialize,
  execute,
  legacyInstall,
  LEGACY_INSTALL_REMEDY,
  type Result,
} from "../core/index.js";
import {
  canonicalRoot,
  MWFError,
  recover,
  Transaction,
  withProjectLock,
} from "../storage/index.js";
import { RUNTIME_VERSION } from "../contracts/version.js";
import {
  receipt,
  receiptFile,
  resourceSchema,
  RECEIPT_VERSION,
  upgradeReceipt,
  type Harness,
} from "../storage/receipt.js";
import { piConflicts } from "../integrations/pi/conflicts.js";
import {
  adapterFor,
  adapterForSurface,
  harnessContext as context,
  toOwned,
} from "../integrations/registry.js";
import { HARNESS_IDS } from "../contracts/harness.js";
import { MANAGED_SURFACES } from "../contracts/managed-surface.js";
export { piConflicts };
const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
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
const harnessContext = (root: string, tx: Transaction) =>
  context(root, (file) => tx.get(file));
export function locateRuntime(
  pluginRoot: string | undefined,
  harness: Harness,
  root: string,
) {
  const found = adapterFor(harness).detect(
    harnessContext(root, new Transaction(root)),
    pluginRoot ? { pluginRoot } : {},
  );
  return {
    plugin_root: found.pluginRoot,
    entry: found.runtimePath,
    version: found.version,
  };
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
function attachWarnings(root: string, harness: string) {
  const adapter =
    harness === "all" ? undefined : adapterFor(harness as Harness);
  return (
    adapter?.attachWarnings?.(harnessContext(root, new Transaction(root))) ?? []
  );
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
      receipt_version: RECEIPT_VERSION,
      canonical_root: root,
      clients: {},
    };
    const clients: Harness[] =
      a.harness === "all" ? [...HARNESS_IDS] : [a.harness];
    if (op === "detach") {
      for (const h of clients) {
        const c = r.clients[h];
        if (c) c.enabled = false;
      }
    } else {
      if (legacyInstall(tx))
        throw new MWFError("UNSUPPORTED_LEGACY_INSTALL", LEGACY_INSTALL_REMEDY);
      const h = a.harness as Harness,
        entry = runtime(a.plugin_root, h, root);
      const adapter = adapterFor(h);
      const conflicts = adapter.conflicts(harnessContext(root, tx));
      if (conflicts.length)
        throw new MWFError(
          "OWNERSHIP_CONFLICT",
          conflicts.map((c) => `${c.path}: ${c.reason}`).join("; "),
        );
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
      {
        const changes = adapter.planAttach(
          harnessContext(root, tx),
          { pluginRoot: "", runtimePath: entry, version: RUNTIME_VERSION },
          {
            generation,
            owned: owned.flatMap((v) => {
              try {
                return [toOwned(v)];
              } catch {
                return [];
              }
            }),
          },
        );
        for (const change of changes)
          tx.set(MANAGED_SURFACES[change.surface].path, change.after);
        r.clients[h] = {
          enabled: true,
          binding_generation: generation,
          runtime_version: RUNTIME_VERSION,
          api_version: 2,
          runtime_path: entry,
          node_path: process.execPath,
          owned_resources: changes.flatMap((c) => {
            if (!c.resource) return [];
            const { surface, ...rest } = c.resource;
            return [
              {
                ...rest,
                path: MANAGED_SURFACES[surface].path,
              } as z.infer<typeof resourceSchema>,
            ];
          }),
          cleanup_pending: false,
        };
      }
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
    // v2→v3 receipt upgrade is its own atomic single-file commit; it fails
    // closed (LEGACY_RESOURCE_PENDING) before anything is written.
    let changed: string[] = upgradeReceipt(root) ? [receiptFile] : [];
    let tx = new Transaction(root);
    const previousReceipt = receipt(tx);
    if (
      op !== "detach" &&
      previousReceipt &&
      previousReceipt.canonical_root !== root
    ) {
      // Revoke every copied/moved binding durably before attempting one rebind.
      // Keep the old root until the requested client's configuration succeeds.
      for (const client of Object.values(previousReceipt.clients))
        client.enabled = false;
      tx.set(receiptFile, JSON.stringify(previousReceipt, null, 2) + "\n");
      changed.push(...tx.commit());
      tx = new Transaction(root);
    }
    const { r, clients } = plan(tx);
    changed.push(...tx.commit());
    const conflicts: string[] = [];
    if (op === "detach") {
      tx = new Transaction(root);
      for (const h of clients) {
        const c = r.clients[h];
        if (!c) continue;
        const remaining: typeof c.owned_resources = [];
        for (const resource of c.owned_resources) {
          try {
            const owned = toOwned(resource);
            const adapter = adapterForSurface(owned.surface);
            if (!adapter) throw new Error("no adapter owns this resource");
            for (const change of adapter.planDetach(harnessContext(root, tx), [
              owned,
            ]))
              tx.set(MANAGED_SURFACES[change.surface].path, change.after);
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
            ...attachWarnings(root, a.harness),
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

export function probePersistenceWarning(error: unknown): string {
  if (!(error instanceof MWFError) || error.code !== "BINDING_STALE")
    throw error;
  return `Probe evidence could not be persisted: ${error.code}: ${error.message}; reload and verify the host.`;
}
