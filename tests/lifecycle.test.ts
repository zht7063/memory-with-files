import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("../", import.meta.url));
test("installed Codex runtime preserves unrelated TOML and disables before cleanup conflicts", (t) => {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-lifecycle-")),
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
    JSON.stringify({ name: "mwf", version: "0.2.0" }),
  );
  const project = path.join(base, "项目");
  fs.mkdirSync(project);
  const cli = path.join(runtime, "dist/cli.js");
  const run = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }),
    );
  run("init", "--root", project, "--git-mode", "track");
  fs.mkdirSync(path.join(project, ".codex"));
  const config = path.join(project, ".codex/config.toml");
  fs.writeFileSync(config, '# user comment\nmodel = "user"\n');
  const args = [
    "--root",
    project,
    "--harness",
    "codex",
    "--plugin-root",
    plugin,
  ];
  const before = fs.readFileSync(config, "utf8");
  run("attach", ...args);
  assert.equal(fs.readFileSync(config, "utf8"), before);
  const attached = run("attach", ...args, "--apply");
  assert.equal(attached.data.probed.direct, "pass");
  assert.equal(attached.data.probed.mcp.status_verified, true);
  assert.equal(attached.data.probed.host_reload, "pending");
  const read = () =>
    JSON.parse(
      fs.readFileSync(
        path.join(project, ".mwf/local/integration.json"),
        "utf8",
      ),
    );
  const generation = read().clients.codex.binding_generation;
  assert.deepEqual(run("attach", ...args, "--apply").changed_files, [
    ".mwf/local/integration.json",
  ]);
  assert.equal(read().clients.codex.probe.host_confirmed, "unknown");
  assert.equal(read().clients.codex.probe.source, "attach_standalone");
  assert.equal(read().clients.codex.probe.root, project);
  assert.equal(read().clients.codex.probe.runtime_version, "0.2.0");
  assert.ok(Date.parse(read().clients.codex.probe.time));
  // Bundled entry identifies its own plugin, with no PATH dependency.
  assert.equal(
    run("attach", "--root", project, "--harness", "codex").data.preview,
    true,
  );
  assert.equal(read().clients.codex.binding_generation, generation);
  fs.appendFileSync(config, '\n[unrelated]\nvalue = "keep"\n');
  run("detach", "--root", project, "--harness", "codex", "--apply");
  assert.match(fs.readFileSync(config, "utf8"), /value = "keep"/);
  assert.equal(read().clients.codex.enabled, false);
  run("attach", ...args, "--apply");
  assert.notEqual(read().clients.codex.binding_generation, generation);
  fs.writeFileSync(
    config,
    fs.readFileSync(config, "utf8").replace("command =", "changed_command ="),
  );
  let failed = false;
  try {
    run("detach", "--root", project, "--harness", "codex", "--apply");
  } catch {
    failed = true;
  }
  assert.ok(failed);
  assert.equal(read().clients.codex.enabled, false);
  assert.equal(read().clients.codex.cleanup_pending, true);
  assert.match(fs.readFileSync(config, "utf8"), /changed_command/);
  assert.equal(fs.existsSync(path.join(project, "AGENTS.md")), false);
});

