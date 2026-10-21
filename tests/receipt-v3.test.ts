// PR-08: receipt v3 and the fail-closed v2→v3 upgrade.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute } from "../dist/core.js";
import { lifecycle } from "../dist/lifecycle/index.js";
import { recover, Transaction } from "../dist/storage/index.js";
import { receipt, upgradeReceipt } from "../dist/storage/receipt.js";

const RECEIPT = ".mwf/local/integration.json";
const JOURNAL = ".mwf/local/transaction.json";
const USER_TOML = '# user\nmodel = "x"\n\n[profiles.a]\nk = 1\n';

const VERSION = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
let codexPlugin = "";
const plug = (h: string) => (h === "codex" ? codexPlugin : process.cwd());
function attached(t: TestContext) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-r3-")),
  );
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    fs.rmSync(base, { recursive: true, force: true });
  });
  codexPlugin = path.join(base, "plugin");
  fs.mkdirSync(codexPlugin);
  fs.writeFileSync(
    path.join(codexPlugin, "plugin.json"),
    JSON.stringify({ name: "mwf", version: VERSION }),
  );
  fs.symlinkSync(process.cwd(), path.join(codexPlugin, "runtime"), "dir");
  const root = path.join(base, "p");
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex/config.toml"), USER_TOML);
  execute("init", { project_root: root, git_mode: "track" });
  for (const harness of ["pi", "codex"])
    assert.equal(
      lifecycle("attach", {
        project_root: root,
        harness,
        plugin_root: plug(harness),
        apply: true,
      }).ok,
      true,
    );
  return root;
}
type Json = { [k: string]: any };
const read = (root: string): Json =>
  JSON.parse(fs.readFileSync(path.join(root, RECEIPT), "utf8"));
/** Rewrite the stored receipt as a 0.2.x (v2) receipt. */
function asV2(root: string, edit: (r: Json) => void = () => {}) {
  const r = read(root);
  r.receipt_version = 2;
  edit(r);
  fs.writeFileSync(path.join(root, RECEIPT), JSON.stringify(r, null, 2));
}
function snapshot(root: string) {
  return Object.fromEntries(
    (fs.readdirSync(root, { recursive: true }) as string[])
      .filter((f) => fs.statSync(path.join(root, f)).isFile())
      .sort()
      .map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]),
  );
}
function code(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (e) {
    return e as { code?: string; message: string };
  }
  assert.fail("expected an error");
}
const ops = (root: string) => [
  () =>
    lifecycle("attach", {
      project_root: root,
      harness: "pi",
      plugin_root: process.cwd(),
      apply: true,
    }),
  () =>
    lifecycle("attach", {
      project_root: root,
      harness: "codex",
      plugin_root: codexPlugin,
      apply: false,
    }),
  () =>
    lifecycle("detach", { project_root: root, harness: "all", apply: true }),
  () =>
    lifecycle("detach", { project_root: root, harness: "codex", apply: false }),
];

const pending: [string, string, Json][] = [
  [
    "json .pi/mcp.json",
    "pi",
    {
      kind: "json",
      path: ".pi/mcp.json",
      installed: { command: "node" },
      before: null,
      created: true,
    },
  ],
  [
    "file .pi/extensions/mwf.js",
    "pi",
    {
      kind: "file",
      path: ".pi/extensions/mwf.js",
      installed_hash: "a".repeat(64),
      before: null,
    },
  ],
  [
    "file .agents/skills/mwf-init/SKILL.md",
    "codex",
    {
      kind: "file",
      path: ".agents/skills/mwf-init/SKILL.md",
      installed_hash: "b".repeat(64),
      before: null,
    },
  ],
];
for (const [name, client, resource] of pending)
  test(`v2 receipt owning ${name} fails closed with LEGACY_RESOURCE_PENDING and changes nothing`, (t) => {
    const root = attached(t);
    if (resource.path.startsWith(".pi/")) {
      fs.mkdirSync(path.join(root, path.dirname(resource.path)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, resource.path), "legacy\n");
    }
    asV2(root, (r) => r.clients[client].owned_resources.push(resource));
    const before = snapshot(root);
    for (const op of ops(root)) {
      const e = code(op);
      assert.equal(e.code, "LEGACY_RESOURCE_PENDING", e.message);
      assert.ok(e.message.includes(`${client}: ${resource.path}`), e.message);
      assert.ok(e.message.includes("0.2.x"), e.message);
      assert.ok(
        e.message.includes(
          `mwf detach --root <project> --harness ${client} --apply`,
        ),
        e.message,
      );
    }
    assert.equal(
      code(() => upgradeReceipt(root)).code,
      "LEGACY_RESOURCE_PENDING",
    );
    const doctor = execute("doctor", { project_root: root });
    assert.equal(doctor.ok, false);
    assert.ok((doctor.data as Json).errors.includes("LEGACY_RESOURCE_PENDING"));
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.existsSync(path.join(root, JOURNAL)), false);
  });

