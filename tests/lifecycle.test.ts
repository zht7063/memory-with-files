import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
  assert.deepEqual(run("attach", ...args, "--apply").changed_files, []);
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
