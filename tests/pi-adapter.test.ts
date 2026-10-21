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

test("Pi discovery uses the packaged extension entry", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./dist/integrations/pi/index.js"]);
  assert.ok(fs.existsSync(pkg.pi.extensions[0]));
});

test("Pi lifecycle matrix refreshes versions, replaces roots and survives MCP failure", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-pi-matrix-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const roots = ["A", "项目 B"].map((name) => {
    const root = path.join(base, name);
    fs.mkdirSync(root);
    execute("init", { project_root: root, git_mode: "track" });
    lifecycle("attach", {
      project_root: root,
      harness: "pi",
      plugin_root: process.cwd(),
      apply: true,
    });
    return root;
  });
  const handlers = new Map<
    string,
    Array<(event: Record<string, unknown>, ctx: PiContext) => unknown>
  >();
  const servers = new Map<string, string[]>();
  let fail = false;
  const api = {
    on(
      name: string,
      fn: (event: Record<string, unknown>, ctx: PiContext) => unknown,
    ) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerMcpServer(name: string, config: { args: string[] }) {
      if (fail) throw new Error("MCP unavailable");
      assert.equal(servers.size, 0);
      servers.set(name, config.args);
    },
    unregisterMcpServer(name: string) {
      servers.delete(name);
    },
  };
  const emit = (name: string, ctx: PiContext, event = {}) =>
    handlers
      .get(name)
      ?.map((fn) => fn(event, ctx))
      .filter(Boolean);
  let session = "initial";
  const ctx: PiContext = {
    cwd: roots[0],
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => session },
  };
  extension(api);
  emit("session_start", ctx);
  for (const [index, reason] of [
    "compact",
    "tree",
    "resume",
    "clear",
    "reload",
  ].entries()) {
    const marker = `VERSION_${index}`;
    execute("add", {
      project_root: ctx.cwd,
      type: "preference",
      title: marker,
      summary: marker,
      body: marker,
    });
    emit(
      reason === "compact"
        ? "session_compact"
        : reason === "tree"
          ? "session_tree"
          : "session_start",
      ctx,
      { reason },
    );
    assert.match(
      JSON.stringify(emit("before_agent_start", ctx)),
      new RegExp(marker),
    );
    assert.equal(servers.size, 1);
  }
  ctx.cwd = roots[1];
  session = "replacement";
  emit("before_agent_start", ctx);
  assert.ok(servers.get("mwf")?.includes(roots[1]));
  assert.ok(!servers.get("mwf")?.includes(roots[0]));
  extension(api); // Old callbacks must neither register nor clear the replacement.
  emit("session_start", ctx);
  assert.equal(servers.size, 1);
  execute("add", {
    project_root: ctx.cwd,
    type: "preference",
    title: "Offline",
    summary: "DIRECT_RECOVERY",
    body: "Evidence",
  });
  fail = true;
  emit("session_start", ctx);
  assert.equal(servers.size, 0);
  assert.match(
    JSON.stringify(emit("before_agent_start", ctx)),
    /DIRECT_RECOVERY/,
  );
  const before = fs.readFileSync(
    path.join(ctx.cwd, ".mwf/local/integration.json"),
    "utf8",
  );
  emit("session_start", { ...ctx, isProjectTrusted: () => false });
  assert.deepEqual(
    emit("before_agent_start", { ...ctx, isProjectTrusted: () => false }),
    [],
  );
  assert.equal(
    fs.readFileSync(path.join(ctx.cwd, ".mwf/local/integration.json"), "utf8"),
    before,
  );
});

test("Pi rejects both configuration sources and legacy adapter entries", async (t) => {
  const { piConflicts } = await import("../dist/lifecycle/index.js");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-pi-config-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(base, "user");
  t.after(() => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    fs.rmSync(base, { recursive: true, force: true });
  });
  for (const dir of [process.env.PI_CODING_AGENT_DIR, path.join(base, ".pi")]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { mwf: { command: "old" } } }),
    );
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ extensions: ["./pi-mcp-adapter/index.ts"] }),
    );
  }
  const conflicts = piConflicts(base);
  assert.equal(conflicts.length, 4);
  assert.ok(
    conflicts.some((value) =>
      value.startsWith(process.env.PI_CODING_AGENT_DIR!),
    ),
  );
  assert.ok(
    conflicts.some((value) => value.startsWith(path.join(base, ".pi"))),
  );
});
