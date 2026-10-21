import fs from "node:fs";
import { hash, MWFError, Transaction } from "../storage/index.js";
import { AGENTS_START, AGENTS_END } from "../contracts/records.js";
import { receiptFile, receipt } from "../storage/receipt.js";
import TOML from "@iarna/toml";
import { validRecords } from "../storage/records.js";
export function migrateIntegration(
  tx: Transaction,
  c: Record<string, unknown>,
  stopped: boolean,
  apply: boolean,
) {
  const agents = tx.get("AGENTS.md") ?? "",
    old = tx.get(".mwf/local/setup.json");
  const needed =
    !!old ||
    ["bootstrap_hash", "bootstrap_version", "hooks_required"].some(
      (k) => k in c,
    ) ||
    agents.includes(AGENTS_START) ||
    agents.includes(AGENTS_END) ||
    c.runtime_owner !== "mwf-typescript";
  if (!needed) return { migration_required: false };
  // Read authoritative legacy files independently, before staging any cleanup.
  // Never let rebuilding the index hide an unreadable record during adoption.
  const legacyRecords = validRecords(new Transaction(tx.root), true);
  const starts = agents.split(AGENTS_START).length - 1,
    ends = agents.split(AGENTS_END).length - 1;
  if (
    starts !== ends ||
    starts > 1 ||
    (starts && agents.indexOf(AGENTS_START) > agents.indexOf(AGENTS_END))
  )
    throw new MWFError(
      "OWNERSHIP_CONFLICT",
      "Malformed legacy AGENTS markers.",
    );
  if (starts) {
    const block = agents.slice(
      agents.indexOf(AGENTS_START),
      agents.indexOf(AGENTS_END) + AGENTS_END.length,
    );
    const known = fs
      .readFileSync(
        new URL("../../assets/mwf-template/agents-block.md", import.meta.url),
        "utf8",
      )
      .trim();
    const fixture = fs
      .readFileSync(
        new URL("../../assets/memory/legacy-agents-block.md", import.meta.url),
        "utf8",
      )
      .trim();
    if (
      c.bootstrap_hash
        ? hash(block) !== c.bootstrap_hash
        : ![known, fixture].includes(block)
    )
      throw new MWFError(
        "OWNERSHIP_CONFLICT",
        "Legacy AGENTS block ownership cannot be proven.",
      );
    tx.set("AGENTS.md", agents.replace(block, ""));
  }
  if (old) {
    const value = JSON.parse(old);
    if (value.version !== 1 || !value.files || typeof value.files !== "object")
      throw new MWFError("OWNERSHIP_CONFLICT", "Unknown legacy setup receipt.");
    for (const [file, entry] of Object.entries(value.files) as [
      string,
      { before: string | null; after_hash: string },
    ][]) {
      if (file === "AGENTS.md" || file === ".gitignore") continue;
      const raw = tx.get(file);
      if (raw === null) continue;
      if (file === ".codex/config.toml") {
        const start = "# mwf:mcp:start",
          end = "# mwf:mcp:end";
        if (raw.split(start).length !== 2 || raw.split(end).length !== 2)
          throw new MWFError(
            "OWNERSHIP_CONFLICT",
            "Legacy TOML markers are ambiguous.",
          );
        const block = raw.slice(
          raw.indexOf(start),
          raw.indexOf(end) + end.length,
        );
        // The v1 receipt only proves the entire installed value; edits require manual reconciliation.
        if (hash(raw) !== entry.after_hash)
          throw new MWFError(
            "OWNERSHIP_CONFLICT",
            "Legacy Codex config changed; reconcile before migration.",
          );
        const next = raw.replace(block, "");
        TOML.parse(next);
        tx.set(file, next);
      } else if (file === ".pi/mcp.json") {
        if (hash(raw) !== entry.after_hash)
          throw new MWFError("OWNERSHIP_CONFLICT", "Legacy Pi config changed.");
        const current = JSON.parse(raw),
          before = JSON.parse(entry.before ?? "{}");
        if (before.mcpServers?.mwf !== undefined)
          current.mcpServers.mwf = before.mcpServers.mwf;
        else if (current.mcpServers) delete current.mcpServers.mwf;
        tx.set(file, JSON.stringify(current, null, 2) + "\n");
      } else if (
        file === ".pi/extensions/mwf.js" ||
        /^\.agents\/skills\/(memory-with-files|mwf-init|mwf-status)\/SKILL\.md$/.test(
          file,
        )
      ) {
        if (hash(raw) !== entry.after_hash)
          throw new MWFError(
            "OWNERSHIP_CONFLICT",
            `Legacy owned resource changed: ${file}`,
          );
        tx.set(file, entry.before);
      } else
        throw new MWFError(
          "OWNERSHIP_CONFLICT",
          `Unrecognized legacy resource: ${file}`,
        );
    }
    tx.set(".mwf/local/setup.json", null);
  }
  if (apply && !stopped)
    throw new MWFError(
      "LEGACY_INTEGRATION_PRESENT",
      "Stop old sessions and pass --legacy-stopped before applying migration.",
    );
  const next = { ...c, runtime_owner: "mwf-typescript" } as Record<
    string,
    unknown
  >;
  for (const k of ["bootstrap_hash", "bootstrap_version", "hooks_required"])
    delete next[k];
  tx.set(".mwf/config.json", JSON.stringify(next, null, 2) + "\n");
  const r = receipt(tx) ?? {
    receipt_version: 2 as const,
    canonical_root: tx.root,
    clients: {},
  };
  for (const client of Object.values(r.clients)) client.enabled = false;
  tx.set(receiptFile, JSON.stringify(r, null, 2) + "\n");
  return {
    migration_required: true,
    legacy_stopped: stopped,
    clients_enabled: false,
    legacy_read: {
      source: "independent_markdown_read",
      record_count: legacyRecords.length,
    },
  };
}
