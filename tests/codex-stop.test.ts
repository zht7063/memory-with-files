import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { execute } from "../dist/core.js";
import { lifecycle } from "../dist/lifecycle/index.js";
import { handleHook } from "../dist/integrations/codex/hook.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(repo, "dist");
const RUNNER =
  'node "${PLUGIN_ROOT}/runtime/dist/integrations/codex/runner.js"';

function temp(t: TestContext, prefix = "mwf-codex-stop-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// Initialised project whose Codex client entry is enabled. Hook unit tests need
// a validated receipt, not a real plugin install (same approach as T08).
function enabledProject(t: TestContext) {
  const root = temp(t);
  execute("init", { project_root: root, git_mode: "track" });
  lifecycle("attach", {
    project_root: root,
    harness: "pi",
    plugin_root: repo,
    apply: true,
  });
  const file = path.join(root, ".mwf/local/integration.json");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  receipt.clients.codex = { ...receipt.clients.pi };
  fs.writeFileSync(file, JSON.stringify(receipt));
  return { root, file, receipt };
}
function snapshot(dir: string) {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir, { recursive: true, withFileTypes: true }))
    if (f.isFile()) {
      const p = path.join(f.parentPath, f.name);
      out[path.relative(dir, p)] = crypto
        .createHash("sha256")
        .update(fs.readFileSync(p))
        .digest("hex");
    }
  return out;
}
const stopInput = (cwd: string, extra: Record<string, unknown> = {}) => ({
  cwd,
  session_id: "codex-stop",
  hook_event_name: "Stop",
  turn_id: "turn-7",
  transcript_path: "/home/u/.codex/sessions/rollout-1.jsonl",
  last_assistant_message: "Fixed the flaky build by pinning node 22.19.",
  stop_hook_active: false,
  ...extra,
});

test("hooks.json registers Stop with the shared runner and leaves the other hooks unchanged", () => {
  const hooks = JSON.parse(
    fs.readFileSync(
      path.join(repo, "packaging/codex/hooks/hooks.json"),
      "utf8",
    ),
  ).hooks;
  assert.deepEqual(Object.keys(hooks), [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
  ]);
  assert.deepEqual(hooks.SessionStart, [
    {
      matcher: "startup|resume|clear|compact",
      hooks: [{ type: "command", command: RUNNER, timeout: 15 }],
    },
  ]);
  assert.deepEqual(hooks.UserPromptSubmit, [
    { hooks: [{ type: "command", command: RUNNER, timeout: 15 }] },
  ]);
  // Codex ignores matchers on Stop; none is declared.
  assert.deepEqual(hooks.Stop, [
    { hooks: [{ type: "command", command: RUNNER, timeout: 15 }] },
  ]);
});

test("first Stop fire blocks with a self-check prompt describing the protocol and context", (t) => {
  const { root } = enabledProject(t);
  const out = handleHook(stopInput(root)) as {
    decision?: string;
    reason?: string;
  };
  assert.deepEqual(Object.keys(out).sort(), ["decision", "reason"]);
  assert.equal(out.decision, "block");
  const reason = out.reason!;
  for (const word of [
    "preference",
    "decision",
    "incident",
    "task",
    "knowledge",
    "paths",
    "file_types",
    "components",
    "tools",
    "operations",
    "phases",
    "keywords",
    "mwf_add",
    "mwf_propose",
    "request_id",
    "index.md",
    "mwf_handoff",
    "substantive progress",
    "apply_patch",
    "update_plan",
    "task_id",
    "session_ref",
    "expected_revision",
    "completed",
    "next_action",
    "blockers",
    "decisions",
    "HANDOFF_CONFLICT",
  ])
    assert.match(reason, new RegExp(word), word);
  assert.match(reason, /Not substantive: pure chat/);
  assert.match(reason, /stop-turn-7-handoff/);
  assert.match(reason, /end the turn silently/);
  assert.match(reason, /turn-7/);
  assert.match(reason, /stop-turn-7-1/);
  assert.match(reason, /rollout-1\.jsonl/);
  assert.match(reason, /Fixed the flaky build by pinning node 22\.19\./);
});

