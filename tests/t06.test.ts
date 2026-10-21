import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "../dist/core.js";
import { lifecycle } from "../dist/lifecycle/index.js";
import { checkBinding, discover } from "../dist/integrations/shared/binding.js";
import { Transaction } from "../dist/storage.js";
import { serve } from "../dist/mcp.js";
const source = fileURLToPath(new URL("../", import.meta.url));
function project(t: test.TestContext) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-t06-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "A");
  fs.mkdirSync(root);
  execute("init", { project_root: root, git_mode: "track" });
  const runtime = path.join(base, "runtime.js");
  fs.writeFileSync(runtime, "");
  const client = () => ({
    enabled: true,
    binding_generation: "old",
    runtime_version: "0.2.0",
    api_version: 2,
    runtime_path: runtime,
    node_path: process.execPath,
    owned_resources: [],
  });
  const r = {
    receipt_version: 2,
    canonical_root: root,
    clients: { pi: client(), codex: client() },
  };
  const write = (target = root) =>
    fs.writeFileSync(
      path.join(target, ".mwf/local/integration.json"),
      JSON.stringify(r),
    );
  write();
  const read = (target = root) =>
    JSON.parse(
      fs.readFileSync(path.join(target, ".mwf/local/integration.json"), "utf8"),
    );
  return { base, root, runtime, r, write, read };
}
test("T06 copied B MCP starts before any hook and cannot access enabled A", async (t) => {
  const { base, root, read } = project(t),
    copy = path.join(base, "B");
  fs.cpSync(root, copy, { recursive: true });
  const cwd = process.cwd();
  process.chdir(copy);
  try {
    // Copied TOML can still name A; the MCP must use its actual host cwd.
    await assert.rejects(
      serve(root, { harness: "codex", binding_generation: "old" }),
      /differs from bound root/,
    );
    await assert.rejects(
      serve(copy, { harness: "codex", binding_generation: "old" }),
      /another location/,
    );
  } finally {
    process.chdir(cwd);
  }
  assert.equal(read().clients.codex.enabled, true);
  assert.equal(read(copy).clients.codex.enabled, true);
});
test("T06 moved roots, deleted runtime and corrupt nearest child fail closed", (t) => {
  const { base, root, runtime } = project(t);
  const binding = {
    root,
    harness: "pi" as const,
    generation: "old",
    runtime,
    cwd: root,
  };
  fs.unlinkSync(runtime);
  assert.throws(
    () => checkBinding(new Transaction(root), binding),
    /Runtime changed/,
  );
  fs.writeFileSync(runtime, "");
  const child = path.join(root, "child");
  fs.mkdirSync(path.join(child, ".mwf"), { recursive: true });
  fs.writeFileSync(path.join(child, ".mwf/config.json"), "{broken");
  assert.equal(discover(child), child);
  assert.throws(
    () => checkBinding(new Transaction(root), { ...binding, cwd: child }),
    /differs from bound root/,
  );
  assert.throws(() => execute("bootstrap", { project_root: child }));
  const moved = path.join(base, "moved");
  fs.renameSync(root, moved);
  assert.throws(
    () =>
      checkBinding(new Transaction(moved), {
        ...binding,
        root: moved,
        cwd: moved,
      }),
    /another location/,
  );
});
test("T06 root change durably disables all clients even if rebind fails; success enables only target", (t) => {
  const { base, root, read } = project(t),
    copy = path.join(base, "B");
  fs.cpSync(root, copy, { recursive: true });
  assert.throws(
    () =>
      lifecycle("rebind", {
        project_root: copy,
        harness: "pi",
        plugin_root: base,
        apply: true,
      }),
    /Invalid plugin runtime/,
  );
  assert.equal(read(copy).clients.pi.enabled, false);
  assert.equal(read(copy).clients.codex.enabled, false);
  lifecycle("rebind", {
    project_root: copy,
    harness: "pi",
    plugin_root: source,
    apply: true,
  });
  assert.equal(read(copy).canonical_root, copy);
  assert.equal(read(copy).clients.pi.enabled, true);
  assert.equal(read(copy).clients.codex.enabled, false);
  assert.notEqual(read(copy).clients.pi.binding_generation, "old");
  assert.equal(read().clients.codex.enabled, true);
});
test("T06 TOML ownership cleanup (0.3: no JSON resources) preserves unrelated content and disables on changed values", (t) => {
  for (const kind of ["block"] as string[])
    for (const edited of [false, true]) {
      const { root, r, write, read } = project(t);
      const file = kind === "json" ? ".pi/mcp.json" : ".codex/config.toml";
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      const installed =
        kind === "json"
          ? { command: "owned" }
          : '# mwf:mcp:start\n[mcp_servers.mwf]\ncommand = "owned"\n# mwf:mcp:end';
      const text =
        kind === "json"
          ? JSON.stringify({
              custom: { keep: true },
              mcpServers: {
                other: { command: "keep" },
                mwf: edited ? { command: "edited" } : installed,
              },
            })
          : '# keep comment\nmodel = "keep"\n' +
            String(installed).replace(
              '"owned"',
              edited ? '"edited"' : '"owned"',
            ) +
            "\n";
      fs.writeFileSync(path.join(root, file), text);
      const client = r.clients[kind === "json" ? "pi" : "codex"];
      Object.assign(client, {
        owned_resources: [
          kind === "json"
            ? { kind, path: file, installed, before: null, created: false }
            : { kind, path: file, installed, created: false },
        ],
      });
      write();
      const result = lifecycle("detach", {
        project_root: root,
        harness: kind === "json" ? "pi" : "codex",
        apply: true,
      });
      const state = read().clients[kind === "json" ? "pi" : "codex"];
      assert.equal(state.enabled, false);
      assert.equal(state.cleanup_pending, edited);
      assert.equal(result.ok, !edited);
      const after = fs.readFileSync(path.join(root, file), "utf8");
      if (edited) assert.equal(after, text);
      else if (kind === "json")
        assert.deepEqual(JSON.parse(after), {
          custom: { keep: true },
          mcpServers: { other: { command: "keep" } },
        });
      else assert.equal(after, '# keep comment\nmodel = "keep"\n');
    }
});
