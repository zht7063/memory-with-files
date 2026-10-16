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
  assert.equal(tools.tools.length, 15);
  assert.equal(
    tools.tools.find((t) => t.name === "mwf_recall")?.annotations?.readOnlyHint,
    true,
  );
  let reply = await client.callTool({
    name: "mwf_status",
    arguments: { project_root: other },
  });
  assert.equal(reply.isError, true);
  assert.match(JSON.stringify(reply), /ROOT_NOT_ALLOWED/);
  assert.deepEqual(fs.readdirSync(other), []);
  reply = await client.callTool({
    name: "mwf_init",
    arguments: { project_root: root, git_mode: "track" },
  });
  assert.equal(reply.isError, false);
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
    .parse(reply.structuredContent);
  assert.ok(
    result.data.matches.some((m) => m.summary === "Always verify setup"),
  );
  assert.equal(execute("doctor", { project_root: root }).ok, true);
});
