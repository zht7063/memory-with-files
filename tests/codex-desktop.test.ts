import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  desktopScenarios,
  summarizeDesktop,
} from "../scripts/lib/codex-evidence.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const template = () =>
  JSON.parse(
    fs.readFileSync(
      path.join(repo, "docs/validation/codex-desktop-t08.json"),
      "utf8",
    ),
  );

for (const [criterion, names] of Object.entries(desktopScenarios)) {
  test(`T08 ${criterion}: desktop evidence requires normal host artifacts`, () => {
    assert.equal(summarizeDesktop(template()).criteria[criterion], "not_run");
    for (const name of names) {
      const evidence = template();
      delete evidence.scenarios[name];
      assert.throws(() => summarizeDesktop(evidence), /Required T08 scenario/);
      evidence.scenarios[name] = {
        status: "pass",
        source: "bundled_cli",
        artifacts: ["unit-test-only"],
        trust_bypass: true,
      };
      assert.throws(() => summarizeDesktop(evidence), /Desktop pass needs/);
      evidence.scenarios[name].status = "partial";
      assert.equal(summarizeDesktop(evidence).criteria[criterion], "partial");
    }
  });
}
test("T08 environment and model content versions cannot be inferred", () => {
  const evidence = template();
  evidence.scenarios.request_v1 = {
    status: "pass",
    source: "desktop",
    artifacts: ["unit-test-only"],
    trust_bypass: false,
  };
  assert.throws(
    () => summarizeDesktop(evidence),
    /environment|content version/,
  );
  // Synthetic validator fixture only; never persisted as host evidence.
  for (const key of Object.keys(evidence.environment))
    evidence.environment[key] =
      key === "artifact_sha256" ? "a".repeat(64) : "unit-test-only";
  Object.assign(evidence.scenarios.request_v1, {
    expected_version: "V2",
    observed_version: "V1",
    observation_method: "unit-test-only",
  });
  assert.throws(() => summarizeDesktop(evidence), /matching content version/);
  evidence.scenarios.request_v1.observed_version = "V2";
  assert.equal(summarizeDesktop(evidence).status, "partial");
  assert.equal(summarizeDesktop(evidence).release_eligible, false);
  for (const name of Object.values(desktopScenarios).flat()) {
    evidence.scenarios[name] = { ...evidence.scenarios.request_v1 };
  }
  assert.equal(summarizeDesktop(evidence).status, "pass");
  assert.equal(summarizeDesktop(evidence).release_eligible, false);
  evidence.scenarios.request_v1.status = "fail";
  assert.equal(summarizeDesktop(evidence).status, "fail");
});

