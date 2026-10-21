import fs from "node:fs";
import path from "node:path";
import { MWFError, Transaction } from "../storage/index.js";
import { receipt } from "../storage/receipt.js";

/** Host-specific checks (ownership of managed surfaces, host conflicts),
 * injected by the entry layer from the integrations registry so Core never
 * imports integrations. Without it, only host-neutral checks run. */
export type HostIssues = (
  client: string,
  root: string,
  get: (file: string) => string | null,
  receiptClient: {
    enabled: boolean;
    cleanup_pending: boolean;
    owned_resources: readonly { kind: string; path: string }[];
  },
  options: { conflicts: boolean },
) => string[];
export function integrationDiagnostics(
  tx: Transaction,
  hostIssues?: HostIssues,
  options: { conflicts: boolean } = { conflicts: false },
) {
  const installed: Record<string, unknown> = {};
  const configured: Record<string, unknown> = {};
  const probed: Record<string, unknown> = {};
  const errors: string[] = [];
  try {
    const r = receipt(tx);
    for (const [client, c] of Object.entries(r?.clients ?? {})) {
      if (!c.enabled) {
        const issues = c.cleanup_pending ? ["CLEANUP_PENDING"] : [];
        installed[client] = { enabled: false };
        configured[client] = { enabled: false, valid: !issues.length, issues };
        probed[client] = { direct: "disabled", mcp: "disabled" };
        continue;
      }
      let version: string | null = null;
      let exists = false;
      try {
        exists = !!c.runtime_path && fs.statSync(c.runtime_path).isFile();
        if (exists) {
          const pkg = JSON.parse(
            fs.readFileSync(
              path.resolve(path.dirname(c.runtime_path!), "../package.json"),
              "utf8",
            ),
          );
          if (pkg.name === "@zht7063/mwf") version = pkg.version;
        }
      } catch {
        /* Missing or invalid runtime is reported below. */
      }
      const runtimeValid =
        exists && version === c.runtime_version && c.api_version === 2;
      installed[client] = {
        runtime_path: c.runtime_path ?? null,
        runtime_version: version,
        exists,
        valid: runtimeValid,
      };
      const issues: string[] = [];
      if (r!.canonical_root !== tx.root) issues.push("ROOT_MISMATCH");
      if (!c.binding_generation || !c.runtime_path || !c.node_path)
        issues.push("INVALID_BINDING");
      if (!runtimeValid) issues.push("RUNTIME_MISMATCH");
      if (c.cleanup_pending) issues.push("CLEANUP_PENDING");
      if (hostIssues)
        issues.push(
          ...hostIssues(client, tx.root, (f) => tx.get(f), c, options),
        );
      configured[client] = {
        enabled: c.enabled,
        canonical_root: r!.canonical_root,
        binding_generation: c.binding_generation ?? null,
        valid: !issues.length,
        issues,
      };
      const p = c.probe;
      const valid =
        !!p &&
        p.root === tx.root &&
        p.runtime_path === c.runtime_path &&
        p.runtime_version === version &&
        p.api_version === c.api_version &&
        p.binding_generation === c.binding_generation &&
        typeof p.time === "string" &&
        Number.isFinite(Date.parse(p.time)) &&
        typeof p.source === "string";
      probed[client] = valid
        ? { ...p, current: runtimeValid && c.enabled && !issues.length }
        : {
            direct: "unknown",
            mcp: "unknown",
            reason: p ? "stale_or_invalid_evidence" : "not_run",
          };
      if (c.enabled)
        errors.push(...issues.map((issue) => `${client}: ${issue}`));
    }
  } catch (e) {
    errors.push(
      e instanceof MWFError && e.code === "LEGACY_RESOURCE_PENDING"
        ? "LEGACY_RESOURCE_PENDING"
        : "INVALID_INTEGRATION_RECEIPT",
    );
  }
  return { installed, configured, probed, errors };
}
