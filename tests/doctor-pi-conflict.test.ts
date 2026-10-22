// Issue #20: doctor must report the Pi MCP conflict that attach refuses on.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute } from "../dist/core.js";
import { lifecycle } from "../dist/setup.js";

function attachedPi(t: TestContext) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-i20-")),
  );
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(base, "user-agent");
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  execute("init", { project_root: root, git_mode: "track" });
  const attached = lifecycle("attach", {
    project_root: root,
    harness: "pi",
    plugin_root: process.cwd(),
    apply: true,
  });
  assert.equal(attached.ok, true);
  return root;
}
const doctor = (root: string) =>
  execute("doctor", { project_root: root }) as unknown as {
    ok: boolean;
    data: {
      errors: string[];
      configured: Record<string, { issues: string[] }>;
    };
  };
const conflict = (root: string) =>
  `${path.join(root, ".pi/mcp.json")}: mcpServers.mwf`;
function writeMcp(root: string, value: unknown) {
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi/mcp.json"), JSON.stringify(value));
}

test("issue #20: absent .pi/mcp.json leaves doctor unchanged (ok)", (t) => {
  const root = attachedPi(t);
  const r = doctor(root);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.configured.pi!.issues, []);
});

test("issue #20: conflicting mcpServers.mwf makes doctor not ok with attach's code", (t) => {
  const root = attachedPi(t);
  writeMcp(root, { mcpServers: { mwf: { command: "other" } } });
  const r = doctor(root);
  assert.equal(r.ok, false);
  assert.ok(
    r.data.errors.includes(`pi: OWNERSHIP_CONFLICT:${conflict(root)}`),
    JSON.stringify(r.data.errors),
  );
  // attach reports the same source with the same code.
  assert.throws(
    () =>
      lifecycle("attach", {
        project_root: root,
        harness: "pi",
        plugin_root: process.cwd(),
        apply: false,
      }),
    (e: { code?: string; message?: string }) =>
      e.code === "OWNERSHIP_CONFLICT" && !!e.message?.includes(conflict(root)),
  );
  // Unrelated servers are not a conflict.
  writeMcp(root, { mcpServers: { other: { command: "x" } } });
  assert.equal(doctor(root).ok, true);
});

test("issue #20: an mcpServers.mwf entry owned by the receipt is not a conflict", (t) => {
  const root = attachedPi(t);
  const installed = { command: "node", args: ["mwf"] };
  writeMcp(root, { mcpServers: { mwf: installed } });
  const file = path.join(root, ".mwf/local/integration.json");
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  r.clients.pi.owned_resources = [
    {
      kind: "json",
      path: ".pi/mcp.json",
      installed,
      before: null,
      created: true,
    },
  ];
  fs.writeFileSync(file, JSON.stringify(r));
  const result = doctor(root);
  assert.equal(result.ok, true, JSON.stringify(result.data.errors));
});
