// PR-05: closed managed-surface whitelist (plan §3 test 4) and path
// canonicalization before the whitelist match.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as surface from "../dist/contracts/managed-surface.js";
import { recover } from "../dist/storage/index.js";

const {
  MANAGED_SURFACES,
  MANAGED_PATHS,
  SURFACE_IDS,
  TEMP_SCAN_DIRS,
  isMwfOwned,
} = surface;

test("test 4: MANAGED_SURFACES and every entry are frozen; no extension API", () => {
  assert.ok(Object.isFrozen(MANAGED_SURFACES));
  for (const id of SURFACE_IDS)
    assert.ok(Object.isFrozen(MANAGED_SURFACES[id]));
  assert.ok(Object.isFrozen(MANAGED_PATHS));
  assert.ok(Object.isFrozen(SURFACE_IDS));
  assert.ok(Object.isFrozen(TEMP_SCAN_DIRS));
  assert.throws(() => {
    (MANAGED_SURFACES as Record<string, unknown>)["evil"] = {
      path: "src/index.ts",
      kind: "file",
    };
  }, TypeError);
  assert.throws(() => {
    (MANAGED_SURFACES["agents.block"] as { path: string }).path = "src/x.ts";
  }, TypeError);
  assert.deepEqual(Object.keys(surface).sort(), [
    "JOURNAL_PATH",
    "MANAGED_PATHS",
    "MANAGED_SURFACES",
    "MWF_DIR",
    "SURFACE_IDS",
    "TEMP_SCAN_DIRS",
    "isMwfOwned",
    "surfaceOf",
  ]);
});

test("whitelist equals the 0.2 managed surface (0.1 Pi paths kept until PR-08)", () => {
  assert.deepEqual([...MANAGED_PATHS].sort(), [
    ".agents/skills/memory-with-files/SKILL.md",
    ".agents/skills/mwf-init/SKILL.md",
    ".agents/skills/mwf-status/SKILL.md",
    ".codex/config.toml",
    ".gitignore",
    ".pi/extensions/mwf.js",
    ".pi/mcp.json",
    "AGENTS.md",
  ]);
  assert.deepEqual([...TEMP_SCAN_DIRS].sort(), [
    "",
    ".agents/skills/memory-with-files",
    ".agents/skills/mwf-init",
    ".agents/skills/mwf-status",
    ".codex",
    ".pi",
    ".pi/extensions",
  ]);
  assert.equal(isMwfOwned(".mwf/memory/x.md"), true);
  assert.equal(isMwfOwned(".mwf/runtime.sqlite"), false);
  assert.equal(isMwfOwned(".mwf/local/transaction.json"), false);
});

test("non-canonical journal paths are rejected before the whitelist match", (t) => {
  for (const p of [
    "./AGENTS.md",
    ".codex//config.toml",
    ".codex/./config.toml",
    ".codex/config.toml/",
    ".codex\\config.toml",
    "agents.md",
    ".Codex/config.toml",
    ".mwf/../AGENTS.md",
    ".mwf/../../x",
    ".mwf/./memory/x.md",
    "/abs/AGENTS.md",
    "C:\\x",
    "",
  ]) {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "mwf-ms-")),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, ".mwf/local"), { recursive: true });
    const journal = path.join(root, ".mwf/local/transaction.json");
    const body = JSON.stringify({
      version: 1,
      changes: [{ path: p, before: null, after: "x" }],
    });
    fs.writeFileSync(journal, body);
    assert.throws(
      () => recover(root),
      (e: { code?: string }) => e.code === "INVALID_JOURNAL",
      JSON.stringify(p),
    );
    assert.equal(fs.readFileSync(journal, "utf8"), body, "journal retained");
    assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(root, "agents.md")), false);
  }
});

test("canonical whitelisted journal path still recovers", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-ms-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".mwf/local"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".mwf/local/transaction.json"),
    JSON.stringify({
      version: 1,
      changes: [{ path: "AGENTS.md", before: null, after: "x" }],
    }),
  );
  assert.equal(recover(root), true);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "x");
});
