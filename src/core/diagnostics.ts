import fs from "node:fs";
import path from "node:path";
import { MWFError, Transaction, safePath } from "../storage/index.js";
import { receipt, receiptFile } from "../storage/receipt.js";
import { hostLoad } from "../contracts/host-confirmation.js";

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
/** How long a fresh attach may stay unconfirmed before status/doctor hint that
 * the host may not have loaded (or trusted) the integration. */
export const HOST_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;
export const HOST_UNCONFIRMED_HINT = "可能未加载或未信任";
/** When the current attach began, for the pending timeout: the attach probe's
 * time, else the receipt file's mtime (so a missing or unwritten probe does not
 * disable the hint). Anchors in the future (clock set back after writing) are
 * ignored; the earliest valid anchor wins. Null when none is usable. */
function pendingSince(tx: Transaction, probeTime: unknown, now: number) {
  const anchors: number[] = [];
  if (typeof probeTime === "string") anchors.push(Date.parse(probeTime));
  try {
    anchors.push(fs.statSync(safePath(tx.root, receiptFile)).mtimeMs);
  } catch {
    /* No receipt file: nothing to anchor on. */
  }
  const valid = anchors.filter((t) => Number.isFinite(t) && t <= now);
  return valid.length ? Math.min(...valid) : null;
}
export function integrationDiagnostics(
  tx: Transaction,
  hostIssues?: HostIssues,
  options: {
    conflicts: boolean;
    now?: number;
    hostConfirmTimeoutMs?: number;
  } = { conflicts: false },
) {
  const installed: Record<string, unknown> = {};
  const configured: Record<string, unknown> = {};
  const probed: Record<string, unknown> = {};
  const errors: string[] = [];
  const hints: string[] = [];
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
      // host_* keys are written by the first hook / extension / MCP call, not by
      // attach's probe, so they are neither evidence nor a reason to call it stale.
      const evidence = Object.fromEntries(
        Object.entries(p ?? {}).filter(([k]) => !k.startsWith("host_")),
      );
      probed[client] = valid
        ? { ...evidence, current: runtimeValid && c.enabled && !issues.length }
        : {
            direct: "unknown",
            mcp: "unknown",
            reason: Object.keys(evidence).length
              ? "stale_or_invalid_evidence"
              : "not_run",
          };
      // Host load: confirmed once the channel that proves the host loaded and
      // trusted the integration has fired (Codex: a hook; Pi: the extension) for
      // the current binding; otherwise pending, then hinted after the timeout.
      // Stale records (older generation/runtime) never count.
      const load = hostLoad(client, c);
      const now = options.now ?? Date.now();
      const since = pendingSince(tx, p?.time, now);
      const timedOut =
        !load.confirmed &&
        since !== null &&
        now - since >=
          (options.hostConfirmTimeoutMs ?? HOST_CONFIRM_TIMEOUT_MS);
      const hostLoadState: Record<string, unknown> = load.confirmed
        ? {
            state: "confirmed",
            required: load.required,
            channels: load.channels,
            confirmed_at: load.record!.time,
            host_version: load.host_version,
            host_name: load.host_name,
            trigger: load.record!.trigger,
          }
        : {
            state: "pending",
            required: load.required,
            channels: load.channels,
            since: since === null ? null : new Date(since).toISOString(),
            ...(timedOut
              ? {
                  hint: HOST_UNCONFIRMED_HINT,
                  detail: `${load.required} 未触发${
                    load.channels.mcp === "confirmed" ? "（MCP 已连接）" : ""
                  }`,
                }
              : {}),
          };
      if (timedOut) hints.push(`${client}: ${HOST_UNCONFIRMED_HINT}`);
      probed[client] = {
        ...(probed[client] as Record<string, unknown>),
        host_confirmed: load.confirmed ? "confirmed" : "unknown",
        host_load: hostLoadState,
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
  return { installed, configured, probed, errors, hints };
}
