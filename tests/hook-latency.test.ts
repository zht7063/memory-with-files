// Issue #30: the Codex hook path must not load the tokenizer, and a long-lived
// MCP process must serve repeated identical recalls from a short-window cache.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execute } from "../dist/core.js";
import { RecallCache } from "../dist/context/recall-cache.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(repo, "dist/cli.js");

function tmp(t: test.TestContext, prefix: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("hook SessionStart and UserPromptSubmit never load the tokenizer and report the estimate", (t) => {
  const root = tmp(t, "mwf-hook-lazy-");
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    import { execute } from ${JSON.stringify(path.join(repo, "dist/core.js"))};
    import { lifecycle } from ${JSON.stringify(path.join(repo, "dist/lifecycle/index.js"))};
    import { handleHook } from ${JSON.stringify(path.join(repo, "dist/integrations/codex/hook.js"))};
    import { tokenizerLoaded } from ${JSON.stringify(path.join(repo, "dist/context/output.js"))};
    const root = ${JSON.stringify(root)};
    execute("init", { project_root: root, git_mode: "track" });
    lifecycle("attach", { project_root: root, harness: "pi", plugin_root: ${JSON.stringify(repo)}, apply: true });
    const file = path.join(root, ".mwf/local/integration.json");
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    receipt.clients.codex = { ...receipt.clients.pi };
    fs.writeFileSync(file, JSON.stringify(receipt));
    execute("add", { project_root: root, type: "preference", title: "Lazy", summary: "LAZY_TOKENIZER_MARK 代理设置", body: "Synthetic" });
    const base = { cwd: root, session_id: "lazy", source: "startup" };
    const start = handleHook({ ...base, hook_event_name: "SessionStart" });
    const prompt = handleHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "LAZY_TOKENIZER_MARK" });
    const budget = JSON.parse(start.hookSpecificOutput.additionalContext).data.budget;
    console.log(JSON.stringify({
      loaded: tokenizerLoaded(),
      marked: start.hookSpecificOutput.additionalContext.includes("LAZY_TOKENIZER_MARK"),
      prompt: Object.keys(prompt),
      id: budget.tokenizer_id,
      used: budget.used_reference_tokens,
      limit: budget.limit_reference_tokens,
    }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.loaded, false);
  assert.equal(out.marked, true);
  assert.equal(out.id, "approx_chars_v1");
  assert.ok(out.used > 0 && out.used <= out.limit);
});

test("RecallCache honours TTL, key order and file fingerprint", (t) => {
  const root = tmp(t, "mwf-recall-cache-");
  execute("init", { project_root: root, git_mode: "track" });
  let now = 1000;
  const cache = new RecallCache(root, 30_000, () => now);
  const key = cache.key({ query: "a", limit: 5, project_root: root });
  assert.equal(cache.get(key), undefined);
  cache.set(key, "v1");
  assert.equal(
    cache.get(cache.key({ project_root: root, limit: 5, query: "a" })),
    "v1",
  );
  assert.equal(
    cache.get(cache.key({ query: "b", project_root: root })),
    undefined,
  );
  now += 29_999;
  assert.equal(cache.get(key), "v1");
  now += 2;
  assert.equal(cache.get(key), undefined, "expired after the TTL");
  cache.set(key, "v2");
  execute("add", {
    project_root: root,
    type: "preference",
    title: "Fingerprint",
    summary: "changes the fingerprint",
    body: "Synthetic",
  });
  assert.equal(
    cache.get(cache.key({ query: "a", limit: 5, project_root: root })),
    undefined,
    "a record write changes the key",
  );
  cache.set(key, "v3");
  cache.clear();
  assert.equal(cache.get(key), undefined);
});

test("MCP recall reuses a short-window result and sees writes immediately", async (t) => {
  const root = tmp(t, "mwf-mcp-cache-");
  execute("init", { project_root: root, git_mode: "track" });
  const add = (title: string, summary: string) =>
    execute("add", {
      project_root: root,
      type: "preference",
      title,
      summary,
      body: "Synthetic",
    });
  add("Cache one", "CACHE_MARK_ONE proxy settings");
  const client = new Client({ name: "cache", version: "1" });
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
  const recall = async () => {
    const reply = await client.callTool({
      name: "mwf_recall",
      arguments: { query: "proxy settings" },
    });
    assert.equal(reply.isError, false);
    return JSON.stringify(reply.structuredContent);
  };
  const dir = path.join(root, ".mwf/preferences");
  const file = path.join(
    dir,
    fs.readdirSync(dir).find((n) => n.endsWith(".md"))!,
  );
  // Whole-second mtime so the fingerprint can be restored exactly.
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  const first = await recall();
  assert.match(first, /CACHE_MARK_ONE/);
  assert.equal(await recall(), first);
  // A file edit that keeps size and mtime is invisible to the fingerprint, so
  // the second identical recall inside the window must be served from cache.
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("CACHE_MARK_ONE", "CACHE_MARK_TWO"),
  );
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  assert.equal(await recall(), first, "served from the in-process cache");
  // Any real write (here through MCP, and externally) invalidates.
  const written = await client.callTool({
    name: "mwf_add",
    arguments: {
      type: "preference",
      title: "Cache two",
      summary: "CACHE_MARK_NEW proxy settings",
      body: "Synthetic",
      request_id: "cache-two",
    },
  });
  assert.equal(written.isError, false);
  assert.match(await recall(), /CACHE_MARK_NEW/);
  add("Cache three", "CACHE_MARK_EXTERNAL proxy settings");
  assert.match(await recall(), /CACHE_MARK_EXTERNAL/);
});

