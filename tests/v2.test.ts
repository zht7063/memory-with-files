import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import { z } from "zod";
import { execute, type Result } from "../dist/core.js";
import { Transaction, withProjectLock, hash } from "../dist/storage/index.js";
import { registerSession } from "../dist/core/identity.js";
import {
  checkBinding,
  type Binding,
} from "../dist/integrations/shared/binding.js";
import { receipt } from "../dist/storage/receipt.js";
import {
  beginContext,
  prepareContext,
  finishContext,
} from "../dist/integrations/shared/context.js";
import { lifecycle } from "../dist/lifecycle/index.js";
import { measure, serialize } from "../dist/context/output.js";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function temp(t: TestContext) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-v2-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function project(t: TestContext) {
  const root = temp(t);
  execute("init", { project_root: root, git_mode: "track" });
  return root;
}
function add(root: string, args: Record<string, unknown> = {}) {
  return z.object({ id: z.string(), path: z.string() }).parse(
    execute("add", {
      project_root: root,
      type: "knowledge",
      title: "中文代理设置",
      summary: "这里记录中文代理设置流程",
      body: "详情",
      ...args,
    }).data,
  );
}
function data(r: Result) {
  return z.record(z.unknown()).parse(r.data);
}
function binding(root: string): Binding {
  lifecycle("attach", {
    project_root: root,
    harness: "pi",
    plugin_root: process.cwd(),
    apply: true,
  });
  const r = receipt(new Transaction(root))!;
  return {
    root,
    harness: "pi",
    generation: r.clients.pi!.binding_generation!,
    runtime: cli,
    cwd: root,
  };
}
function save(root: string, overrides: Record<string, unknown> = {}) {
  return execute("handoff", {
    project_root: root,
    action: "save",
    task_id: "任务/../../x",
    expected_revision: 0,
    request_id: "save",
    data: { goal: "目标", next_action: "下一步" },
    ...overrides,
  });
}
test("session and task handoffs isolate, replay before revision checks and recover after interruption", (t) => {
  const root = project(t);
  const refs = withProjectLock(root, () => {
    const tx = new Transaction(root);
    const refs = ["A", "B"].map(
      (id) => registerSession(tx, "codex", id).session_ref,
    );
    tx.commit();
    return refs;
  });
  for (const [i, ref] of refs.entries())
    save(root, {
      task_id: undefined,
      session_ref: ref,
      request_id: ref,
      data: { goal: "Goal " + i, next_action: "next" },
    });
  assert.notDeepEqual(
    data(execute("bootstrap", { project_root: root, session_ref: refs[0] }))
      .handoff,
    data(execute("bootstrap", { project_root: root, session_ref: refs[1] }))
      .handoff,
  );
  save(root);
  assert.equal(save(root).replayed, true);
  assert.throws(
    () => save(root, { request_id: "different" }),
    /Current revision: 1/,
  );
  assert.throws(
    () =>
      save(root, {
        request_id: "invalid-ref",
        task_id: undefined,
        session_ref: "s_" + "0".repeat(64),
      }),
    /reference/,
  );
  assert.throws(
    () => save(root, { request_id: "no-scope", task_id: undefined }),
    /task_id/,
  );
  assert.equal(fs.existsSync(path.join(root, "x")), false);
  const input = {
    project_root: root,
    action: "save",
    task_id: "crash",
    expected_revision: 0,
    request_id: "crash",
    data: { goal: "Recover", next_action: "read" },
  };
  assert.throws(
    () =>
      execute("handoff", input, {
        fault(stage) {
          if (stage === "applied:0") throw Error("interrupted");
        },
      }),
    /interrupted/,
  );
  assert.equal(execute("handoff", input).replayed, true);
  assert.throws(
    () =>
      save(root, {
        task_id: "large",
        request_id: "large",
        data: { goal: "x".repeat(2001), next_action: "n" },
      }),
    /2000/,
  );
});
test("record pages preserve 200k code points, budgets measure final text, and edited cursors fail", (t) => {
  const root = project(t);
  const body = "中😀ab".repeat(50000);
  const r = add(root, { body });
  const expected = "# 中文代理设置\n\n" + body;
  let joined = "",
    cursor: unknown = undefined,
    first: unknown;
  do {
    const result = execute("get", {
      project_root: root,
      id: r.id,
      cursor,
      max_reference_tokens: 8192,
      max_output_bytes: 65536,
    });
    const d = data(result);
    first ??= d.cursor;
    joined += d.fragment;
    cursor = d.cursor ?? undefined;
    const b = z
      .object({ used_reference_tokens: z.number(), output_bytes: z.number() })
      .parse(d.budget);
    assert.deepEqual(measure(serialize(result)), {
      reference_tokens: b.used_reference_tokens,
      bytes: b.output_bytes,
    });
    assert.ok(b.used_reference_tokens <= 8192 && b.output_bytes <= 65536);
  } while (cursor);
  assert.equal(joined, expected);
  fs.appendFileSync(path.join(root, r.path), "\nchanged");
  assert.throws(
    () => execute("get", { project_root: root, id: r.id, cursor: first }),
    /changed/,
  );
  assert.throws(
    () => execute("get", { project_root: root, id: r.id, max_output_bytes: 1 }),
    /Budget/,
  );
});
test("retrieval filters status and path, matches Chinese, and separates invalid boundaries", (t) => {
  const root = project(t),
    r = add(root);
  const candidate = add(root, { status: "candidate", title: "Candidate" });
  add(root, { title: "Tool", scope: { tools: ["ts", "bun"] } });
  add(root, { title: "Scoped", scope: { paths: ["src/**"] } });
  const getEntries = (args: Record<string, unknown>) =>
    z
      .array(z.record(z.unknown()))
      .parse(data(execute("recall", { project_root: root, ...args })).entries);
  const entries = getEntries({ query: "代理设置", path: "docs/a.md" });
  assert.ok(entries.some((e) => e.id === r.id));
  assert.ok(!entries.some((e) => e.id === candidate.id));
  assert.ok(
    !entries.some((e) =>
      (e.reasons as string[]).some((x) => x.startsWith("tools:")),
    ),
  );
  const misses = getEntries({ query: "tests bundle" });
  assert.ok(
    !misses.some((e) =>
      (e.reasons as string[]).some((x) => x.startsWith("tools:")),
    ),
  );
  assert.throws(
    () => execute("get", { project_root: root, id: candidate.id }),
    /eligible/,
  );
  assert.ok(getEntries({ mode: "review" }).some((e) => e.id === candidate.id));
  const incident = add(root, {
    type: "incident",
    title: "Incident",
    body: "## Invalid when\n不适用条件",
  });
  const e = getEntries({}).find((e) => e.id === incident.id)!;
  assert.equal(e.complete, false);
  assert.deepEqual(e.boundaries, { invalid_when: "不适用条件" });
  assert.match(
    JSON.stringify(execute("doctor", { project_root: root })),
    /boundaries/,
  );
  const chinese = add(root, {
    type: "incident",
    title: "中文边界",
    body: "## 适用条件\n代理版本 1\n## 失效条件\n代理版本 2",
  });
  assert.deepEqual(
    getEntries({}).find((e) => e.id === chinese.id)!.boundaries,
    { applicability: "代理版本 1", invalid_when: "代理版本 2" },
  );
  const extensionOnly = add(root, {
    type: "incident",
    title: "Converter",
    summary: "converter issue",
    scope: { file_types: [".docx"], operations: ["convert"] },
    body: "## Applicability\nOnly convert\n## Invalid when\nVersion changes",
  });
  assert.ok(
    !getEntries({ query: "unrelated", path: "report.docx" }).some(
      (e) => e.id === extensionOnly.id,
    ),
  );
  const long = add(root, {
    type: "incident",
    title: "Large",
    body:
      "## Applicability\n" +
      "条件".repeat(6000) +
      "\n## Invalid when\nVersion changes",
  });
  const bounded = getEntries({ max_reference_tokens: 1024 });
  assert.ok(!bounded.some((e) => e.id === long.id));
});
test("content hash prevents overwriting external edits but completed retry still replays", (t) => {
  const root = project(t),
    r = add(root);
  const input = {
    project_root: root,
    id: r.id,
    expected_content_hash: hash(
      fs.readFileSync(path.join(root, r.path), "utf8"),
    ),
    body: "new",
    request_id: "update",
    apply: true,
  };
  execute("update", input);
  assert.equal(execute("update", input).replayed, true);
  assert.throws(
    () => execute("update", { ...input, request_id: "new" }),
    /Record changed/,
  );
});
test("binding refuses copied projects, nested disabled roots and revoked generations", (t) => {
  const root = project(t),
    b = binding(root),
    copy = temp(t);
  fs.cpSync(root, copy, { recursive: true });
  assert.throws(
    () => checkBinding(new Transaction(root), { ...b, cwd: copy }),
    /Host project/,
  );
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  execute("init", { project_root: nested, git_mode: "track" });
  assert.throws(
    () => checkBinding(new Transaction(root), { ...b, cwd: nested }),
    /Host project/,
  );
  lifecycle("detach", {
    project_root: root,
    harness: "pi",
    plugin_root: process.cwd(),
    apply: true,
  });
  assert.throws(() => checkBinding(new Transaction(root), b), /disabled/);
  binding(root);
  assert.throws(() => checkBinding(new Transaction(root), b), /revoked/);
  assert.equal(execute("bootstrap", { project_root: root }).ok, true);
});
test("epoch output reserves atomically, deduplicates, releases only known failures and restores on reset", (t) => {
  const root = project(t),
    b = binding(root);
  add(root);
  const ref = beginContext(b, "host", true);
  const first = prepareContext(b, ref, "", true)!;
  assert.ok(first);
  assert.equal(prepareContext(b, ref), null);
  finishContext(b, ref, first.id, "failed");
  const retry = prepareContext(b, ref)!;
  assert.ok(retry);
  finishContext(b, ref, retry.id, "unknown");
  assert.equal(prepareContext(b, ref), null);
  beginContext(b, "host", true);
  assert.ok(prepareContext(b, ref));
  const state = JSON.parse(
    fs.readFileSync(
      path.join(root, `.mwf/local/contexts/${ref}-state.json`),
      "utf8",
    ),
  );
  assert.ok(state.used <= 8192);
});
test("handoff list and legacy pages are bounded and continue without omissions", (t) => {
  const root = project(t);
  for (let i = 0; i < 25; i++)
    save(root, { task_id: "task-" + i, request_id: "id-" + i });
  let cursor: unknown = undefined;
  const found: string[] = [];
  do {
    const d = data(
      execute("handoff", {
        project_root: root,
        action: "list",
        cursor,
        max_output_bytes: 1500,
      }),
    );
    for (const e of z
      .array(z.object({ scope: z.object({ id: z.string() }) }))
      .parse(d.entries))
      found.push(e.scope.id);
    cursor = d.cursor ?? undefined;
  } while (cursor);
  assert.equal(new Set(found).size, 25);
  assert.equal(found.length, 25);
  fs.writeFileSync(path.join(root, ".mwf/handoff.md"), "旧😀".repeat(10000));
  assert.equal(
    data(execute("bootstrap", { project_root: root })).handoff,
    null,
  );
  const d = data(
    execute("handoff", { project_root: root, action: "read", legacy: true }),
  );
  assert.equal(d.partial, true);
});
test("CLI errors share API envelope and leave stderr for diagnostics", (t) => {
  const root = project(t),
    r = spawnSync(
      process.execPath,
      [cli, "get", "--root", root, "--id", "absent"],
      { encoding: "utf8" },
    );
  assert.equal(r.status, 2);
  const v = JSON.parse(r.stdout);
  assert.equal(v.api_version, 2);
  assert.equal(v.error.code, "NOT_FOUND");
});

