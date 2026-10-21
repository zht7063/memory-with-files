// Architecture tests v2 (refactor plan §6). The analyzer lives in tests/arch.ts.
//
// KNOWN_VIOLATIONS is a ratchet: it may only shrink. The suite fails when
//   - a violation appears that is not listed (new debt), or
//   - a listed violation disappears or its count drops without the entry
//     being removed/lowered here (stale allowlist).
// Every entry names the refactor PR that removes it. Host-literal entries are
// keyed per file + matched text (e.g. `compare harness === "pi"`), so swapping
// one occurrence for a different one in an allowlisted file still fails.
//
// Known limitations (by design):
//   - Relative imports that do not resolve to a src file are skipped; tsc
//     (`npm run typecheck`) already fails on them.
//   - Dynamic import()/require() with a non-literal specifier is skipped; it
//     cannot be resolved statically. Keep specifiers literal.
//   - Only reexport-barrel, export-star, external and host-literal violations
//     may be allowlisted; root-barrel, cycle, upward, same-layer, entry-import,
//     adapter-isolation and unregistered may not.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, classify, tally } from "./arch.ts";

const src = path.resolve(import.meta.dirname, "../src");

type Known = { key: string; count?: number; removedBy: string; why: string };
const KNOWN_VIOLATIONS: Known[] = [
  {
    key: "export-star integrations/shared/binding.ts -> storage/receipt.ts",
    removedBy: "PR-09",
    why: "binding re-exports storage/receipt for old import paths",
  },
  {
    key: "export-star integrations/shared/identity.ts -> core/identity.ts",
    removedBy: "PR-09",
    why: "compat shim integrations/shared/identity.ts is deleted",
  },
  {
    key: "reexport-barrel integrations/shared/context.ts -> integrations/shared/identity.ts",
    removedBy: "PR-09",
    why: "imports core/identity directly once the shim is deleted",
  },
  {
    key: "external core/diagnostics.ts -> @iarna/toml",
    removedBy: "PR-07",
    why: "Codex TOML diagnosis moves into the adapter's diagnose()",
  },
  {
    key: 'host-literal cli.ts :: compare a.harness !== "pi"',
    removedBy: "PR-06",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal cli.ts :: compare a.harness !== "codex"',
    removedBy: "PR-06",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal cli.ts :: compare harness === "pi"',
    removedBy: "PR-06",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal cli.ts :: compare harness === "codex"',
    removedBy: "PR-06",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal core/diagnostics.ts :: compare client === "codex"',
    removedBy: "PR-07",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/index.ts :: compare harness === "pi"',
    removedBy: "PR-07",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/index.ts :: path ".pi"',
    removedBy: "PR-07",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/index.ts :: path ".pi/agent"',
    removedBy: "PR-07",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/index.ts :: compare h === "pi"',
    removedBy: "PR-07",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/index.ts :: path ".codex"',
    removedBy: "PR-06",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/index.ts :: compare harness === "codex"',
    count: 2,
    removedBy: "PR-06",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/index.ts :: compare harness !== "codex"',
    removedBy: "PR-06",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/index.ts :: path ".codex/config.toml"',
    count: 2,
    removedBy: "PR-06",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/index.ts :: path ".codex/config.toml is tracked; absolute local runtime paths will be included. Git index was not changed."',
    removedBy: "PR-06",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/index.ts :: compare h === "codex"',
    removedBy: "PR-06",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/migrate.ts :: path ".codex/config.toml"',
    removedBy: "PR-08",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/migrate.ts :: path ".pi/mcp.json"',
    removedBy: "PR-08",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal lifecycle/migrate.ts :: path ".pi/extensions/mwf.js"',
    removedBy: "PR-08",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal mcp.ts :: compare binding?.harness === "pi"',
    removedBy: "PR-07",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal mcp.ts :: compare id.client !== "pi"',
    removedBy: "PR-07",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal storage/index.ts :: path ".codex/config.toml"',
    removedBy: "PR-05",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal storage/index.ts :: path ".pi/mcp.json"',
    removedBy: "PR-05 (PR-08 drops this 0.1 path)",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal storage/index.ts :: path ".pi/extensions/mwf.js"',
    removedBy: "PR-05 (PR-08 drops this 0.1 path)",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal storage/index.ts :: path ".codex"',
    removedBy: "PR-05",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal storage/index.ts :: path ".pi"',
    removedBy: "PR-05",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal storage/index.ts :: path ".pi/extensions"',
    removedBy: "PR-05",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal storage/receipt.ts :: path ".codex/config.toml"',
    removedBy: "PR-05",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal storage/receipt.ts :: path ".pi/extensions/mwf.js"',
    removedBy: "PR-05 (PR-08 drops this 0.1 path)",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
  {
    key: 'host-literal storage/receipt.ts :: path ".pi/mcp.json"',
    removedBy: "PR-05 (PR-08 drops this 0.1 path)",
    why: "host knowledge moves behind managed-surface/registry/adapters",
  },
];

test("every src file is registered in the layer table", () => {
  const { violations } = analyze(src);
  assert.deepEqual(
    violations.filter((v) => v.rule === "unregistered").map((v) => v.detail),
    [],
  );
});

test("full import graph (type-only included) matches the shrinking allowlist", () => {
  const { violations, edges } = analyze(src);
  assert.ok(
    edges.some((e) => e.typeOnly),
    "type-only edges are tracked",
  );
  const actual = tally(violations);
  const expected = new Map(KNOWN_VIOLATIONS.map((k) => [k.key, k.count ?? 1]));
  const unexpected = violations
    .filter((v) => !expected.has(v.key))
    .map((v) => `[${v.rule}] ${v.detail}`);
  assert.deepEqual(unexpected, [], "new architecture violations");
  const stale = [...expected]
    .filter(([key, count]) => actual.get(key) !== count)
    .map(
      ([key, count]) =>
        `${key}: allowlisted ${count}, found ${actual.get(key) ?? 0} — update KNOWN_VIOLATIONS`,
    );
  assert.deepEqual(stale, [], "allowlist must shrink with the code");
});

test("allowlist never covers cycles, upward, entry or root-barrel imports", () => {
  for (const k of KNOWN_VIOLATIONS)
    assert.ok(
      !/^(cycle|upward|same-layer|entry-import|root-barrel|adapter-isolation|unregistered) /.test(
        k.key,
      ),
      `${k.key} must be fixed, not allowlisted`,
    );
});

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-arch-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

test("deliberate violations in a fixture tree are all caught", () => {
  const root = fixture({
    "contracts/a.ts":
      'import type { X } from "../core/index.js";\nexport const a = 1;\n',
    "storage/index.ts": "export const s = 1;\n",
    "retrieval/index.ts":
      'import { c } from "../context/output.js";\nexport const r = c;\n',
    "context/output.ts": "export const c = 1;\n",
    "core/index.ts":
      'import { a } from "../core.js";\nimport type { Y } from "./b.js";\nexport type X = 1;\nexport const k = a;\n',
    "core/b.ts": 'import type { Z } from "./c.js";\nexport type Y = Z;\n',
    "core/c.ts": 'import type { Y } from "./b.js";\nexport type Z = Y | 1;\n',
    "integrations/pi/index.ts":
      'import { q } from "../codex/index.js";\nimport { l } from "../../lifecycle/index.js";\nexport const p = q + l;\n',
    "integrations/codex/index.ts":
      'import TOML from "@iarna/toml";\nexport const q = 1;\nexport const t = TOML;\n',
    "integrations/codex/adapter.ts": "export const adapter = 1;\n",
    "integrations/shared/x.ts":
      'import { adapter } from "../codex/adapter.js";\nexport * from "../../storage/index.js";\nexport const x = adapter;\n',
    "lifecycle/index.ts":
      'import { cli } from "../cli.js";\nexport const l = cli;\nif (process.env.H === "codex") console.log(".pi/mcp.json");\n',
    "storage/shim.ts": 'export * from "./index.js";\n',
    "core/uses-shim.ts":
      'import { s } from "../storage/shim.js";\nexport const u = s;\n',
    "core.ts": 'export * from "./core/index.js";\nexport const a = 1;\n',
    "cli.ts": 'import { a } from "./core.js";\nexport const cli = a;\n',
    "core/diag.ts":
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nexport const m = McpServer;\n',
    "stray.ts": "export {};\n",
  });
  try {
    const rules = new Set(analyze(root).violations.map((v) => v.key));
    for (const key of [
      "upward contracts/a.ts -> core/index.ts",
      "same-layer retrieval/index.ts -> context/output.ts",
      "root-barrel core/index.ts -> core.ts",
      "entry-import core/index.ts -> core.ts",
      "cycle core/b.ts <-> core/c.ts",
      "adapter-isolation integrations/pi/index.ts -> integrations/codex/index.ts",
      "upward integrations/pi/index.ts -> lifecycle/index.ts",
      "adapter-isolation integrations/shared/x.ts -> integrations/codex/adapter.ts",
      "export-star integrations/shared/x.ts -> storage/index.ts",
      "entry-import lifecycle/index.ts -> cli.ts",
      "reexport-barrel core/uses-shim.ts -> storage/shim.ts",
      "external core/diag.ts -> @modelcontextprotocol/sdk",
      'host-literal lifecycle/index.ts :: compare process.env.H === "codex"',
      'host-literal lifecycle/index.ts :: path ".pi/mcp.json"',
      "unregistered stray.ts",
    ])
      assert.ok(rules.has(key), `fixture violation not caught: ${key}`);
    for (const key of rules)
      assert.ok(
        !key.startsWith("external integrations/codex/"),
        "@iarna/toml is allowed in integrations/codex",
      );
    assert.ok(
      ![...rules].some((k) => k.includes("cli.ts -> core.ts")),
      "cli.ts may import the root barrel",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("layer table classifies the planned new files", () => {
  assert.equal(classify("contracts/harness.ts")?.layer, 0);
  assert.equal(classify("contracts/managed-surface.ts")?.layer, 0);
  assert.equal(
    classify("integrations/registry.ts")?.module,
    "integrations/registry",
  );
  assert.equal(
    classify("integrations/codex/adapter.ts")?.module,
    "integrations/codex",
  );
  assert.equal(classify("lifecycle/index.ts")?.layer, 5);
  assert.equal(classify("cli.ts")?.layer, 6);
});

test("host-literal ratchet is per matched text, not per file count", () => {
  const root = fixture({
    "lifecycle/index.ts":
      'export const f = (h: string) => h === "pi" || h === "pi";\n',
  });
  const swapped = fixture({
    "lifecycle/index.ts":
      'export const f = (h: string) => h === "pi" || h === "codex";\n',
  });
  try {
    const pi = 'host-literal lifecycle/index.ts :: compare h === "pi"';
    const codex = 'host-literal lifecycle/index.ts :: compare h === "codex"';
    const before = tally(analyze(root).violations);
    const after = tally(analyze(swapped).violations);
    assert.equal(before.get(pi), 2);
    assert.equal(after.get(pi), 1);
    assert.equal(after.get(codex), 1);
    assert.notDeepEqual([...before], [...after]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(swapped, { recursive: true, force: true });
  }
});
