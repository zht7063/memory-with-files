import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { measure } from "../dist/context/output.js";
import { receiptSchema } from "../dist/storage/receipt.js";
import { bootstrapData, recallData, recordData } from "./contracts.ts";

const run = promisify(execFile);
const source = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(source, "dist/cli.js");
const envelope = z.object({ ok: z.literal(true), data: z.unknown() });
const caps = { max_output_bytes: 4096, max_reference_tokens: 1024 };

function budget(text: string, bytes: number, tokens: number) {
  const measured = measure(text);
  assert.ok(measured.bytes <= bytes, `${measured.bytes} bytes > ${bytes}`);
  assert.ok(measured.reference_tokens <= tokens);
  const reported = z
    .object({
      data: z.object({
        budget: z.object({
          output_bytes: z.number(),
          used_reference_tokens: z.number(),
        }),
      }),
    })
    .parse(JSON.parse(text)).data.budget;
  assert.equal(reported.output_bytes, measured.bytes);
  assert.equal(reported.used_reference_tokens, measured.reference_tokens);
}

test(
  "T10 built CLI and MCP: both bindings survive the complete project lifecycle",
  { timeout: 180_000 },
  async (t) => {
    const base = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "mwf-t10-")),
    );
    // Both shell quoting and UTF-8 paths are part of the subprocess contract.
    const root = path.join(base, "项目 memory space");
    fs.mkdirSync(root);
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const node = async (args: string[]) => {
      const result = await run(process.execPath, args, {
        cwd: root,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      assert.ok(
        result.stdout.trim(),
        `Subprocess returned no JSON: ${JSON.stringify(args)}; stderr: ${result.stderr}`,
      );
      return result.stdout.trim();
    };
    const command = async (op: string, input: Record<string, unknown> = {}) => {
      const text = await node([
        cli,
        op,
        "--root",
        root,
        "--input",
        JSON.stringify(input),
      ]);
      const result = envelope.parse(JSON.parse(text));
      return { ...result, text };
    };
    const plugin = path.join(base, "Codex 插件");
    fs.mkdirSync(plugin);
    fs.writeFileSync(
      path.join(plugin, "plugin.json"),
      JSON.stringify({ name: "mwf", version: "0.3.0" }),
    );
    fs.symlinkSync(source, path.join(plugin, "runtime"), "dir");
    const piPackage = path.join(base, "Pi 包");
    fs.symlinkSync(source, piPackage, "dir");
    const bind = async (harness: "codex" | "pi", op = "attach") => {
      const result = await command(op, {
        harness,
        plugin_root: harness === "codex" ? plugin : piPackage,
        apply: true,
      });
      // A successful configuration with a failed standalone probe is insufficient.
      z.object({
        probed: z.object({
          direct: z.literal("pass"),
          mcp: z.object({ result: z.literal("pass") }),
        }),
      }).parse(result.data);
    };
    const receipt = () =>
      receiptSchema.parse(
        JSON.parse(
          fs.readFileSync(
            path.join(root, ".mwf/local/integration.json"),
            "utf8",
          ),
        ),
      );
    const connect = async (harness: "codex" | "pi") => {
      const generation = receipt().clients[harness]!.binding_generation!;
      const client = new Client({ name: `t10-${harness}`, version: "1" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          cli,
          "mcp",
          "--root",
          root,
          "--harness",
          harness,
          "--binding-generation",
          generation,
        ],
        cwd: root,
        stderr: "pipe",
      });
      t.after(async () => {
        try {
          await client.close();
        } finally {
          await transport.close();
        }
      });
      await client.connect(transport, { timeout: 15_000 });
      assert.equal((await client.listTools()).tools.length, 8);
      return client;
    };
    const call = async (
      client: Client,
      name: string,
      args: Record<string, unknown> = {},
      ok = true,
    ) => {
      const response = await client.callTool({
        name: `mwf_${name}`,
        arguments: args,
      });
      assert.equal(response.isError, !ok, JSON.stringify(response));
      const content = z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .parse(response.content);
      assert.equal(content.length, 1);
      const text = content[0].text;
      // Require structuredContent: a text-only fallback would miss the Codex path.
      assert.ok(response.structuredContent);
      assert.deepEqual(response.structuredContent, JSON.parse(text));
      if (ok) envelope.parse(response.structuredContent);
      return { value: response.structuredContent, text };
    };
    const data = (value: unknown) => envelope.parse(value).data;
    const ids = (value: unknown) =>
      recallData.parse(data(value)).entries.map((e) => e.id);

    await command("init", { git_mode: "ignore" });
    await bind("codex");
    await bind("pi");
    const seed = recordData.parse(
      (
        await command("add", {
          type: "preference",
          title: "T10 shared lifecycle",
          summary: "T10_SHARED 中文 guidance",
          body: "T10_BODY Shared durable memory across Codex and Pi. 中文正文。".repeat(
            300,
          ),
          request_id: "t10-seed",
        })
      ).data,
    );
    let codex = await connect("codex");
    let pi = await connect("pi");
    for (const client of [codex, pi]) {
      for (const op of ["bootstrap", "recall"]) {
        const reply = await call(client, op, { query: "T10_SHARED", ...caps });
        assert.ok(ids(reply.value).includes(seed.id));
        budget(reply.text, caps.max_output_bytes, caps.max_reference_tokens);
      }
    }
    // Apply byte pressure and token pressure separately to a long body.
    for (const constrained of [
      { max_output_bytes: 1800, max_reference_tokens: 1024 },
      { max_output_bytes: 8192, max_reference_tokens: 400 },
    ]) {
      const reply = await call(codex, "get", { id: seed.id, ...constrained });
      const page = z
        .object({
          partial: z.literal(true),
          fragment: z.string(),
          omitted: z.object({ by_budget: z.number().positive() }),
        })
        .parse(data(reply.value));
      assert.ok(page.fragment.length > 0);
      budget(
        reply.text,
        constrained.max_output_bytes,
        constrained.max_reference_tokens,
      );
    }
    await call(pi, "handoff", {
      action: "save",
      task_id: "t10-task",
      expected_revision: 0,
      request_id: "t10-handoff",
      data: {
        goal: "T10 handoff 中文",
        next_action: "Resume with shared memory",
        relevant_ids: [seed.id],
      },
    });
    const handoff = await call(codex, "handoff", {
      action: "read",
      task_id: "t10-task",
      ...caps,
    });
    const page = z
      .object({
        fragment: z.string(),
        revision: z.literal(1),
        partial: z.literal(false),
      })
      .parse(data(handoff.value));
    assert.equal(JSON.parse(page.fragment).goal, "T10 handoff 中文");
    budget(handoff.text, caps.max_output_bytes, caps.max_reference_tokens);

    // execFile starts both writers before either is awaited; each uses the built CLI.
    const writers = await Promise.all(
      [0, 1].map((i) =>
        command("add", {
          type: "knowledge",
          title: `T10 writer ${i}`,
          summary: `T10_SHARED concurrent writer ${i}`,
          body: `Concurrent durable body ${i}`,
          request_id: `t10-concurrent-${i}`,
        }),
      ),
    );
    const expected = [
      seed.id,
      ...writers.map((r) => recordData.parse(r.data).id),
    ].sort();
    assert.equal(new Set(expected).size, 3);
    const verifyRecall = async (client: Client) => {
      const reply = await call(client, "recall", {
        query: "T10_SHARED",
        ...caps,
      });
      assert.deepEqual(ids(reply.value).sort(), expected);
      budget(reply.text, caps.max_output_bytes, caps.max_reference_tokens);
    };
    await verifyRecall(codex);
    await verifyRecall(pi);

    // Exercise the built adapters in a subprocess with simulated host callbacks.
    // Explicit MCP reads do not dedupe; automatic context owns epoch dedupe.
    const driver = `
    import { handleHook } from ${JSON.stringify(new URL("../dist/integrations/codex/hook.js", import.meta.url).href)};
    import extension from ${JSON.stringify(new URL("../dist/integrations/pi/index.js", import.meta.url).href)};
    const root = process.cwd();
    const limits = ${JSON.stringify(caps)};
    const hook = (event, source) => handleHook({cwd:root, session_id:'t10-codex', hook_event_name:event, source, prompt:'T10_SHARED', context_limits:limits});
    const codex = [hook('SessionStart','startup'), hook('UserPromptSubmit'), hook('SessionStart','compact'), hook('UserPromptSubmit'), hook('SessionStart','resume')];
    const handlers = new Map();
    const ctx = {cwd:root, isProjectTrusted:()=>true, sessionManager:{getSessionId:()=> 't10-pi'}, contextLimits:limits};
    extension({on:(name,fn)=>handlers.set(name,fn), registerMcpServer:()=>{}, unregisterMcpServer:()=>{}});
    const emit = name => handlers.get(name)({prompt:'T10_SHARED'},ctx);
    emit('session_start');
    const pi = [emit('before_agent_start'), emit('before_agent_start') ?? null];
    emit('session_compact');
    pi.push(emit('before_agent_start'), emit('before_agent_start') ?? null);
    emit('session_tree');
    pi.push(emit('before_agent_start'));
    console.log(JSON.stringify({codex,pi}));
  `;
    const events = z
      .object({ codex: z.array(z.unknown()), pi: z.array(z.unknown()) })
      .parse(JSON.parse(await node(["--input-type=module", "--eval", driver])));
    assert.deepEqual(events.codex[1], {});
    assert.deepEqual(events.codex[3], {});
    assert.equal(events.pi[1], null);
    assert.equal(events.pi[3], null);
    for (const i of [0, 2, 4]) {
      const codexText = z
        .object({
          hookSpecificOutput: z.object({ additionalContext: z.string() }),
        })
        .parse(events.codex[i]).hookSpecificOutput.additionalContext;
      const piText = z
        .object({ message: z.object({ content: z.string() }) })
        .parse(events.pi[i]).message.content;
      for (const text of [codexText, piText]) {
        assert.deepEqual(ids(JSON.parse(text)).sort(), expected);
        budget(text, caps.max_output_bytes, caps.max_reference_tokens);
      }
    }
    // Restarted MCP processes recover the task handoff and complete working set.
    await codex.close();
    codex = await connect("codex");
    const resumed = await call(codex, "bootstrap", {
      task_id: "t10-task",
      query: "T10_SHARED",
      ...caps,
    });
    assert.equal(
      bootstrapData.parse(data(resumed.value)).handoff?.next_action,
      "Resume with shared memory",
    );
    assert.deepEqual(ids(resumed.value).sort(), expected);
    budget(resumed.text, caps.max_output_bytes, caps.max_reference_tokens);

    for (const harness of ["codex", "pi"] as const) {
      const disabled = harness === "codex" ? codex : pi;
      const survivor = harness === "codex" ? pi : codex;
      const other = harness === "codex" ? "pi" : "codex";
      const previous = receipt().clients[harness]!.binding_generation;
      const survivorGeneration = receipt().clients[other]!.binding_generation;
      await command("detach", { harness, apply: true });
      assert.equal(receipt().clients[harness]!.enabled, false);
      const rejected = await call(
        disabled,
        "recall",
        { query: "T10_SHARED" },
        false,
      );
      z.object({
        error: z.object({ code: z.literal("INTEGRATION_DISABLED") }),
      }).parse(rejected.value);
      await verifyRecall(survivor);
      await bind(harness);
      assert.notEqual(receipt().clients[harness]!.binding_generation, previous);
      await call(disabled, "status", {}, false); // Reattachment cannot revive an old connection.
      await bind(harness, "rebind");
      assert.equal(
        receipt().clients[other]!.binding_generation,
        survivorGeneration,
      );
      await verifyRecall(survivor);
      const fresh = await connect(harness);
      await verifyRecall(fresh);
      if (harness === "codex") codex = fresh;
      else pi = fresh;
    }
    const finalHandoff = await call(pi, "handoff", {
      action: "read",
      task_id: "t10-task",
      ...caps,
    });
    assert.equal(
      z.object({ fragment: z.string() }).parse(data(finalHandoff.value))
        .fragment,
      page.fragment,
    );
    const cliRecall = await command("recall", { query: "T10_SHARED", ...caps });
    assert.deepEqual(
      recallData
        .parse(cliRecall.data)
        .entries.map((e) => e.id)
        .sort(),
      expected,
    );
    budget(cliRecall.text, caps.max_output_bytes, caps.max_reference_tokens);
  },
);
