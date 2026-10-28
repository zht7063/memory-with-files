// Host load confirmation: the first hook run / extension start / MCP call after
// attach records `probe.host_confirmation.<channel>` (inside the free-form probe,
// so older runtimes still parse the receipt) and flips `probe.host_confirmed`;
// status/doctor show pending or confirmed and hint when it stays unconfirmed.
// Codex needs a *hook* to confirm: an MCP connection alone does not.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execute } from "../dist/core.js";
import {
  confirmHostLoad,
  CONFIRM_LOCK_WAIT_MS,
} from "../dist/integrations/shared/confirm.js";
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

const confirmationOf = (project: string, client: string) =>
  readReceipt(project).clients[client].probe?.host_confirmation;
const ago = (ms: number) => new Date(Date.now() - ms);
function age(project: string, ms: number) {
  // Pretend the current attach happened `ms` ago: probe time and file mtime.
  const r = readReceipt(project);
  for (const c of Object.values<any>(r.clients))
    if (c.probe?.time) c.probe.time = ago(ms).toISOString();
  writeReceipt(project, r);
  fs.utimesSync(receiptFile(project), ago(ms), ago(ms));
}
async function mcpCall(project: string, cli: string, version = "9.8.7") {
  const generation = readReceipt(project).clients.codex.binding_generation;
  const client = new Client({ name: "codex-mcp-client", version });
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
  try {
    const reply = await client.callTool({ name: "mwf_status", arguments: {} });
    assert.equal(reply.isError, false);
  } finally {
    await client.close();
    await transport.close();
  }
}
const status = (project: string) =>
  data(execute("status", { project_root: project }));

test("Codex: pending after attach, confirmed by the first SessionStart hook", (t) => {
  const { project, run, hook } = codexProject(t);
  let s = status(project);
  let load = s.probed.codex.host_load;
  assert.equal(load.state, "pending");
  assert.equal(load.required, "hook");
  assert.equal(load.hint, undefined);
  assert.equal(s.probed.codex.host_confirmed, "unknown");
  assert.deepEqual(s.hints, []);
  assert.equal(confirmationOf(project, "codex"), undefined);

  hook("SessionStart", { codex_version: "0.99.1" });
  const confirmation = confirmationOf(project, "codex");
  assert.equal(confirmation.hook.trigger, "hook:SessionStart");
  assert.equal(confirmation.hook.host_version, "0.99.1");
  assert.equal(confirmation.hook.host_name, "codex");
  assert.ok(Date.parse(confirmation.hook.time));
  assert.equal(
    readReceipt(project).clients.codex.probe.host_confirmed,
    "confirmed",
  );

  s = status(project);
  load = s.probed.codex.host_load;
  assert.equal(load.state, "confirmed");
  assert.equal(load.trigger, "hook:SessionStart");
  assert.equal(load.host_version, "0.99.1");
  assert.equal(load.confirmed_at, confirmation.hook.time);
  assert.equal(s.probed.codex.host_confirmed, "confirmed");
  assert.equal(
    run("doctor", "--root", project).data.probed.codex.host_load.state,
    "confirmed",
  );

  // Later hooks keep the first record.
  hook("UserPromptSubmit", { prompt: "x" });
  assert.deepEqual(confirmationOf(project, "codex"), confirmation);
});

test("Codex: an MCP call alone does not confirm hook loading; a hook later does and takes the version from MCP", async (t) => {
  const { project, cli, run, hook } = codexProject(t);
  age(project, 11 * 60_000);
  await mcpCall(project, cli);
  const mcp = confirmationOf(project, "codex").mcp;
  assert.equal(mcp.trigger, "mcp:status");
  assert.equal(mcp.host_version, "9.8.7");
  assert.equal(mcp.host_name, "codex-mcp-client");
  assert.equal(confirmationOf(project, "codex").hook, undefined);

  let s = status(project);
  assert.equal(s.probed.codex.host_confirmed, "unknown");
  assert.equal(s.probed.codex.host_load.state, "pending");
  assert.deepEqual(s.probed.codex.host_load.channels, {
    hook: "pending",
    mcp: "confirmed",
  });
  assert.equal(s.probed.codex.host_load.hint, HINT);
  assert.match(s.probed.codex.host_load.detail, /hook.*MCP/);
  assert.deepEqual(s.hints, [`codex: ${HINT}`]);
  const doctor = run("doctor", "--root", project);
  assert.equal(doctor.data.probed.codex.host_load.hint, HINT);
  assert.equal(doctor.ok, true, "a hint is not a failure");

  hook("SessionStart"); // the Codex hook payload carries no version
  s = status(project);
  assert.equal(s.probed.codex.host_load.state, "confirmed");
  assert.equal(s.probed.codex.host_load.trigger, "hook:SessionStart");
  assert.equal(
    s.probed.codex.host_load.host_version,
    "9.8.7",
    "falls back to the MCP clientInfo version",
  );
  assert.equal(s.probed.codex.host_confirmed, "confirmed");
  assert.deepEqual(s.hints, []);
  // The MCP record survives the hook write.
  assert.equal(confirmationOf(project, "codex").mcp.host_version, "9.8.7");
});