test("v2 receipt whose legacy resources were already detached upgrades cleanly to v3", (t) => {
  const root = attached(t);
  asV2(root, (r) => {
    r.clients.codex.owned_resources = [];
    r.clients.codex.enabled = false;
  });
  // Read paths upgrade in memory without writing.
  const before = snapshot(root);
  assert.equal(receipt(new Transaction(root))!.receipt_version, 3);
  assert.equal(execute("doctor", { project_root: root }).ok, true);
  assert.deepEqual(snapshot(root), before);
  const r = lifecycle("attach", {
    project_root: root,
    harness: "pi",
    plugin_root: process.cwd(),
    apply: true,
  });
  assert.equal(r.ok, true);
  assert.equal(read(root).receipt_version, 3);
  assert.ok(r.changed_files.includes(RECEIPT));
});

test("v2 receipt with only the Codex block upgrades, keeps installed/created, and 0.3 detach is byte-exact", (t) => {
  const root = attached(t);
  const v2Block = read(root).clients.codex.owned_resources;
  assert.equal(v2Block.length, 1);
  asV2(root);
  assert.equal(upgradeReceipt(root), true);
  assert.equal(upgradeReceipt(root), false);
  const v3 = read(root);
  assert.equal(v3.receipt_version, 3);
  assert.deepEqual(v3.clients.codex.owned_resources, v2Block);
  assert.equal(
    lifecycle("detach", { project_root: root, harness: "codex", apply: true })
      .ok,
    true,
  );
  assert.equal(
    fs.readFileSync(path.join(root, ".codex/config.toml"), "utf8"),
    USER_TOML,
  );
});

test("tampered v2 receipt is INVALID_CONFIG and changes nothing", (t) => {
  for (const edit of [
    (r: Json) => (r.extra = 1),
    (r: Json) => (r.clients.codex.owned_resources[0].path = "src/x.ts"),
    (r: Json) =>
      r.clients.pi.owned_resources.push({
        kind: "file",
        path: ".pi/other.js",
        installed_hash: "x",
        before: null,
      }),
  ]) {
    const root = attached(t);
    asV2(root, edit);
    const before = snapshot(root);
    assert.equal(code(() => upgradeReceipt(root)).code, "INVALID_CONFIG");
    for (const op of ops(root)) assert.equal(code(op).code, "INVALID_CONFIG");
    assert.deepEqual(snapshot(root), before);
  }
});

test("an upgrade that fails midway rolls back: receipt bytes and all files unchanged, retry succeeds", (t) => {
  const root = attached(t);
  asV2(root);
  const before = snapshot(root);
  // Failure after validation, before the write.
  assert.throws(
    () =>
      upgradeReceipt(root, () => {
        throw new Error("injected");
      }),
    /injected/,
  );
  assert.deepEqual(snapshot(root), before);
  // Failure inside the write (temp file written, rename fails).
  const rename = t.mock.method(fs, "renameSync", () => {
    throw new Error("injected rename");
  });
  assert.throws(() => upgradeReceipt(root), /injected rename/);
  assert.throws(
    () =>
      lifecycle("attach", {
        project_root: root,
        harness: "pi",
        plugin_root: process.cwd(),
        apply: true,
      }),
    /injected rename/,
  );
  rename.mock.restore();
  assert.deepEqual(snapshot(root), before);
  assert.equal(fs.existsSync(path.join(root, JOURNAL)), false);
  recover(root);
  assert.deepEqual(snapshot(root), before);
  assert.equal(upgradeReceipt(root), true);
  assert.equal(read(root).receipt_version, 3);
});

test("0.3 rejects 0.1 paths: journal → INVALID_JOURNAL, v3 receipt → INVALID_CONFIG, no .pi temp scan", (t) => {
  const root = attached(t);
  for (const p of [
    ".pi/mcp.json",
    ".pi/extensions/mwf.js",
    ".agents/skills/mwf-init/SKILL.md",
  ]) {
    fs.mkdirSync(path.join(root, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), "user\n");
    fs.writeFileSync(
      path.join(root, JOURNAL),
      JSON.stringify({
        version: 1,
        changes: [{ path: p, before: null, after: "x" }],
      }),
    );
    assert.equal(code(() => recover(root)).code, "INVALID_JOURNAL");
    assert.equal(fs.readFileSync(path.join(root, p), "utf8"), "user\n");
    fs.rmSync(path.join(root, JOURNAL));
  }
  const tmp = path.join(
    root,
    ".pi/mcp.json.mwf-tmp-00000000-0000-4000-8000-000000000000",
  );
  fs.writeFileSync(tmp, "keep");
  recover(root);
  assert.equal(fs.existsSync(tmp), true);
  const r = read(root);
  r.clients.pi.owned_resources = [
    {
      kind: "file",
      path: ".pi/extensions/mwf.js",
      installed_hash: "a",
      before: null,
    },
  ];
  fs.writeFileSync(path.join(root, RECEIPT), JSON.stringify(r));
  assert.equal(
    code(() => receipt(new Transaction(root))).code,
    "INVALID_CONFIG",
  );
});
