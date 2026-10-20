import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { Transaction, hash } from "../storage/index.js";
import { receipt } from "../storage/receipt.js";
import { RUNTIME_VERSION } from "../contracts/version.js";

export function integrationDiagnostics(tx: Transaction) {
  const installed: Record<string, unknown> = {};
  const configured: Record<string, unknown> = {};
  const probed: Record<string, unknown> = {};
  const errors: string[] = [];
  try {
    const r = receipt(tx);
    for (const [client, c] of Object.entries(r?.clients ?? {})) {
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
        exists &&
        version === c.runtime_version &&
        version === RUNTIME_VERSION &&
        c.api_version === 2;
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
      if (client === "codex" && c.enabled && !c.owned_resources.length)
        issues.push("OWNERSHIP_MISSING");
      for (const resource of c.owned_resources) {
        try {
          const raw = tx.get(resource.path);
          const matches =
            resource.kind === "file"
              ? hash(raw) === resource.installed_hash
              : resource.kind === "block"
                ? raw !== null &&
                  raw.split("# mwf:mcp:start").length === 2 &&
                  raw.includes(resource.installed) &&
                  !!TOML.parse(raw)
                : raw !== null &&
                  JSON.stringify(JSON.parse(raw).mcpServers?.mwf) ===
                    JSON.stringify(resource.installed);
          if (!matches) issues.push(`OWNERSHIP_CONFLICT:${resource.path}`);
        } catch {
          issues.push(`OWNERSHIP_CONFLICT:${resource.path}`);
        }
      }
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
  } catch {
    errors.push("INVALID_INTEGRATION_RECEIPT");
  }
  return { installed, configured, probed, errors };
}