test("pending timeout: no hint inside the window, independent of probe time, robust to clock jumps", (t) => {
  const { project } = codexProject(t);
  const hint = () => status(project).probed.codex.host_load.hint;
  age(project, 60_000);
  assert.equal(hint(), undefined, "inside the window");
  age(project, 11 * 60_000);
  assert.equal(hint(), HINT);

  // No probe time at all: the receipt file's mtime anchors the timeout.
  const r = readReceipt(project);
  delete r.clients.codex.probe.time;
  writeReceipt(project, r);
  fs.utimesSync(receiptFile(project), ago(11 * 60_000), ago(11 * 60_000));
  assert.equal(hint(), HINT);
  fs.utimesSync(receiptFile(project), ago(60_000), ago(60_000));
  assert.equal(hint(), undefined);

  // Probe time in the future (clock was set back): ignored, not suppressing.
  r.clients.codex.probe.time = new Date(Date.now() + 3_600_000).toISOString();
  writeReceipt(project, r);
  fs.utimesSync(receiptFile(project), ago(11 * 60_000), ago(11 * 60_000));
  assert.equal(hint(), HINT);
  // Every anchor in the future: no usable anchor, so no (false) hint.
  const future = new Date(Date.now() + 3_600_000);
  fs.utimesSync(receiptFile(project), future, future);
  const load = status(project).probed.codex.host_load;
  assert.equal(load.state, "pending");
  assert.equal(load.hint, undefined);
  assert.equal(load.since, null);
});

test("Codex: re-attach starts unconfirmed again; a standalone MCP probe does not confirm; stale records are dropped consistently", (t) => {
  const { project, attach, hook } = codexProject(t);
  // attach itself ran a standalone MCP probe (no --harness): still unconfirmed.
  assert.equal(confirmationOf(project, "codex"), undefined);
  hook("SessionStart");
  assert.ok(confirmationOf(project, "codex").hook);
  attach();
  const r = readReceipt(project);
  assert.equal(r.clients.codex.probe.host_confirmation, undefined);
  assert.equal(r.clients.codex.probe.host_confirmed, "unknown");
  assert.equal(status(project).probed.codex.host_load.state, "pending");

  // A record for another binding generation never counts, in the probe mirror
  // or in status; the next hook replaces it instead of extending it.
  r.clients.codex.probe.host_confirmed = "confirmed";
  r.clients.codex.probe.host_confirmation = {
    binding_generation: "stale",
    runtime_version: r.clients.codex.runtime_version,
    hook: {
      time: ago(3_600_000).toISOString(),
      host_version: "0.1",
      host_name: "codex",
      trigger: "hook:SessionStart",
    },
  };
  writeReceipt(project, r);
  assert.equal(status(project).probed.codex.host_load.state, "pending");
  assert.equal(status(project).probed.codex.host_confirmed, "unknown");
  hook("UserPromptSubmit", { prompt: "x" });
  const fresh = confirmationOf(project, "codex");
  assert.equal(fresh.binding_generation, r.clients.codex.binding_generation);
  assert.equal(fresh.hook.trigger, "hook:UserPromptSubmit");
  assert.equal(fresh.hook.host_version, null);
  assert.equal(
    readReceipt(project).clients.codex.probe.host_confirmed,
    "confirmed",
  );
  assert.equal(status(project).probed.codex.host_load.state, "confirmed");
});

test("receipt compatibility: receipt_version stays 3 and an older strict client schema still parses a confirmed receipt", (t) => {
  const { project, hook } = codexProject(t);
  hook("SessionStart");
  const r = readReceipt(project);
  assert.equal(r.receipt_version, 3);
  // The 0.3.1 client schema: strict, with `probe` free-form. Anything the
  // confirmation adds outside `probe` would make older runtimes reject the
  // receipt (INVALID_INTEGRATION_RECEIPT, and detach fails).
  const older031Client = z
    .object({
      enabled: z.boolean(),
      probe: z.record(z.unknown()).optional(),
      binding_generation: z.string().optional(),
      runtime_version: z.string().optional(),
      api_version: z.number().optional(),
      runtime_path: z.string().optional(),
      node_path: z.string().optional(),
      owned_resources: z.array(z.unknown()).default([]),
      cleanup_pending: z.boolean().default(false),
    })
    .strict();
  assert.ok(older031Client.safeParse(r.clients.codex).success);
  assert.ok(r.clients.codex.probe.host_confirmation.hook);
  // Detach (which parses the receipt) still works after confirmation.
  const run = (...a: string[]) =>
    execFileSync(process.execPath, [path.join(source, "dist/cli.js"), ...a], {
      encoding: "utf8",
    });
  assert.equal(JSON.parse(run("status", "--root", project)).ok, true);
});

