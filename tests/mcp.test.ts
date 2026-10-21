import test from "node:test";
import { z } from "zod";
import { bootstrapData } from "./contracts.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execute } from "../dist/core.js";
import { spawnSync } from "node:child_process";
import { Transaction } from "../dist/storage.js";
import { receipt } from "../dist/integrations/shared/binding.js";
import { identitySchema } from "../dist/core/identity.js";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
test("real stdio tool calls validate roots, perform writes and return scoped bootstrap", async (t) => {
  const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "mwf-mcp-")),
    ),
    other = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "mwf-other-")),
    );
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
  const client = new Client({ name: "acceptance", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--root", root],
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
    await transport.close();
  });
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  assert.equal(
    tools.tools.find((t) => t.name === "mwf_recall")?.annotations?.readOnlyHint,
    true,
  );
  let reply = await client.callTool({
    name: "mwf_status",
    arguments: { project_root: other },
  });
  assert.equal(reply.isError, true);
  assert.match(JSON.stringify(reply), /ROOT_MISMATCH/);
  assert.deepEqual(fs.readdirSync(other), []);
  execute("init", { project_root: root, git_mode: "track" });
  reply = await client.callTool({
    name: "mwf_add",
    arguments: {
      project_root: root,
      type: "preference",
      title: "Use deterministic setup",
      summary: "Always verify setup",
      body: "## Guidance\nVerify actual bootstrap.",
      request_id: "mcp-write",
    },
  });
  assert.equal(reply.isError, false);
  reply = await client.callTool({
    name: "mwf_bootstrap",
    arguments: { project_root: root, query: "setup" },
  });
  assert.equal(reply.isError, false);
  const result = z
    .object({ data: bootstrapData })
    .parse(
      JSON.parse(
        z
          .array(z.object({ type: z.literal("text"), text: z.string() }))
          .parse(reply.content)[0].text,
      ),
    );
  assert.ok(
    result.data.entries.some((m) => m.summary === "Always verify setup"),
  );
  assert.equal(execute("doctor", { project_root: root }).ok, true);
});