import { locateRuntime } from "../dist/lifecycle/index.js";
test("runtime discovery validates installed Pi packages and rejects global CLI fallback", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-discovery-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "项目");
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  const settings = path.join(project, ".pi/settings.json");
  fs.writeFileSync(settings, JSON.stringify({ packages: [source] }));
  assert.equal(
    locateRuntime(undefined, "pi", project).entry,
    fs.realpathSync(path.join(source, "dist/cli.js")),
  );
  fs.writeFileSync(settings, "{}");
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = base;
  try {
    assert.throws(
      () => locateRuntime(undefined, "pi", project),
      /Cannot locate/,
    );
    assert.throws(
      () => locateRuntime(base, "codex", project),
      /Invalid plugin runtime/,
    );
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
});
test("global CLI discovers Codex cache and delegates only validated plugin runtime", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-delegate-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "codex"),
    plugin = path.join(home, "plugins/cache/market/mwf/local");
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
  fs.writeFileSync(
    path.join(plugin, "plugin.json"),
    JSON.stringify({ name: "mwf", version: "0.2.0" }),
  );
  const project = path.join(base, "项目 with spaces");
  fs.mkdirSync(project);
  const run = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(source, "dist/cli.js"), ...args],
        {
          encoding: "utf8",
          env: { ...process.env, CODEX_HOME: home, PATH: "" },
        },
      ),
    );
  run("init", "--root", project, "--git-mode", "track");
  const attached = run(
    "attach",
    "--root",
    project,
    "--harness",
    "codex",
    "--apply",
  );
  assert.equal(
    attached.data.probed.runtime_path,
    path.join(runtime, "dist/cli.js"),
  );
  assert.equal(attached.data.probed.mcp.result, "pass");
  assert.equal(attached.data.probed.host_confirmed, "unknown");
  assert.match(
    fs.readFileSync(path.join(project, ".codex/config.toml"), "utf8"),
    /plugins\/cache/,
  );
  // Each setup client delegates through its own installed runtime.
  fs.mkdirSync(path.join(project, ".pi"));
  fs.writeFileSync(
    path.join(project, ".pi/settings.json"),
    JSON.stringify({ packages: [source] }),
  );
  const setup = run("setup", "--root", project, "--harness", "pi,codex");
  assert.equal(setup.ok, true);
  assert.equal(setup.data.clients.length, 2);
  assert.equal(setup.data.clients[1].runtime_version, "0.2.0");
  // Failure in standalone MCP leaves the committed resources recoverable.
  fs.writeFileSync(
    path.join(runtime, "dist/mcp.js"),
    fs
      .readFileSync(path.join(runtime, "dist/mcp.js"), "utf8")
      .replace(
        "await client.connect(transport, { timeout: 15000 });",
        'throw new Error("injected probe failure");',
      ),
  );
  const degraded = run(
    "attach",
    "--root",
    project,
    "--harness",
    "codex",
    "--apply",
  );
  assert.equal(degraded.data.state, "configured/degraded");
  assert.equal(degraded.data.probed.direct, "pass");
  assert.equal(degraded.data.probed.mcp.result, "fail");
  const receipt = JSON.parse(
    fs.readFileSync(path.join(project, ".mwf/local/integration.json"), "utf8"),
  );
  assert.equal(receipt.clients.codex.enabled, true);
  assert.equal(receipt.clients.codex.probe.mcp.result, "fail");
  const lifecycleFile = path.join(runtime, "dist/lifecycle/index.js");
  fs.writeFileSync(
    lifecycleFile,
    fs
      .readFileSync(lifecycleFile, "utf8")
      .replace(
        "export function persistProbe(root, harness, generation, evidence) {",
        'export function persistProbe(root, harness, generation, evidence) { throw new MWFError("BINDING_STALE", "Binding changed during probing.");',
      ),
  );
  const stale = run(
    "attach",
    "--root",
    project,
    "--harness",
    "codex",
    "--apply",
  );
  assert.equal(stale.ok, true);
  assert.equal(stale.data.state, "configured/degraded");
  assert.ok(
    stale.warnings.some((warning: string) => warning.includes("BINDING_STALE")),
  );
  fs.writeFileSync(
    path.join(plugin, "plugin.json"),
    JSON.stringify({ name: "mwf", version: "9.0.0" }),
  );
  assert.throws(
    () => run("attach", "--root", project, "--harness", "codex"),
    /Command failed/,
  );
});
test("Codex discovery rejects ambiguity and mismatched manifests", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-cache-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = base;
  try {
    for (const name of ["one", "two"]) {
      const plugin = path.join(base, "plugins/cache", name, "mwf/local");
      fs.mkdirSync(path.join(plugin, "runtime/dist"), { recursive: true });
      fs.writeFileSync(
        path.join(plugin, "plugin.json"),
        JSON.stringify({ name: "mwf", version: "0.2.0" }),
      );
      fs.writeFileSync(
        path.join(plugin, "runtime/package.json"),
        JSON.stringify({ name: "@zht7063/mwf", version: "0.2.0" }),
      );
      fs.writeFileSync(path.join(plugin, "runtime/dist/cli.js"), "");
    }
    assert.throws(
      () => locateRuntime(undefined, "codex", base),
      /Multiple installed/,
    );
    const plugin = path.join(base, "plugins/cache/two/mwf/local");
    fs.writeFileSync(
      path.join(plugin, "plugin.json"),
      JSON.stringify({ name: "mwf", version: "9" }),
    );
    assert.throws(
      () => locateRuntime(plugin, "codex", base),
      /version mismatch/,
    );
    assert.match(locateRuntime(undefined, "codex", base).plugin_root, /one/);
  } finally {
    if (old === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = old;
  }
});

