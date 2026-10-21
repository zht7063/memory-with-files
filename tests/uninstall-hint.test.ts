import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("../", import.meta.url));
const HINT =
  "https://github.com/zht7063/memory-with-files/blob/main/packaging/UNINSTALL.md";
test("init and attach --apply keep stdout pure JSON and print the uninstall hint on stderr only", (t) => {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-hint-")),
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
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  const cli = path.join(runtime, "dist/cli.js");
  const run = (...args: string[]) => {
    const child = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
    });
    const json = JSON.parse(child.stdout);
    assert.ok(!child.stdout.includes(HINT));
    assert.equal(json.uninstall_hint, undefined);
    return { json, hinted: child.stderr.includes(HINT) };
  };
  const attach = ["--root", project, "--harness", "codex"];
  attach.push("--plugin-root", plugin);
  const failed = run("attach", ...attach, "--apply");
  assert.equal(failed.json.ok, false);
  assert.equal(failed.hinted, false);
  const init = run("init", "--root", project, "--git-mode", "track");
  assert.equal(init.json.ok, true);
  assert.equal(init.hinted, true);
  const preview = run("attach", ...attach);
  assert.equal(preview.json.ok, true);
  assert.equal(preview.hinted, false);
  const applied = run("attach", ...attach, "--apply");
  assert.equal(applied.json.ok, true);
  assert.equal(applied.hinted, true);
});
