// PR-06: HarnessAdapter contract, registry and the Codex adapter.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapters, adapterFor } from "../dist/integrations/registry.js";
import { codexAdapter, block } from "../dist/integrations/codex/adapter.js";
import { HARNESS_IDS, isHarnessId } from "../dist/contracts/harness.js";
import {
  MANAGED_SURFACES,
  SURFACE_IDS,
} from "../dist/contracts/managed-surface.js";
import type { HarnessContext } from "../dist/contracts/harness.js";
import type { ManagedSurfaceId } from "../dist/contracts/managed-surface.js";

const src = path.resolve(import.meta.dirname, "../src");

function ctx(files: Partial<Record<ManagedSurfaceId, string>> = {}) {
  return {
    root: "/project",
    env: {},
    nodePath: "/usr/bin/node",
    read: (s: ManagedSurfaceId) => files[s] ?? null,
  } as HarnessContext;
}
const runtime = {
  pluginRoot: "/p",
  runtimePath: "/p/runtime/dist/cli.js",
  version: "0.2.0",
};

test("registry: ids match, adapters frozen, surfaces are a subset of the whitelist", () => {
  assert.deepEqual([...HARNESS_IDS], ["pi", "codex"]);
  assert.ok(isHarnessId("codex") && !isHarnessId("cursor"));
  assert.ok(Object.isFrozen(adapters));
  for (const [id, adapter] of Object.entries(adapters)) {
    assert.equal(adapter!.id, id);
    assert.ok(Object.isFrozen(adapter));
    for (const s of adapter!.managedSurfaces)
      assert.ok(SURFACE_IDS.includes(s), `${id}: ${s}`);
  }
  assert.equal(adapterFor("codex"), codexAdapter);
  assert.deepEqual(codexAdapter.managedSurfaces, ["codex.config.block"]);
  assert.equal(codexAdapter.contextInjection, "hook-process");
});

test("adapters never write: no filesystem or transaction writes in adapter.ts", () => {
  const dir = path.join(src, "integrations");
  for (const host of fs.readdirSync(dir)) {
    const file = path.join(dir, host, "adapter.ts");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /\b(writeFileSync|appendFileSync|unlinkSync|rmSync|renameSync|mkdirSync|copyFileSync|atomicWrite|writeFile|\.set\(|\.commit\()/,
      file,
    );
  }
});

test("codex planAttach plans the managed block without touching disk", () => {
  const changes = codexAdapter.planAttach(ctx(), runtime, {
    generation: "g1",
    owned: [],
  });
  assert.equal(changes.length, 1);
  const [c] = changes;
  assert.equal(c!.surface, "codex.config.block");
  assert.equal(MANAGED_SURFACES[c!.surface].path, ".codex/config.toml");
  const text = `# mwf:mcp:start\n[mcp_servers.mwf]\ncommand = "/usr/bin/node"\nargs = ${JSON.stringify(["/p/runtime/dist/cli.js", "mcp", "--root", "/project", "--harness", "codex", "--binding-generation", "g1", "--profile", "agent"])}\n# mwf:mcp:end`;
  assert.equal(c!.after, `${text}\n`);
  assert.deepEqual(c!.resource, {
    kind: "block",
    surface: "codex.config.block",
    installed: text,
    created: true,
  });
  // Existing user content is preserved and a trailing newline inserted.
  const merged = codexAdapter.planAttach(
    ctx({ "codex.config.block": 'model = "x"' }),
    runtime,
    { generation: "g1", owned: [] },
  )[0]!;
  assert.equal(merged.after, `model = "x"\n${text}\n`);
  assert.equal(merged.resource!.created, false);
});

test("codex planAttach refuses unowned or modified mwf entries", () => {
  const code = (fn: () => unknown) =>
    assert.throws(
      fn,
      (e: { code?: string }) => e.code === "OWNERSHIP_CONFLICT",
    );
  code(() =>
    codexAdapter.planAttach(
      ctx({ "codex.config.block": '[mcp_servers.mwf]\ncommand = "x"\n' }),
      runtime,
      { generation: "g", owned: [] },
    ),
  );
  const first = codexAdapter.planAttach(ctx(), runtime, {
    generation: "g",
    owned: [],
  })[0]!;
  code(() =>
    codexAdapter.planAttach(
      ctx({ "codex.config.block": first.after! }),
      runtime,
      { generation: "g2", owned: [] },
    ),
  );
  // Owned block is replaced in place and `created` is preserved.
  const again = codexAdapter.planAttach(
    ctx({ "codex.config.block": first.after! }),
    runtime,
    { generation: "g2", owned: [first.resource!] },
  )[0]!;
  assert.equal(again.resource!.created, true);
  assert.match(again.after!, /"g2"/);
  assert.equal(block(again.after!), again.resource!.installed);
});

test("codex planDetach removes only an unmodified owned block", () => {
  const first = codexAdapter.planAttach(
    ctx({ "codex.config.block": 'model = "x"\n' }),
    runtime,
    { generation: "g", owned: [] },
  )[0]!;
  const detach = codexAdapter.planDetach(
    ctx({ "codex.config.block": first.after! }),
    [first.resource!],
  );
  assert.deepEqual(detach, [
    { surface: "codex.config.block", after: 'model = "x"\n' },
  ]);
  const created = codexAdapter.planAttach(ctx(), runtime, {
    generation: "g",
    owned: [],
  })[0]!;
  assert.deepEqual(
    codexAdapter.planDetach(ctx({ "codex.config.block": created.after! }), [
      created.resource!,
    ]),
    [{ surface: "codex.config.block", after: null }],
  );
  assert.deepEqual(codexAdapter.planDetach(ctx(), [created.resource!]), []);
  assert.throws(() =>
    codexAdapter.planDetach(
      ctx({ "codex.config.block": created.after!.replace("g", "h") }),
      [created.resource!],
    ),
  );
});

test("codex diagnose and conflicts", () => {
  assert.deepEqual(codexAdapter.conflicts(ctx()), []);
  assert.deepEqual(
    codexAdapter.diagnose(ctx(), {
      enabled: true,
      ownedCount: 0,
      cleanupPending: false,
    }),
    [{ code: "OWNERSHIP_MISSING" }],
  );
  assert.deepEqual(
    codexAdapter.diagnose(ctx(), {
      enabled: true,
      ownedCount: 1,
      cleanupPending: false,
    }),
    [],
  );
});

test("codex detect honors injected CODEX_HOME", () => {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-h-")),
  );
  try {
    assert.throws(
      () => codexAdapter.detect({ ...ctx(), env: { CODEX_HOME: home } }),
      (e: { code?: string }) => e.code === "PLUGIN_RUNTIME_REQUIRED",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