test("exited Codex hook persists identity for a new MCP process and rejects invalid save references", async (t) => {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-session-mcp-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../", import.meta.url));
  const plugin = path.join(base, "plugin");
  const runtime = path.join(plugin, "runtime");
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
  const pkg = JSON.parse(
    fs.readFileSync(path.join(runtime, "package.json"), "utf8"),
  );
  fs.writeFileSync(
    path.join(plugin, "plugin.json"),
    JSON.stringify({ name: "mwf", version: pkg.version }),
  );
  const roots = ["项目 A", "项目 B"].map((name) => {
    const root = path.join(base, name);
    fs.mkdirSync(root);
    execute("init", { project_root: root, git_mode: "ignore" });
    const attached = spawnSync(
      process.execPath,
      [
        path.join(runtime, "dist/cli.js"),
        "attach",
        "--root",
        root,
        "--harness",
        "codex",
        "--plugin-root",
        plugin,
        "--apply",
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    if (attached.error) throw attached.error;
    assert.equal(attached.status, 0, attached.stderr);
    assert.equal(JSON.parse(attached.stdout).ok, true);
    return root;
  });
  const runHook = (root: string) => {
    const child = spawnSync(
      process.execPath,
      [path.join(runtime, "dist/integrations/codex/worker.js")],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
        input: JSON.stringify({
          cwd: root,
          session_id: "same-host-session",
          hook_event_name: "SessionStart",
        }),
      },
    );
    if (child.error) throw child.error;
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {});
    const files = fs
      .readdirSync(path.join(root, ".mwf/local/contexts"))
      .filter((name) => /^s_[a-f0-9]{64}\.json$/.test(name));
    assert.equal(files.length, 1);
    return identitySchema.parse(
      JSON.parse(
        fs.readFileSync(
          path.join(root, ".mwf/local/contexts", files[0]),
          "utf8",
        ),
      ),
    );
  };
  // Both hook workers have exited before any MCP connection is created.
  const [identity, foreign] = roots.map(runHook);
  assert.notEqual(identity.session_ref, foreign.session_ref);
  const root = roots[0];
  const generation = receipt(new Transaction(root))!.clients.codex!
    .binding_generation!;
  const client = new Client({ name: "session-acceptance", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(runtime, "dist/cli.js"),
      "mcp",
      "--root",
      root,
      "--harness",
      "codex",
      "--binding-generation",
      generation,
    ],
    cwd: root,
    stderr: "pipe",
  });
  t.after(async () => {
    await client.close();
    await transport.close();
  });
  await client.connect(transport);
  const call = async (args: Record<string, unknown>, ok = true) => {
    const reply = await client.callTool({
      name: "mwf_handoff",
      arguments: { project_root: root, ...args },
    });
    assert.equal(reply.isError, !ok);
    const text = z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .parse(reply.content)[0].text;
    const value = z
      .object({
        ok: z.boolean(),
        data: z.unknown().optional(),
        error: z.object({ code: z.string() }).optional(),
      })
      .parse(JSON.parse(text));
    if (!ok) assert.equal(value.error?.code, "CONTEXT_REQUIRED");
    return value.data;
  };
  const saved = z
    .object({
      scope: z.object({ kind: z.literal("session"), id: z.string() }),
      revision: z.number(),
    })
    .parse(
      await call({
        action: "save",
        session_ref: identity.session_ref,
        expected_revision: 0,
        request_id: "persisted-session",
        data: {
          goal: "Persist across processes",
          next_action: "Continue from MCP",
        },
      }),
    );
  assert.equal(saved.scope.id, identity.session_key);
  // Handoff reads use the same fragment/cursor contract as record pages.
  const read = z
    .object({
      fragment: z.string(),
      cursor: z.null(),
      partial: z.literal(false),
      revision: z.number(),
    })
    .passthrough()
    .parse(await call({ action: "read", session_ref: identity.session_ref }));
  assert.equal(read.revision, saved.revision);
  assert.deepEqual(JSON.parse(read.fragment), {
    goal: "Persist across processes",
    next_action: "Continue from MCP",
    completed: [],
    decisions: [],
    blockers: [],
    relevant_ids: [],
  });
  // Keep the full list response for the final unchanged-state comparison.
  const listedRaw = await call({ action: "list" });
  const listed = z
    .object({
      entries: z.array(
        z.object({ scope: z.object({ kind: z.string(), id: z.string() }) }),
      ),
    })
    .parse(listedRaw);
  assert.deepEqual(
    listed.entries.map((item) => item.scope),
    [saved.scope],
  );
  assert.deepEqual(
    await call({ action: "read", target_scope: listed.entries[0].scope }),
    await call({ action: "read", session_ref: identity.session_ref }),
  );
  const forged = "s_" + "f".repeat(64);
  fs.writeFileSync(
    path.join(root, `.mwf/local/contexts/${forged}.json`),
    JSON.stringify({ ...identity, session_ref: forged }),
  );
  // A copied mapping must still fail its canonical-root and reference checks.
  fs.copyFileSync(
    path.join(roots[1], `.mwf/local/contexts/${foreign.session_ref}.json`),
    path.join(root, `.mwf/local/contexts/${foreign.session_ref}.json`),
  );
  for (const [i, ref] of [
    "invalid",
    "s_" + "0".repeat(64),
    foreign.session_ref,
    forged,
  ].entries()) {
    for (const task of [false, true])
      await call(
        {
          action: "save",
          session_ref: ref,
          ...(task ? { task_id: "explicit-task" } : {}),
          expected_revision: 0,
          request_id: `rejected-${i}-${task}`,
          data: { goal: "Rejected", next_action: "Do not save" },
        },
        false,
      );
  }
  assert.deepEqual(
    await call({ action: "read", session_ref: identity.session_ref }),
    read,
  );
  assert.deepEqual(await call({ action: "list" }), listedRaw);
});