test("Codex: a hook that cannot run (disabled client) never confirms", (t) => {
  const { project, hook, run } = codexProject(t);
  run("detach", "--root", project, "--harness", "codex", "--apply");
  hook("SessionStart");
  assert.equal(confirmationOf(project, "codex"), undefined);
});

test("first confirmation waits only briefly for a busy project lock and succeeds on the next trigger", async (t) => {
  const { project, runtime } = codexProject(t);
  const c = readReceipt(project).clients.codex;
  const binding = {
    root: project,
    harness: "codex" as const,
    generation: c.binding_generation,
    runtime: path.join(runtime, "dist/cli.js"),
    cwd: project,
  };
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(${JSON.stringify(path.join(project, ".mwf/local/runtime.sqlite"))});
       db.exec("BEGIN IMMEDIATE");
       console.log("held");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, 20000);`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  t.after(() => holder.kill("SIGKILL"));
  await new Promise<void>((resolve) =>
    holder.stdout.once("data", () => resolve()),
  );
  const started = Date.now();
  const done = confirmHostLoad(binding, {
    channel: "hook",
    trigger: "hook:SessionStart",
  });
  const waited = Date.now() - started;
  assert.equal(done, false, "busy lock: nothing recorded, no throw");
  assert.ok(waited < CONFIRM_LOCK_WAIT_MS + 1500, `waited ${waited} ms`);
  assert.equal(confirmationOf(project, "codex"), undefined);
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("close", resolve));
  assert.equal(
    confirmHostLoad(binding, { channel: "hook", trigger: "hook:SessionStart" }),
    true,
  );
  assert.ok(confirmationOf(project, "codex").hook);
});

function piProject(t: test.TestContext, name: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
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
  const handlers = new Map<
    string,
    (e: Record<string, unknown>, ctx: PiContext) => unknown
  >();
  extension({
    on: (n, fn) => void handlers.set(n, fn),
    registerMcpServer: () => {},
    unregisterMcpServer: () => {},
  });
  const ctx = (trusted: boolean, version?: string): PiContext => ({
    cwd: root,
    ...(version ? { version } : {}),
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => "pi-hc" },
  });
  return { root, attach, handlers, ctx };
}

test("Pi: extension start confirms, untrusted projects stay pending with the hint", (t) => {
  const { root, handlers, ctx } = piProject(t, "mwf-hostconfirm-pi-");
  const load = () => status(root).probed.pi.host_load;
  assert.equal(load().state, "pending");
  assert.equal(load().required, "extension");
  // Library attach writes no probe: the receipt mtime anchors the timeout.
  age(root, 20 * 60_000);
  handlers.get("session_start")!({}, ctx(false));
  assert.equal(confirmationOf(root, "pi"), undefined);
  assert.equal(load().state, "pending");
  assert.equal(load().hint, HINT);

  handlers.get("session_start")!({}, ctx(true, "1.3.0"));
  const confirmation = confirmationOf(root, "pi").extension;
  assert.equal(confirmation.trigger, "extension:session_start");
  assert.equal(confirmation.host_version, "1.3.0");
  assert.equal(confirmation.host_name, "pi");
  assert.equal(readReceipt(root).clients.pi.probe.host_confirmed, "confirmed");
  assert.equal(load().state, "confirmed");
  assert.equal(load().hint, undefined);
  assert.equal(readReceipt(root).receipt_version, 3);
  // No probe evidence was invented: the host_* keys are not "stale evidence".
  assert.equal(status(root).probed.pi.reason, "not_run");
});

test("Pi: compact/tree events confirm too, and re-attach resets it", (t) => {
  const { root, attach, handlers, ctx } = piProject(t, "mwf-hostconfirm-pi2-");
  handlers.get("session_compact")!({}, ctx(true));
  const confirmation = confirmationOf(root, "pi").extension;
  assert.equal(confirmation.trigger, "extension:session_compact");
  assert.equal(confirmation.host_version, null);
  assert.equal(status(root).probed.pi.host_load.state, "confirmed");
  attach();
  assert.equal(confirmationOf(root, "pi"), undefined);
  assert.equal(status(root).probed.pi.host_load.state, "pending");
});
