// Host load confirmation: the first hook run / extension start / MCP call after
// attach records `host_confirmation` and flips `host_confirmed`; status/doctor
// show pending or confirmed and hint when it stays unconfirmed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execute } from "../dist/core.js";
import { lifecycle } from "../dist/lifecycle/index.js";
import extension, { type PiContext } from "../dist/integrations/pi/index.js";

const source = fileURLToPath(new URL("../", import.meta.url));
const HINT = "可能未加载或未信任";

type Data = {
  probed: Record<string, Record<string, any>>;
  hints: string[];
  errors: string[];
};
const data = (result: { data: unknown }) => result.data as Data;
const receiptFile = (project: string) =>
  path.join(project, ".mwf/local/integration.json");
const readReceipt = (project: string) =>
  JSON.parse(fs.readFileSync(receiptFile(project), "utf8"));
const writeReceipt = (project: string, value: unknown) =>
  fs.writeFileSync(receiptFile(project), JSON.stringify(value, null, 2) + "\n");

function codexProject(t: test.TestContext) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-hostconfirm-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const plugin = path.join(base, "plugin"),
    runtime = path.join(plugin, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  for (const name of ["dist", "assets", "package.json"])
    fs.cpSync(path.join(source, name), path.join(runtime, name), {
      recursive: true,
    });
  fs.symlinkSync(
    path.join(source, "node_modules"),
    path.join(runtime, "node_modules"),
    "dir",
  );
  fs.writeFileSync(
    path.join(plugin, "plugin.json"),
    JSON.stringify({ name: "mwf", version: "0.3.1" }),
  );
  const project = path.join(base, "项目");
  fs.mkdirSync(project);
  const cli = path.join(runtime, "dist/cli.js");
  const run = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }),
    );
  run("init", "--root", project, "--git-mode", "track");
  const attach = () =>
    run(
      "attach",
      "--root",
      project,
      "--harness",
      "codex",
      "--plugin-root",
      plugin,
      "--apply",
    );
  attach();
  const hook = (event: string, extra: Record<string, unknown> = {}) => {
    const r = spawnSync(
      process.execPath,
      [path.join(runtime, "dist/integrations/codex/runner.js")],
      {
        cwd: project,
        encoding: "utf8",
        input: JSON.stringify({
          cwd: project,
          session_id: "hc",
          hook_event_name: event,
          source: "startup",
          ...extra,
        }),
      },
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { project, runtime, cli, run, attach, hook };
}

test("Codex: pending after attach, confirmed by the first SessionStart hook", (t) => {
  const { project, run, hook } = codexProject(t);
  let status = execute("status", { project_root: project });
  let load = data(status).probed.codex.host_load;
  assert.equal(load.state, "pending");
  assert.equal(load.hint, undefined);
  assert.equal(data(status).probed.codex.host_confirmed, "unknown");
  assert.deepEqual(data(status).hints, []);
  assert.equal(readReceipt(project).clients.codex.host_confirmation, undefined);

  hook("SessionStart", { codex_version: "0.99.1" });
  const confirmation = readReceipt(project).clients.codex.host_confirmation;
  assert.equal(confirmation.trigger, "hook:SessionStart");
  assert.equal(confirmation.host_version, "0.99.1");
  assert.ok(Date.parse(confirmation.time));
  assert.equal(
    readReceipt(project).clients.codex.probe.host_confirmed,
    "confirmed",
  );

  status = execute("status", { project_root: project });
  load = data(status).probed.codex.host_load;
  assert.equal(load.state, "confirmed");
  assert.equal(load.trigger, "hook:SessionStart");
  assert.equal(load.host_version, "0.99.1");
  assert.equal(data(status).probed.codex.host_confirmed, "confirmed");
  const doctor = run("doctor", "--root", project);
  assert.equal(doctor.data.probed.codex.host_load.state, "confirmed");

  // Later hooks keep the first record.
  hook("UserPromptSubmit", { prompt: "x" });
  assert.deepEqual(
    readReceipt(project).clients.codex.host_confirmation,
    confirmation,
  );
});

test("Codex: still pending after the timeout shows the hint in status and doctor, MCP call confirms", async (t) => {
  const { project, cli, run } = codexProject(t);
  const r = readReceipt(project);
  r.clients.codex.probe.time = new Date(Date.now() - 11 * 60_000).toISOString();
  writeReceipt(project, r);
  const status = execute("status", { project_root: project });
  assert.equal(data(status).probed.codex.host_load.state, "pending");
  assert.equal(data(status).probed.codex.host_load.hint, HINT);
  assert.deepEqual(data(status).hints, [`codex: ${HINT}`]);
  const doctor = run("doctor", "--root", project);
  assert.equal(doctor.data.probed.codex.host_load.hint, HINT);
  assert.deepEqual(doctor.data.hints, [`codex: ${HINT}`]);
  assert.equal(doctor.ok, true, "a hint is not a failure");
  // Inside the window there is no hint yet.
  r.clients.codex.probe.time = new Date(Date.now() - 60_000).toISOString();
  writeReceipt(project, r);
  assert.equal(
    data(execute("status", { project_root: project })).probed.codex.host_load
      .hint,
    undefined,
  );
  r.clients.codex.probe.time = new Date(Date.now() - 11 * 60_000).toISOString();
  writeReceipt(project, r);

  const generation = readReceipt(project).clients.codex.binding_generation;
  const client = new Client({ name: "codex-mcp-client", version: "9.8.7" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      "mcp",
      "--root",
      project,
      "--harness",
      "codex",
      "--binding-generation",
      generation,
      "--profile",
      "agent",
    ],
    cwd: project,
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await transport.close();
  });
  const reply = await client.callTool({ name: "mwf_status", arguments: {} });
  assert.equal(reply.isError, false);
  const confirmation = readReceipt(project).clients.codex.host_confirmation;
  assert.equal(confirmation.trigger, "mcp:status");
  assert.equal(confirmation.host_version, "9.8.7");
  assert.equal(confirmation.host_name, "codex-mcp-client");
  const after = data(execute("status", { project_root: project }));
  assert.equal(after.probed.codex.host_load.state, "confirmed");
  assert.deepEqual(after.hints, []);
});

