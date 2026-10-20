import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extension from "../dist/integrations/pi/index.js";
import type { PiContext } from "../dist/integrations/pi/index.js";
import { execute } from "../dist/core.js";
import { lifecycle } from "../dist/setup.js";
test("native Pi adapter respects enablement, trust, epochs and detach", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-pi-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map<
    string,
    (event: Record<string, unknown>, ctx: PiContext) => unknown
  >();
  let registered = 0;
  extension({
    on: (name, fn) => {
      handlers.set(name, fn);
    },
    registerMcpServer: () => {
      registered++;
    },
    unregisterMcpServer: () => {
      registered--;
    },
  });
  const ctx = {
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "s1" },
  };
  handlers.get("session_start")!({}, ctx);
  assert.equal(registered, 0);
  assert.deepEqual(fs.readdirSync(root), []);
  execute("init", { project_root: root, git_mode: "track" });
  lifecycle("attach", {
    project_root: root,
    harness: "pi",
    plugin_root: process.cwd(),
    apply: true,
  });
  execute("add", {
    project_root: root,
    type: "preference",
    title: "Policy",
    summary: "Use policy",
    body: "Evidence",
  });
  handlers.get("session_start")!({}, ctx);
  assert.equal(registered, 1);
  assert.match(
    JSON.stringify(
      handlers.get("before_agent_start")!({ prompt: "policy" }, ctx),
    ),
    /Use policy/,
  );
  assert.equal(
    handlers.get("before_agent_start")!({ prompt: "policy" }, ctx),
    undefined,
  );
  for (const event of ["session_compact", "session_tree", "session_start"]) {
    handlers.get(event)!({}, ctx);
    assert.equal(registered, 1);
    assert.match(
      JSON.stringify(handlers.get("before_agent_start")!({}, ctx)),
      /Use policy/,
    );
  }
  const replacement = {
    ...ctx,
    sessionManager: { getSessionId: () => "replacement" },
  };
  assert.match(
    JSON.stringify(handlers.get("before_agent_start")!({}, replacement)),
    /Use policy/,
  );
  assert.equal(registered, 1);
  handlers.get("session_start")!({}, ctx);
  assert.equal(
    handlers.get("before_agent_start")!(
      {},
      {
        ...ctx,
        contextLimits: { max_output_bytes: 1 },
      },
    ),
    undefined,
  );
  assert.match(
    JSON.stringify(
      handlers.get("before_agent_start")!({ prompt: "policy" }, ctx),
    ),
    /Use policy/,
  );
  lifecycle("detach", {
    project_root: root,
    harness: "pi",
    plugin_root: process.cwd(),
    apply: true,
  });
  assert.equal(handlers.get("before_agent_start")!({}, ctx), undefined);
  assert.equal(registered, 0);
  handlers.get("session_start")!({}, { ...ctx, isProjectTrusted: () => false });
  assert.equal(registered, 0);
});
