// Release decision rule (0.3.0+): the release is publishable iff every Linux
// command-line harness passed against the exact commit being packed. Each rule
// item maps to one evidence file; missing, unreadable, stale or failing
// evidence makes the release not publishable. Nothing here is hard-coded true.
import fs from "node:fs";
import path from "node:path";

export const CRITERIA = "linux-cli-harness/1";
export const EXPECTED_TOOL_COUNT = 8;

/** Rule item → evidence file (relative to the repo root). */
export const RULE_ITEMS = [
  { item: "codex_cli", file: "releases/evidence/codex-cli.json" },
  { item: "pi_cli", file: "releases/evidence/pi-cli.json" },
] as const;

/** Not verified under this criteria; listed in every RELEASE-STATUS. */
export const UNVERIFIED = [
  "Codex desktop GUI workflow",
  "macOS hosts",
  "performance report",
  "real (billed) model hosts / real-environment 44-item evidence",
] as const;

export type ItemResult = {
  item: string;
  evidence: string;
  status: "pass" | "fail" | "not_run";
  reasons: string[];
};

export function checkEvidence(
  item: string,
  evidence: unknown,
  commit: string,
): Omit<ItemResult, "evidence"> {
  if (evidence === undefined)
    return { item, status: "not_run", reasons: ["evidence file missing"] };
  const e = evidence as Record<string, unknown>;
  const reasons: string[] = [];
  if (e === null || typeof e !== "object")
    reasons.push("evidence not an object");
  else {
    if (e.harness !== item) reasons.push(`harness is ${String(e.harness)}`);
    if (e.status !== "pass") reasons.push(`status is ${String(e.status)}`);
    if (e.platform !== "linux")
      reasons.push(`platform is ${String(e.platform)}`);
    if (e.commit !== commit)
      reasons.push(`commit ${String(e.commit)} != ${commit}`);
    if (e.dirty !== false) reasons.push("working tree was dirty or unknown");
    if (e.tool_count !== EXPECTED_TOOL_COUNT)
      reasons.push(
        `tool_count ${String(e.tool_count)} != ${EXPECTED_TOOL_COUNT}`,
      );
    const calls = e.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0)
      reasons.push("no real tool calls recorded");
    else if (!calls.every((c) => c && (c as { ok?: unknown }).ok === true))
      reasons.push("a tool call failed");
  }
  return { item, status: reasons.length ? "fail" : "pass", reasons };
}

export function readEvidence(root: string, file: string): unknown {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch {
    return { status: "unreadable" };
  }
}

/**
 * `packDirty` is `git status --porcelain` at pack time (gitignored paths such as
 * releases/ are already excluded by git). Evidence for HEAD says nothing about
 * uncommitted edits, so any entry makes the release not publishable.
 */
export function decide(root: string, commit: string, packDirty: string[]) {
  const items: ItemResult[] = RULE_ITEMS.map(({ item, file }) => ({
    evidence: file,
    ...checkEvidence(item, readEvidence(root, file), commit),
  }));
  const tree = {
    clean: packDirty.length === 0,
    changes: packDirty,
    reason:
      packDirty.length === 0
        ? null
        : `working tree has ${packDirty.length} uncommitted change(s) at pack time; evidence for ${commit} does not cover them`,
  };
  return {
    criteria: CRITERIA,
    commit,
    publishable:
      tree.clean && items.length > 0 && items.every((i) => i.status === "pass"),
    working_tree: tree,
    items,
    unverified: [...UNVERIFIED],
  };
}