test("T08 local installed runner failure/path/version matrix (not desktop evidence)", async (t) => {
  const capability = spawnSync(process.execPath, ["--version"], {
    encoding: "utf8",
  });
  if (
    (capability.error as NodeJS.ErrnoException | undefined)?.code === "EPERM"
  ) {
    t.skip(
      "not_run: sandbox denies piped child processes required by the real runner/MCP",
    );
    return;
  }
  assert.ifError(capability.error);
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-codex-t08-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const plugin = path.join(base, "插件 runtime"),
    runtime = path.join(plugin, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  for (const name of ["dist", "assets", "package.json"])
    fs.cpSync(path.join(repo, name), path.join(runtime, name), {
      recursive: true,
    });
  fs.symlinkSync(
    path.join(repo, "node_modules"),
    path.join(runtime, "node_modules"),
    "dir",
  );
  // Release packaging stamps the source manifest with the runtime version.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repo, "packaging/codex/plugin.json"), "utf8"),
  );
  manifest.version = JSON.parse(
    fs.readFileSync(path.join(runtime, "package.json"), "utf8"),
  ).version;
  fs.writeFileSync(
    path.join(plugin, "plugin.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const cli = path.join(runtime, "dist/cli.js"),
    runner = path.join(runtime, "dist/integrations/codex/runner.js");
  const project = path.join(base, "项目 A with spaces"),
    nested = path.join(project, "子目录 space");
  fs.mkdirSync(nested, { recursive: true });
  function mwf(...args: string[]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: project,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      JSON.stringify({
        command: [process.execPath, cli, ...args],
        exitCode: result.status,
        signal: result.signal,
        error: result.error?.message,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    );
    return JSON.parse(result.stdout);
  }
  const init = mwf("init", "--root", project, "--git-mode", "track");
  assert.equal(init.ok, true);
  const attach = mwf(
    "attach",
    "--root",
    project,
    "--harness",
    "codex",
    "--plugin-root",
    plugin,
    "--apply",
  );
  assert.equal(attach.ok, true);
  assert.equal(attach.data.probed.host_reload, "pending");
  const added = mwf(
    "add",
    "--root",
    project,
    "--type",
    "preference",
    "--title",
    "Version test",
    "--summary",
    "T08_CONTENT_V1",
    "--body",
    "Synthetic fixture only",
  );
  assert.equal(added.ok, true);
  async function hook(cwd = nested, source = "startup", session = "local") {
    const child = spawn(process.execPath, [runner], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 6500);
    child.stdin.end(
      JSON.stringify({
        cwd,
        session_id: session,
        hook_event_name: "SessionStart",
        source,
      }),
    );
    const [code, signal] = await once(child, "close");
    clearTimeout(timer);
    assert.equal(
      code,
      0,
      JSON.stringify({ exitCode: code, signal, stdout: out, stderr: err }),
    );
    return JSON.parse(out);
  }
  await t.test(
    "Chinese/space paths and subdirectory restore V1 without a host acknowledgement",
    async () => {
      const result = await hook();
      assert.match(
        result.hookSpecificOutput.additionalContext,
        /T08_CONTENT_V1/,
      );
      const diagnostics = JSON.stringify(mwf("status", "--root", project));
      assert.doesNotMatch(diagnostics, /"host_confirmed":"accepted"/);
      for (const rule of ["AGENTS.md", "CLAUDE.md"])
        assert.equal(fs.existsSync(path.join(project, rule)), false);
    },
  );
  await t.test("delayed MCP startup cannot hold the local runner", async () => {
    const ready = path.join(base, "mcp-ready");
    // Real stdio MCP is wrapped with a 10s startup delay. No desktop scheduling claim.
    const wrapper = path.join(base, "slow-mcp.cjs");
    fs.writeFileSync(
      wrapper,
      `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); require('node:child_process').spawn(process.execPath, ${JSON.stringify([cli, "mcp", "--root", project])}, {stdio:'inherit'}); }, 10000);`,
    );
    const mcp = spawn(process.execPath, [wrapper], {
      cwd: nested,
      stdio: "ignore",
    });
    try {
      assert.match(
        (await hook(nested, "startup", "delayed")).hookSpecificOutput
          .additionalContext,
        /T08_CONTENT_V1/,
      );
      assert.equal(fs.existsSync(ready), false);
      assert.equal(mcp.exitCode, null);
    } finally {
      mcp.kill("SIGKILL");
      await once(mcp, "close");
    }
  });
  await t.test("failed MCP process cannot prevent direct restore", async () => {
    const mcp = spawn(process.execPath, [path.join(base, "missing-mcp.js")], {
      stdio: "ignore",
    });
    const [code] = await once(mcp, "close");
    assert.notEqual(code, 0);
    assert.match(
      (await hook(nested, "startup", "failed")).hookSpecificOutput
        .additionalContext,
      /T08_CONTENT_V1/,
    );
  });
  await t.test(
    "copied enabled receipt cannot read A and leaves A usable",
    async () => {
      const copied = path.join(base, "项目 B copy");
      fs.cpSync(project, copied, { recursive: true });
      const result = await hook(copied, "startup", "copied");
      assert.equal(result.hookSpecificOutput, undefined);
      assert.match(result.systemMessage, /not restored/);
      assert.match(
        (await hook(nested, "startup", "original")).hookSpecificOutput
          .additionalContext,
        /T08_CONTENT_V1/,
      );
    },
  );
  await t.test(
    "compact/resume/clear runner outputs updated V2 (no model-request claim)",
    async () => {
      assert.equal(
        mwf(
          "update",
          "--root",
          project,
          "--id",
          added.data.id,
          "--summary",
          "T08_CONTENT_V2",
          "--apply",
        ).ok,
        true,
      );
      for (const source of ["compact", "resume", "clear"]) {
        const result = await hook(nested, source);
        assert.match(
          result.hookSpecificOutput.additionalContext,
          /T08_CONTENT_V2/,
        );
        assert.doesNotMatch(
          result.hookSpecificOutput.additionalContext,
          /T08_CONTENT_V1/,
        );
      }
    },
  );
  await t.test(
    "disabled integration and unenabled project produce no success output",
    async () => {
      assert.equal(
        mwf("detach", "--root", project, "--harness", "codex", "--apply").ok,
        true,
      );
      assert.deepEqual(await hook(), {});
      const unenabled = path.join(base, "unenabled");
      fs.mkdirSync(unenabled);
      assert.equal((await hook(unenabled)).hookSpecificOutput, undefined);
      assert.equal(fs.existsSync(path.join(unenabled, ".mwf")), false);
    },
  );
  await t.test(
    "deleted runtime fails to launch without a restoration message",
    async () => {
      fs.rmSync(path.join(runtime, "dist"), { recursive: true });
      const child = spawn(process.execPath, [runner], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      const [code] = await once(child, "close");
      assert.notEqual(code, 0);
      assert.equal(stdout, "");
    },
  );
});

test("T08 in-process hook path/version/disable checks (partial local evidence)", async (t) => {
  const { execute } = await import("../dist/core.js");
  const { lifecycle } = await import("../dist/setup.js");
  const { handleHook } = await import("../dist/integrations/codex/hook.js");
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-t08-direct-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "项目 A with spaces"),
    nested = path.join(project, "子目录");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(
    execute("init", { project_root: project, git_mode: "track" }).ok,
    true,
  );
  // Use a receipt for this checkout runtime; this is a hook contract test, not discovery.
  lifecycle("attach", {
    project_root: project,
    harness: "pi",
    plugin_root: repo,
    apply: true,
  });
  const receiptPath = path.join(project, ".mwf/local/integration.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  receipt.clients.codex = { ...receipt.clients.pi };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const added = execute("add", {
    project_root: project,
    type: "preference",
    title: "Version",
    summary: "T08_DIRECT_V1",
    body: "Synthetic fixture",
  });
  assert.equal(added.ok, true);
  const id = (added.data as { id: string }).id;
  const input = {
    cwd: nested,
    session_id: "direct",
    hook_event_name: "SessionStart",
    source: "startup",
  };
  assert.match(
    handleHook(input).hookSpecificOutput!.additionalContext,
    /T08_DIRECT_V1/,
  );
  assert.equal(
    execute("update", {
      project_root: project,
      id,
      summary: "T08_DIRECT_V2",
      apply: true,
    }).ok,
    true,
  );
  for (const source of ["compact", "resume", "clear"]) {
    const output = handleHook({ ...input, source }).hookSpecificOutput!
      .additionalContext;
    assert.match(output, /T08_DIRECT_V2/);
    assert.doesNotMatch(output, /T08_DIRECT_V1/);
  }
  const copied = path.join(base, "项目 B");
  fs.cpSync(project, copied, { recursive: true });
  assert.throws(
    () => handleHook({ ...input, cwd: copied }),
    /Receipt belongs to another location/,
  );
  assert.match(
    handleHook(input).hookSpecificOutput!.additionalContext,
    /T08_DIRECT_V2/,
  );
  receipt.clients.codex.enabled = false;
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.deepEqual(handleHook(input), {});
  const unenabled = path.join(base, "initialized but unenabled");
  fs.mkdirSync(unenabled);
  assert.equal(
    execute("init", { project_root: unenabled, git_mode: "track" }).ok,
    true,
  );
  assert.deepEqual(handleHook({ ...input, cwd: unenabled }), {});
  for (const rule of ["AGENTS.md", "CLAUDE.md"])
    assert.equal(fs.existsSync(path.join(project, rule)), false);
});