test("concurrent task saves commit once and concurrent context reservations stay within epoch", async (t) => {
  const root = project(t);
  const b = binding(root);
  const ref = beginContext(b, "concurrent-host", false);
  for (let i = 0; i < 12; i++)
    add(root, { title: `Memory ${i}`, summary: "并发上下文预算 ".repeat(40) });
  const coreURL = new URL("../dist/core.js", import.meta.url).href;
  const contextURL = new URL(
    "../dist/integrations/shared/context.js",
    import.meta.url,
  ).href;
  async function child(source: string) {
    return new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", source], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "",
        err = "";
      p.stdout.on("data", (v) => (out += v));
      p.stderr.on("data", (v) => (err += v));
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0 ? resolve(out.trim()) : reject(new Error(err)),
      );
    });
  }
  const saves = await Promise.all(
    [0, 1].map((i) =>
      child(
        `import {execute} from ${JSON.stringify(coreURL)};try { execute('handoff',${JSON.stringify({ project_root: root, action: "save", task_id: "race", expected_revision: 0, request_id: `race-${i}`, data: { goal: `writer ${i}`, next_action: "Continue" } })});console.log('saved');}catch(e){console.log(e.code);}`,
      ),
    ),
  );
  assert.equal(saves.filter((v) => v === "saved").length, 1);
  assert.equal(saves.filter((v) => v === "HANDOFF_CONFLICT").length, 1);
  await Promise.all(
    Array.from({ length: 6 }, () =>
      child(
        `import {prepareContext} from ${JSON.stringify(contextURL)};for (let i = 0; ; i++) { try { prepareContext(${JSON.stringify(b)},${JSON.stringify(ref)},'并发上下文预算',true); break; } catch (e) { if (e.code !== 'BUSY' || i >= 5) throw e; } }`,
      ),
    ),
  );
  const state = JSON.parse(
    fs.readFileSync(
      path.join(root, `.mwf/local/contexts/${ref}-state.json`),
      "utf8",
    ),
  );
  assert.ok(state.used <= 8192);
  assert.equal(
    state.used,
    state.outputs.reduce(
      (sum: number, o: { tokens: number }) => sum + o.tokens,
      0,
    ),
  );
  const keys = state.outputs.flatMap((o: { keys: string[] }) => o.keys);
  assert.equal(keys.length, new Set(keys).size);
});

