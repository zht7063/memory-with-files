import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RULE_ITEMS,
  UNVERIFIED,
  checkEvidence,
  decide,
} from "../scripts/lib/release-decision.ts";

const COMMIT = "a".repeat(40);
const passing = (harness: string) => ({
  schema: "mwf-linux-harness-evidence/1",
  harness,
  status: "pass",
  platform: "linux",
  commit: COMMIT,
  dirty: false,
  tool_count: 8,
  tool_calls: [{ tool: "mwf_status", ok: true }],
});

function repo(evidence: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-decision-"));
  for (const { item, file } of RULE_ITEMS)
    if (item in evidence) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      const value = evidence[item];
      fs.writeFileSync(
        path.join(root, file),
        typeof value === "string" ? value : JSON.stringify(value),
      );
    }
  return root;
}

test("every rule item maps to its own evidence file", () => {
  assert.deepEqual(
    RULE_ITEMS.map((i) => i.item),
    ["codex_cli", "pi_cli"],
  );
  assert.equal(new Set(RULE_ITEMS.map((i) => i.file)).size, RULE_ITEMS.length);
});

test("all Linux CLI harnesses pass for this commit => publishable true", (t) => {
  const root = repo({
    codex_cli: passing("codex_cli"),
    pi_cli: passing("pi_cli"),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const d = decide(root, COMMIT);
  assert.equal(d.publishable, true);
  assert.deepEqual(
    d.items.map((i) => [i.item, i.status, i.evidence]),
    RULE_ITEMS.map((i) => [i.item, "pass", i.file]),
  );
  assert.deepEqual(d.unverified, [...UNVERIFIED]);
});

test("missing evidence for any harness => not_run and publishable false", (t) => {
  for (const present of [
    {},
    { codex_cli: passing("codex_cli") },
    { pi_cli: passing("pi_cli") },
  ]) {
    const root = repo(present);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const d = decide(root, COMMIT);
    assert.equal(d.publishable, false);
    assert.ok(d.items.some((i) => i.status === "not_run"));
  }
});

test("any failing, stale, dirty, wrong-platform or wrong-tool-count evidence => false", (t) => {
  const bad: Record<string, unknown>[] = [
    { status: "fail" },
    { status: "partial" },
    { commit: "b".repeat(40) },
    { dirty: true },
    { platform: "darwin" },
    { tool_count: 7 },
    { tool_calls: [] },
    { tool_calls: [{ tool: "mwf_add", ok: false }] },
    { harness: "pi_cli" },
  ];
  for (const patch of bad) {
    const root = repo({
      codex_cli: { ...passing("codex_cli"), ...patch },
      pi_cli: passing("pi_cli"),
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const d = decide(root, COMMIT);
    assert.equal(d.publishable, false, JSON.stringify(patch));
    assert.equal(d.items[0].status, "fail", JSON.stringify(patch));
    assert.ok(d.items[0].reasons.length > 0);
  }
});

test("unreadable evidence fails closed", (t) => {
  const root = repo({ codex_cli: "{not json", pi_cli: passing("pi_cli") });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(decide(root, COMMIT).publishable, false);
  assert.equal(checkEvidence("pi_cli", undefined, COMMIT).status, "not_run");
});