import {
  killAfterMs,
  HOOK_KILL_MS,
  STOP_HOOK_KILL_MS,
  HOOK_LOCK_BUDGET_MS,
} from "../dist/integrations/codex/timeouts.js";

test("hook timeouts are per event: hooks.json always exceeds the runner kill time of the same event", () => {
  assert.equal(killAfterMs(["node", "runner.js"]), HOOK_KILL_MS);
  assert.equal(killAfterMs(["node", "runner.js", "--stop"]), STOP_HOOK_KILL_MS);
  assert.ok(HOOK_LOCK_BUDGET_MS < HOOK_KILL_MS);
  const hooks = JSON.parse(
    fs.readFileSync(
      path.join(repo, "packaging/codex/hooks/hooks.json"),
      "utf8",
    ),
  ).hooks as Record<
    string,
    { hooks: { command: string; timeout: number }[] }[]
  >;
  for (const event of ["SessionStart", "UserPromptSubmit"])
    for (const group of hooks[event])
      for (const h of group.hooks) {
        assert.equal(h.timeout, 5, `${event} hook timeout`);
        assert.ok(h.timeout * 1000 > killAfterMs(h.command.split(/\s+/)));
      }
  // Whatever other events exist (Stop, added separately) keep a margin over the
  // kill time their command line selects.
  for (const [event, groups] of Object.entries(hooks))
    for (const group of groups)
      for (const h of group.hooks)
        assert.ok(
          h.timeout * 1000 > killAfterMs(h.command.split(/\s+/)),
          `${event}: hooks.json timeout must exceed the runner kill time`,
        );
});

test("hook path under project-lock contention fails open before the runner kill time", async (t) => {
  const root = tmp(t, "mwf-hook-lock-");
  const setup = `
    import fs from "node:fs";
    import path from "node:path";
    import { execute } from ${JSON.stringify(path.join(repo, "dist/core.js"))};
    import { lifecycle } from ${JSON.stringify(path.join(repo, "dist/lifecycle/index.js"))};
    const root = ${JSON.stringify(root)};
    execute("init", { project_root: root, git_mode: "track" });
    lifecycle("attach", { project_root: root, harness: "pi", plugin_root: ${JSON.stringify(repo)}, apply: true });
    const file = path.join(root, ".mwf/local/integration.json");
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    receipt.clients.codex = { ...receipt.clients.pi };
    fs.writeFileSync(file, JSON.stringify(receipt));
    execute("add", { project_root: root, type: "preference", title: "Busy", summary: "BUSY_MARK", body: "Synthetic" });
  `;
  const prepared = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", setup],
    { encoding: "utf8" },
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  const payload = JSON.stringify({
    cwd: root,
    session_id: "busy",
    hook_event_name: "SessionStart",
    source: "startup",
  });
  const run = () =>
    new Promise<{ ms: number; code: number | null; out: string }>((resolve) => {
      const started = Date.now();
      const child = spawn(
        process.execPath,
        [path.join(repo, "dist/integrations/codex/runner.js")],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      let out = "";
      child.stdout.on("data", (c) => (out += String(c)));
      child.on("close", (code) =>
        resolve({ ms: Date.now() - started, code, out }),
      );
      child.stdin.end(payload);
    });
  // A second process holds the project lock for 8 s (longer than any hook budget).
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(${JSON.stringify(path.join(root, ".mwf/local/runtime.sqlite"))});
       db.exec("BEGIN IMMEDIATE");
       console.log("held");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, 8000);`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  t.after(() => holder.kill("SIGKILL"));
  await new Promise<void>((resolve) =>
    holder.stdout.once("data", () => resolve()),
  );
  const busy = await run();
  assert.equal(busy.code, 0);
  assert.ok(
    busy.ms < HOOK_KILL_MS,
    `busy hook took ${busy.ms} ms, expected to fail open before ${HOOK_KILL_MS} ms`,
  );
  const notice = JSON.parse(busy.out);
  assert.match(notice.systemMessage, /not restored/);
  assert.doesNotMatch(notice.systemMessage, /timed out/);
  assert.equal(notice.hookSpecificOutput, undefined);
  // The wait was bounded by the budget, not instant: the lock was really tried.
  assert.ok(
    busy.ms >= HOOK_LOCK_BUDGET_MS - 300,
    `returned too early: ${busy.ms}`,
  );
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("close", resolve));
  const free = await run();
  assert.equal(free.code, 0);
  assert.match(
    JSON.parse(free.out).hookSpecificOutput.additionalContext,
    /BUSY_MARK/,
  );
});