test("Codex cache selects highest semver and prefers local with versions coexisting", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-versions-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = base;
  const install = (version: string) => {
    const plugin = path.join(base, "plugins/cache/market/mwf", version);
    fs.mkdirSync(path.join(plugin, "runtime/dist"), { recursive: true });
    fs.writeFileSync(
      path.join(plugin, "plugin.json"),
      JSON.stringify({ name: "mwf", version: "0.2.0" }),
    );
    fs.writeFileSync(
      path.join(plugin, "runtime/package.json"),
      JSON.stringify({ name: "@zht7063/mwf", version: "0.2.0" }),
    );
    fs.writeFileSync(path.join(plugin, "runtime/dist/cli.js"), "");
    return plugin;
  };
  try {
    for (const version of ["0.9.0", "0.10.0-beta.2", "0.10.0-beta.10", "junk"])
      install(version);
    assert.equal(
      locateRuntime(undefined, "codex", base).plugin_root,
      path.join(base, "plugins/cache/market/mwf/0.10.0-beta.10"),
    );
    const newest = install("0.10.0");
    assert.equal(locateRuntime(undefined, "codex", base).plugin_root, newest);
    const local = install("local");
    assert.equal(locateRuntime(undefined, "codex", base).plugin_root, local);
  } finally {
    if (old === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = old;
  }
});

test("CLI validates root and harness before runtime discovery", () => {
  for (const args of [
    ["attach"],
    ["attach", "--root", source],
    ["rebind", "--harness", "codex"],
    ["setup", "--harness", "pi,codex"],
  ]) {
    const child = spawnSync(
      process.execPath,
      [path.join(source, "dist/cli.js"), ...args],
      { encoding: "utf8" },
    );
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_INPUT");
  }
});

test("attach rejects an unknown harness and setup help states its default", () => {
  const cli = path.join(source, "dist/cli.js");
  const invalid = spawnSync(
    process.execPath,
    [cli, "attach", "--root", source, "--harness", "bogus"],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, "INVALID_INPUT");
  const help = execFileSync(process.execPath, [cli, "setup", "--help"], {
    encoding: "utf8",
  });
  assert.match(help, /setup[^\n]*default: codex/);
});

test("probe persistence degrades only stale bindings and rethrows other errors", async () => {
  const { probePersistenceWarning } = await import(
    "../dist/lifecycle/index.js"
  );
  const { MWFError } = await import("../dist/storage.js");
  assert.match(
    probePersistenceWarning(new MWFError("BINDING_STALE", "changed")),
    /BINDING_STALE/,
  );
  for (const error of [
    new MWFError("INVALID_INPUT", "invalid"),
    new Error("I/O failure"),
  ])
    assert.throws(
      () => probePersistenceWarning(error),
      (actual) => actual === error,
    );
});