test("the handoff steps in the Stop prompt are valid against the real handoff API", (t) => {
  const { root } = enabledProject(t);
  const save = (
    expected: number,
    data: Record<string, unknown>,
    request = `stop-turn-7-handoff-${expected}`,
  ) =>
    execute("handoff", {
      project_root: root,
      action: "save",
      task_id: "feature-a",
      expected_revision: expected,
      request_id: request,
      data,
    });
  const read = () =>
    execute("handoff", {
      project_root: root,
      action: "read",
      task_id: "feature-a",
    });
  // Step 2: no handoff yet means revision 0.
  assert.throws(read, /No handoff for this scope|NOT_FOUND/);
  const first = save(0, {
    goal: "Ship feature A",
    completed: ["Added parser"],
    decisions: ["Use zod"],
    blockers: [],
    next_action: "Write tests",
  });
  assert.equal(first.ok, true);
  const afterFirst = JSON.stringify(read().data);
  assert.match(afterFirst, /"revision":1/);
  // Step 3: overwrite-update with the read revision; revision increments, content replaced.
  const second = save(1, {
    goal: "Ship feature A",
    completed: ["Added parser", "Wrote tests"],
    decisions: ["Use zod"],
    blockers: ["CI flaky"],
    next_action: "Fix CI",
  });
  assert.equal(second.ok, true);
  const afterSecond = JSON.stringify(read().data);
  assert.match(afterSecond, /"revision":2/);
  assert.match(afterSecond, /Fix CI/);
  assert.doesNotMatch(afterSecond, /"next_action":"Write tests"/);
  assert.match(afterSecond, /CI flaky/);
  // A stale revision is a conflict, never a blind overwrite.
  assert.throws(
    () => save(1, { goal: "x", next_action: "y" }, "stop-turn-8-handoff"),
    /HANDOFF_CONFLICT|Current revision: 2/,
  );
});

test("Stop context is bounded and sanitised; missing optional fields are tolerated", (t) => {
  const { root } = enabledProject(t);
  const long = "x".repeat(50_000);
  const bounded = handleHook(
    stopInput(root, {
      last_assistant_message: long,
      transcript_path: "/a\nb" + "p".repeat(2000),
      turn_id: "../t u!rn\n",
    }),
  ) as { reason: string };
  assert.ok(bounded.reason.length < 6000, String(bounded.reason.length));
  assert.match(bounded.reason, /\[truncated\]/);
  assert.doesNotMatch(bounded.reason, /x{1600}/);
  assert.ok(bounded.reason.split("\n").includes("- turn_id: ../t u!rn"));
  assert.match(bounded.reason, /stop-\.\.-t-u-rn-1/);
  for (const extra of [
    { last_assistant_message: null, transcript_path: null },
    { last_assistant_message: 42, transcript_path: {}, turn_id: undefined },
    { stop_hook_active: undefined },
    { stop_hook_active: null },
  ]) {
    const out = handleHook(stopInput(root, extra)) as {
      decision?: string;
      reason?: string;
    };
    assert.equal(out.decision, "block");
    assert.equal(
      /last_assistant_message \(excerpt\)/.test(out.reason!),
      !("last_assistant_message" in extra),
    );
  }
});

test("stop_hook_active=true allows the stop without a decision", (t) => {
  const { root } = enabledProject(t);
  assert.deepEqual(handleHook(stopInput(root, { stop_hook_active: true })), {});
  // A continuation after the single block: block once, then allow.
  const first = handleHook(stopInput(root)) as { decision?: string };
  assert.equal(first.decision, "block");
  assert.deepEqual(handleHook(stopInput(root, { stop_hook_active: true })), {});
});

test("Stop allows the stop when MWF is absent, disabled, stale or mismatched", (t) => {
  const { root, file, receipt } = enabledProject(t);
  // No project at all.
  assert.deepEqual(handleHook(stopInput(temp(t))), {});
  // Initialised but not enabled for Codex.
  const plain = temp(t);
  execute("init", { project_root: plain, git_mode: "track" });
  assert.deepEqual(handleHook(stopInput(plain)), {});
  // Copied project: receipt belongs to another location (SessionStart throws here).
  const copied = path.join(temp(t), "copy");
  fs.cpSync(root, copied, { recursive: true });
  assert.throws(
    () => handleHook({ ...stopInput(copied), hook_event_name: "SessionStart" }),
    /Receipt belongs to another location/,
  );
  assert.deepEqual(handleHook(stopInput(copied)), {});
  // Corrupt receipt.
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(handleHook(stopInput(root)), {});
  // Disabled client.
  receipt.clients.codex.enabled = false;
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.deepEqual(handleHook(stopInput(root)), {});
});

test("Stop is read-only: no memory, receipt or context state is written", (t) => {
  const { root } = enabledProject(t);
  const before = snapshot(root);
  handleHook(stopInput(root));
  handleHook(stopInput(root, { stop_hook_active: true }));
  assert.deepEqual(snapshot(root), before);
});