test("hook failure notices persist per session and category without following symlinks", async (t) => {
  const { failureNotice } = await import(
    "../dist/integrations/codex/notice.js"
  );
  const root = project(t),
    input = { cwd: root, session_id: "host-a" };
  assert.deepEqual(failureNotice(input, "timeout", "failed"), {
    systemMessage: "failed",
  });
  assert.deepEqual(failureNotice(input, "timeout", "failed"), {});
  assert.deepEqual(failureNotice(input, "read-failed", "failed"), {
    systemMessage: "failed",
  });
  assert.deepEqual(
    failureNotice({ ...input, session_id: "host-b" }, "timeout", "failed"),
    { systemMessage: "failed" },
  );
  const other = project(t),
    outside = temp(t);
  fs.symlinkSync(outside, path.join(other, ".mwf/local/hook-notices"));
  failureNotice({ cwd: other, session_id: "host-a" }, "timeout", "failed");
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("status and doctor inspect runtime, binding and ownership without inventing probes", (t) => {
  const root = project(t);
  assert.deepEqual(
    data(execute("status", { project_root: root })).installed,
    {},
  );
  const b = binding(root);
  const status = () => data(execute("status", { project_root: root })) as any;
  assert.equal(status().installed.pi.valid, true);
  assert.equal(status().configured.pi.valid, true);
  assert.equal(status().probed.pi.direct, "unknown");
  const file = path.join(root, ".mwf/local/integration.json");
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  r.clients.pi.probe = {
    source: "test_standalone",
    time: new Date().toISOString(),
    root,
    runtime_path: b.runtime,
    runtime_version: "0.4.0",
    api_version: 2,
    binding_generation: b.generation,
    direct: "pass",
    mcp: { result: "fail" },
  };
  fs.writeFileSync(file, JSON.stringify(r));
  assert.equal(status().probed.pi.mcp.result, "fail");
  r.clients.pi.runtime_path += ".missing";
  fs.writeFileSync(file, JSON.stringify(r));
  assert.equal(status().installed.pi.valid, false);
  assert.equal(status().probed.pi.direct, "unknown");
  assert.equal(execute("doctor", { project_root: root }).ok, false);
  r.clients.pi.enabled = false;
  fs.writeFileSync(file, JSON.stringify(r));
  assert.equal(execute("doctor", { project_root: root }).ok, true);
  r.clients.pi.enabled = true;
  r.clients.pi.runtime_path = b.runtime;
  r.clients.pi.owned_resources = [
    {
      kind: "file",
      path: ".pi/extensions/mwf.js",
      installed_hash: "wrong",
      before: null,
    },
  ];
  r.receipt_version = 2;
  fs.writeFileSync(file, JSON.stringify(r));
  assert.ok(status().errors.includes("LEGACY_RESOURCE_PENDING"));
  assert.equal(execute("doctor", { project_root: root }).ok, false);
});

test("session diagnostics are bounded, complete and isolated", (t) => {
  const root = project(t),
    b = binding(root);
  add(root);
  const ref = beginContext(b, "diagnostic-session", false);
  const other = beginContext(b, "other-session", false);
  const output = prepareContext(b, ref, "", true)!;
  for (let i = 0; i < 105; i++) finishContext(b, ref, output.id, "submitted");
  const status = data(
    execute("status", { project_root: root, session_ref: ref }),
  ) as any;
  assert.equal(status.session_observed.diagnostics.length, 5);
  assert.equal(
    (
      data(
        execute("status", {
          project_root: root,
          session_ref: ref,
          diagnostic_limit: 100,
        }),
      ).session_observed as any
    ).diagnostics.length,
    100,
  );
  const event = status.session_observed.last_event;
  assert.equal(event.client, "pi");
  assert.equal(event.session_ref, ref);
  assert.equal(event.epoch, output.epoch);
  assert.equal(event.runtime_version, "0.4.0");
  assert.equal(event.api_version, 2);
  assert.equal(event.result_code, "submitted");
  assert.equal(event.entry_count, 1);
  assert.ok(Date.parse(event.at));
  assert.ok(event.hash && event.reference_tokens > 0 && event.bytes > 0);
  assert.equal(
    data(execute("status", { project_root: root })).session_observed,
    "unknown",
  );
  const isolated = data(
    execute("doctor", { project_root: root, session_ref: other }),
  ) as any;
  assert.equal(isolated.session_observed.last_event, null);
  assert.equal(JSON.stringify(event).includes("详情"), false);
});

test("doctor checks Codex owned configuration and reports copied root bindings", (t) => {
  const root = project(t);
  binding(root);
  const receiptPath = path.join(root, ".mwf/local/integration.json");
  const initial = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  const owned =
    '# mwf:mcp:start\n[mcp_servers.mwf]\ncommand = "node"\n# mwf:mcp:end';
  initial.clients.codex = {
    ...initial.clients.pi,
    owned_resources: [
      {
        kind: "block",
        path: ".codex/config.toml",
        installed: owned,
        created: true,
      },
    ],
  };
  fs.mkdirSync(path.join(root, ".codex"));
  fs.writeFileSync(path.join(root, ".codex/config.toml"), owned);
  fs.writeFileSync(receiptPath, JSON.stringify(initial));
  assert.equal(execute("doctor", { project_root: root }).ok, true);
  const configFile = path.join(root, ".codex/config.toml");
  const original = fs.readFileSync(configFile, "utf8");
  fs.writeFileSync(configFile, original + "\n[unrelated]\nvalue = true\n");
  assert.equal(execute("doctor", { project_root: root }).ok, true);
  fs.writeFileSync(
    configFile,
    original.replace("command = ", "changed_command = "),
  );
  assert.equal(execute("doctor", { project_root: root }).ok, false);
  fs.writeFileSync(configFile, original);
  const file = path.join(root, ".mwf/local/integration.json");
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  r.canonical_root = path.join(root, "other");
  fs.writeFileSync(file, JSON.stringify(r));
  const status = data(execute("status", { project_root: root })) as any;
  assert.ok(status.configured.codex.issues.includes("ROOT_MISMATCH"));
  assert.equal(execute("doctor", { project_root: root }).ok, false);
});
test("automatic context skips empty and trimmed bootstrap and respects host limits", (t) => {
  const root = project(t),
    b = binding(root);
  const ref = beginContext(b, "limits", true);
  assert.equal(prepareContext(b, ref, "", true), null);
  add(root, { type: "preference", summary: "预算约束" });
  assert.equal(prepareContext(b, ref, "", true, { max_output_bytes: 1 }), null);
  assert.equal(
    prepareContext(b, ref, "", true, { max_reference_tokens: 1 }),
    null,
  );
  const output = prepareContext(b, ref, "", true, {
    max_reference_tokens: 900,
    max_output_bytes: 7000,
  })!;
  assert.ok(output);
  assert.ok(measure(output.text).reference_tokens <= 900);
  assert.ok(measure(output.text).bytes <= 7000);
  assert.equal(JSON.parse(output.text).data.budget.max_output_bytes, 7000);
});
test("resumed pending becomes unknown without releasing charge; updates and explicit bodies remain readable", (t) => {
  const root = project(t),
    b = binding(root);
  const record = add(root, { type: "preference" });
  const ref = beginContext(b, "recovery", true);
  const output = prepareContext(b, ref, "", true)!;
  const readState = () =>
    JSON.parse(
      fs.readFileSync(
        path.join(root, `.mwf/local/contexts/${ref}-state.json`),
        "utf8",
      ),
    );
  const before = readState();
  beginContext(b, "recovery", false);
  const resumed = readState();
  assert.equal(resumed.epoch, before.epoch);
  assert.equal(resumed.outputs[0].status, "unknown");
  assert.equal(resumed.used, before.used);
  assert.equal(resumed.bytes, before.bytes);
  assert.equal(prepareContext(b, ref, "", true), null);
  assert.equal(execute("get", { project_root: root, id: record.id }).ok, true);
  const file = path.join(root, record.path);
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace("这里记录中文代理设置流程", "更新后的摘要"),
  );
  assert.match(prepareContext(b, ref, "", true)!.text, /更新后的摘要/);
  finishContext(b, ref, output.id, "failed");
  assert.equal(
    readState().used,
    readState().outputs.reduce(
      (sum: number, o: { tokens: number }) => sum + o.tokens,
      0,
    ),
  );
  beginContext(b, "recovery", true);
  assert.notEqual(readState().epoch, before.epoch);
  assert.equal(readState().used, 0);
  assert.equal(readState().bytes, 0);
});
test("Codex lifecycle sources rebuild epochs and forward host budgets", async (t) => {
  const { handleHook } = await import("../dist/integrations/codex/hook.js");
  const root = project(t);
  // Seed a validated receipt: this unit test exercises hook state, not packaging.
  binding(root);
  const receiptFile = path.join(root, ".mwf/local/integration.json");
  const installed = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  installed.clients.codex = { ...installed.clients.pi };
  fs.writeFileSync(receiptFile, JSON.stringify(installed));
  add(root, { type: "preference" });
  let previous: string | undefined;
  for (const source of [
    "startup",
    "compact",
    "resume",
    "clear",
    "replacement",
  ]) {
    const input = {
      cwd: root,
      session_id: "codex",
      hook_event_name: "SessionStart",
      source,
    };
    const response = handleHook(input);
    const output = JSON.parse(
      response.hookSpecificOutput!.additionalContext,
    ).data;
    assert.notEqual(output.epoch, previous);
    previous = output.epoch;
    assert.deepEqual(
      handleHook({ ...input, hook_event_name: "UserPromptSubmit" }),
      {},
    );
    assert.deepEqual(
      handleHook({ ...input, context_limits: { max_output_bytes: 1 } }),
      {},
    );
  }
});

test("real Git worktrees isolate identical task IDs and session mappings", (t) => {
  const base = temp(t);
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(repo, "init");
  git(
    repo,
    "-c",
    "user.name=MWF Test",
    "-c",
    "user.email=mwf@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const roots = ["甲 worktree", "乙 worktree"].map((name, i) => {
    const root = path.join(base, name);
    git(repo, "worktree", "add", "-b", `test-${i}`, root);
    assert.equal(fs.statSync(path.join(root, ".git")).isFile(), true);
    execute("init", { project_root: root, git_mode: "ignore" });
    return fs.realpathSync(root);
  });
  assert.equal(
    git(roots[0], "rev-parse", "HEAD"),
    git(roots[1], "rev-parse", "HEAD"),
  );
  const refs = roots.map((root, i) => {
    const tx = new Transaction(root);
    const ref = registerSession(tx, "codex", "same-host-session").session_ref;
    tx.commit();
    save(root, {
      task_id: "shared-task",
      session_ref: ref,
      request_id: "same-request",
      data: { goal: `Worktree ${i}`, next_action: `Next ${i}` },
    });
    return ref;
  });
  assert.notEqual(refs[0], refs[1]);
  for (const [i, root] of roots.entries()) {
    const listed = z
      .object({
        entries: z.array(
          z.object({
            scope: z.object({ kind: z.literal("task"), id: z.string() }),
            revision: z.number(),
          }),
        ),
      })
      .parse(execute("handoff", { project_root: root, action: "list" }).data);
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0].revision, 1);
    const read = data(
      execute("handoff", {
        project_root: root,
        action: "read",
        target_scope: listed.entries[0].scope,
      }),
    );
    const page = z
      .object({
        fragment: z.string(),
        cursor: z.null(),
        partial: z.literal(false),
        revision: z.literal(1),
      })
      .parse(read);
    assert.deepEqual(JSON.parse(page.fragment), {
      goal: `Worktree ${i}`,
      next_action: `Next ${i}`,
      completed: [],
      decisions: [],
      blockers: [],
      relevant_ids: [],
    });
    assert.equal(
      z
        .object({ handoff: z.object({ next_action: z.string() }) })
        .parse(
          execute("bootstrap", { project_root: root, task_id: "shared-task" })
            .data,
        ).handoff.next_action,
      `Next ${i}`,
    );
    assert.throws(
      () =>
        save(root, {
          task_id: "shared-task",
          session_ref: refs[1 - i],
          expected_revision: 1,
          request_id: "cross-worktree",
        }),
      { code: "CONTEXT_REQUIRED" },
    );
  }
});