test("Codex: re-attach starts unconfirmed again; a standalone MCP probe does not confirm", (t) => {
  const { project, attach, hook } = codexProject(t);
  // attach itself ran a standalone MCP probe (no --harness): still unconfirmed.
  assert.equal(readReceipt(project).clients.codex.host_confirmation, undefined);
  hook("SessionStart");
  assert.ok(readReceipt(project).clients.codex.host_confirmation);
  attach();
  const r = readReceipt(project);
  assert.equal(r.clients.codex.host_confirmation, undefined);
  assert.equal(r.clients.codex.probe.host_confirmed, "unknown");
  assert.equal(
    data(execute("status", { project_root: project })).probed.codex.host_load
      .state,
    "pending",
  );
});

test("Codex: a hook that cannot run (disabled client) never confirms", (t) => {
  const { project, hook, run } = codexProject(t);
  run("detach", "--root", project, "--harness", "codex", "--apply");
  hook("SessionStart");
  assert.equal(readReceipt(project).clients.codex.host_confirmation, undefined);
});

test("Pi: extension start confirms, untrusted projects stay pending with the hint", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-hostconfirm-pi-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execute("init", { project_root: root, git_mode: "track" });
  lifecycle("attach", {
    project_root: root,
    harness: "pi",
    plugin_root: source,
    apply: true,
  });
  const handlers = new Map<
    string,
    (e: Record<string, unknown>, ctx: PiContext) => unknown
  >();
  extension({
    on: (name, fn) => void handlers.set(name, fn),
    registerMcpServer: () => {},
    unregisterMcpServer: () => {},
  });
  const ctx = (trusted: boolean): PiContext => ({
    cwd: root,
    version: "1.3.0",
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => "pi-hc" },
  });
  const pending = () =>
    data(execute("status", { project_root: root })).probed.pi.host_load;

  // Pi has no attach-time probe: age the attach by hand to exercise the timeout.
  const r = readReceipt(root);
  r.clients.pi.probe = {
    time: new Date(Date.now() - 20 * 60_000).toISOString(),
    host_confirmed: "unknown",
  };
  writeReceipt(root, r);
  handlers.get("session_start")!({}, ctx(false));
  assert.equal(readReceipt(root).clients.pi.host_confirmation, undefined);
  assert.equal(pending().state, "pending");
  assert.equal(pending().hint, HINT);

  handlers.get("session_start")!({}, ctx(true));
  const confirmation = readReceipt(root).clients.pi.host_confirmation;
  assert.equal(confirmation.trigger, "extension:session_start");
  assert.equal(confirmation.host_version, "1.3.0");
  assert.equal(confirmation.host_name, "pi");
  assert.equal(readReceipt(root).clients.pi.probe.host_confirmed, "confirmed");
  assert.equal(pending().state, "confirmed");
  assert.equal(pending().hint, undefined);
});

test("Pi: a receipt without probe evidence confirms and re-attach resets it", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-hostconfirm-pi2-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execute("init", { project_root: root, git_mode: "track" });
  const attach = () =>
    lifecycle("attach", {
      project_root: root,
      harness: "pi",
      plugin_root: source,
      apply: true,
    });
  attach();
  assert.equal(
    data(execute("status", { project_root: root })).probed.pi.host_load.state,
    "pending",
  );
  const handlers = new Map<
    string,
    (e: Record<string, unknown>, ctx: PiContext) => unknown
  >();
  extension({
    on: (name, fn) => void handlers.set(name, fn),
    registerMcpServer: () => {},
    unregisterMcpServer: () => {},
  });
  handlers.get("session_start")!(
    {},
    {
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "pi-hc2" },
    },
  );
  const confirmation = readReceipt(root).clients.pi.host_confirmation;
  assert.equal(confirmation.host_version, null);
  assert.equal(
    data(execute("status", { project_root: root })).probed.pi.host_load.state,
    "confirmed",
  );
  attach();
  assert.equal(readReceipt(root).clients.pi.host_confirmation, undefined);
});