test("SessionStart and UserPromptSubmit behaviour is unchanged by Stop support", (t) => {
  const { root } = enabledProject(t);
  execute("add", {
    project_root: root,
    type: "preference",
    title: "Stop regression",
    summary: "STOP_REGRESSION_MARK",
    body: "Synthetic fixture",
  });
  const base = { cwd: root, session_id: "regress", source: "startup" };
  const start = handleHook({ ...base, hook_event_name: "SessionStart" }) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
    decision?: unknown;
  };
  assert.equal(start.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(
    start.hookSpecificOutput.additionalContext,
    /STOP_REGRESSION_MARK/,
  );
  assert.equal(start.decision, undefined);
  assert.deepEqual(
    handleHook({ ...base, hook_event_name: "UserPromptSubmit" }),
    {},
  );
  assert.throws(() => handleHook({ ...base, hook_event_name: "Other" }));
});

async function run(
  runner: string,
  input: unknown,
  deadline = 30_000,
): Promise<{ code: number | null; out: string; ms: number }> {
  const started = Date.now();
  const child = spawn(process.execPath, [runner], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), deadline);
  child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  const [code] = await once(child, "close");
  clearTimeout(timer);
  return { code, out, ms: Date.now() - started };
}

test("runner.js: Stop blocks once, passes through on stop_hook_active and on malformed input", async (t) => {
  const probe = spawnSync(process.execPath, ["--version"], {
    encoding: "utf8",
  });
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
    t.skip("sandbox denies piped child processes required by the runner");
    return;
  }
  const { root } = enabledProject(t);
  const runner = path.join(dist, "integrations/codex/runner.js");
  const first = await run(runner, stopInput(root));
  assert.equal(first.code, 0);
  const blocked = JSON.parse(first.out);
  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /Fixed the flaky build/);
  const again = await run(runner, stopInput(root, { stop_hook_active: true }));
  assert.equal(again.code, 0);
  assert.deepEqual(JSON.parse(again.out), {});
  // Schema failure inside the worker (cwd missing): allow, with no notice.
  const bad = await run(runner, {
    hook_event_name: "Stop",
    session_id: "s",
    stop_hook_active: false,
  });
  assert.equal(bad.code, 0);
  assert.deepEqual(JSON.parse(bad.out), {});
});

test("runner.js: worker crash or timeout allows the stop silently; other events keep their notice", async (t) => {
  const probe = spawnSync(process.execPath, ["--version"], {
    encoding: "utf8",
  });
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
    t.skip("sandbox denies piped child processes required by the runner");
    return;
  }
  const { root } = enabledProject(t);
  // Private copy of dist so the real worker stays untouched.
  const copy = temp(t, "mwf-codex-stop-dist-");
  fs.cpSync(dist, path.join(copy, "dist"), { recursive: true });
  fs.symlinkSync(
    path.join(repo, "node_modules"),
    path.join(copy, "node_modules"),
    "dir",
  );
  fs.copyFileSync(
    path.join(repo, "package.json"),
    path.join(copy, "package.json"),
  );
  const codex = path.join(copy, "dist/integrations/codex");
  const runner = path.join(codex, "runner.js");
  const worker = path.join(codex, "worker.js");
  const session = { cwd: root, session_id: "fail", source: "startup" };

  fs.writeFileSync(worker, "process.stdin.resume(); process.exit(1);\n");
  const crashedStop = await run(runner, {
    ...session,
    hook_event_name: "Stop",
  });
  assert.equal(crashedStop.code, 0);
  assert.deepEqual(JSON.parse(crashedStop.out), {});
  const crashedStart = await run(runner, {
    ...session,
    hook_event_name: "SessionStart",
  });
  assert.match(
    JSON.parse(crashedStart.out).systemMessage,
    /memory was not restored/,
  );

  // Hanging worker: runner kills it at 14.5s, before the 15s host timeout.
  fs.writeFileSync(
    worker,
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const [hungStop, hungStart] = await Promise.all([
    run(runner, { ...session, hook_event_name: "Stop" }),
    run(runner, {
      ...session,
      session_id: "hang2",
      hook_event_name: "SessionStart",
    }),
  ]);
  for (const r of [hungStop, hungStart]) {
    assert.equal(r.code, 0);
    assert.ok(r.ms >= 14_000 && r.ms < 15_000 + 2_000, String(r.ms));
  }
  assert.deepEqual(JSON.parse(hungStop.out), {});
  assert.match(JSON.parse(hungStart.out).systemMessage, /timed out/);
});