test("session registration rejects corrupt persisted mappings without replacing them", (t) => {
  const root = project(t);
  const tx = new Transaction(root);
  const identity = registerSession(tx, "codex", "resume");
  tx.commit();
  const file = path.join(
    root,
    `.mwf/local/contexts/${identity.session_ref}.json`,
  );
  for (const raw of [
    "",
    "{",
    JSON.stringify({ ...identity, session_key: "0".repeat(64) }),
  ]) {
    fs.writeFileSync(file, raw);
    assert.throws(
      () => registerSession(new Transaction(root), "codex", "resume"),
      {
        code: "CONTEXT_REQUIRED",
        message: raw.includes("session_key")
          ? "Session mapping conflicts"
          : "Session reference is missing or belongs to another project.",
      },
    );
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
});

test("status and doctor accept an installed runtime matching its receipt at a different CLI version", (t) => {
  const root = project(t);
  binding(root);
  const runtime = path.join(temp(t), "runtime");
  fs.mkdirSync(path.join(runtime, "dist"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "dist/cli.js"), "");
  fs.writeFileSync(
    path.join(runtime, "package.json"),
    JSON.stringify({ name: "@zht7063/mwf", version: "0.9.0" }),
  );
  const file = path.join(root, ".mwf/local/integration.json");
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  r.clients.pi.runtime_path = path.join(runtime, "dist/cli.js");
  r.clients.pi.runtime_version = "0.9.0";
  fs.writeFileSync(file, JSON.stringify(r));
  for (const op of ["status", "doctor"] as const) {
    const result = execute(op, { project_root: root });
    assert.equal((data(result).installed as any).pi.valid, true);
    assert.equal(result.ok, true);
  }
  r.clients.pi.runtime_version = "0.4.0";
  fs.writeFileSync(file, JSON.stringify(r));
  assert.equal(
    (data(execute("status", { project_root: root })).installed as any).pi.valid,
    false,
  );
});

test("explicit recall requires relevance while bootstrap preserves and deduplicates the working set", (t) => {
  const root = project(t),
    b = binding(root);
  const seed = add(root, {
    title: "quasar routing",
    summary: "quasar routing constraints",
  });
  const ref = beginContext(b, "unrelated", true);
  for (const query of ["gardening", "  gardening  "])
    assert.deepEqual(
      data(execute("recall", { project_root: root, query })).entries,
      [],
    );
  for (const query of ["", "   ", "quasar"])
    assert.ok(
      (
        data(execute("recall", { project_root: root, query })).entries as any[]
      ).some((entry) => entry.id === seed.id),
    );
  for (const query of ["", "gardening"])
    assert.ok(
      (
        data(execute("bootstrap", { project_root: root, query }))
          .entries as any[]
      ).some((entry) => entry.id === seed.id),
    );
  const output = prepareContext(b, ref, "", true)!;
  assert.match(output.text, /quasar routing/);
  finishContext(b, ref, output.id, "submitted");
  assert.equal(prepareContext(b, ref, ""), null);
  assert.equal(prepareContext(b, ref, "", true), null);
  beginContext(b, "unrelated", true);
  assert.ok(prepareContext(b, ref, "", true));
});

test("get and handoff pages count truncation under either output budget", (t) => {
  const root = project(t);
  const record = add(root, { body: "long memory content ".repeat(1000) });
  assert.equal(
    save(root, {
      data: {
        goal: "long handoff content ".repeat(90),
        completed: Array(10).fill("additional content ".repeat(40)),
        next_action: "continue",
      },
    }).ok,
    true,
  );
  for (const budget of [
    { max_reference_tokens: 700 },
    { max_output_bytes: 2200 },
  ]) {
    for (const [op, args] of [
      ["get", { id: record.id }],
      ["handoff", { action: "read", task_id: "任务/../../x" }],
    ] as const) {
      const first = data(
        execute(op, { project_root: root, ...args, ...budget }),
      );
      assert.equal(first.partial, true);
      assert.equal((first.omitted as any).by_budget, 1);
      assert.equal(typeof first.cursor, "string");
      const last = data(
        execute(op, {
          project_root: root,
          ...args,
          max_reference_tokens: 8192,
          max_output_bytes: 65536,
          cursor: first.cursor,
        }),
      );
      assert.equal(last.partial, false);
      assert.equal((last.omitted as any).by_budget, 0);
    }
  }
});

test("detached runtime status is disabled even after its runtime disappears", (t) => {
  const root = project(t);
  binding(root);
  lifecycle("detach", { project_root: root, harness: "pi", apply: true });
  const file = path.join(root, ".mwf/local/integration.json");
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  r.clients.pi.runtime_path = path.join(root, "removed-runtime/cli.js");
  fs.writeFileSync(file, JSON.stringify(r));
  const status = data(execute("status", { project_root: root })) as any;
  assert.deepEqual(status.installed.pi, { enabled: false });
  assert.deepEqual(status.configured.pi, {
    enabled: false,
    valid: true,
    issues: [],
  });
  assert.equal(execute("doctor", { project_root: root }).ok, true);
});
