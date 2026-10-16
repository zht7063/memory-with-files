import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const installer = fileURLToPath(
  new URL("./install-mwf.ts", import.meta.url),
);
const base = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "mwf-packed-")),
);
const envelope = z.object({ ok: z.boolean(), data: z.unknown() });
try {
  const entry = z.object({ filename: z.string() });
  const packed = z
    .union([
      z.array(entry),
      z.record(entry).transform((value) => Object.values(value)),
    ])
    .parse(
      JSON.parse(
        execFileSync(
          "npm",
          [
            "pack",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            base,
            "--cache",
            path.join(base, "pack-cache"),
          ],
          { cwd: packageRoot, encoding: "utf8" },
        ),
      ),
    );
  assert.ok(packed[0]);
  const tgz = path.join(base, packed[0].filename);
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      path.join(base, "installed"),
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--cache",
      path.join(base, "empty-cache"),
      tgz,
    ],
    { encoding: "utf8" },
  );
  const installed = path.join(base, "installed/node_modules/@zht7063/mwf");
  assert.equal(fs.existsSync(path.join(installed, "src")), false);
  assert.equal(fs.existsSync(path.join(installed, "scripts")), false);
  const project = path.join(base, "project");
  fs.mkdirSync(project);
  const invoke = (...args: string[]) =>
    envelope.parse(
      JSON.parse(
        execFileSync(
          process.execPath,
          [path.join(installed, "dist/cli.js"), ...args],
          { cwd: project, env: { ...process.env, PATH: "" }, encoding: "utf8" },
        ),
      ),
    );
  const setup = invoke(
    "setup",
    "--root",
    project,
    "--harness",
    "codex",
    "--git-mode",
    "track",
  );
  assert.equal(
    z
      .object({ mcp: z.object({ bootstrap_verified: z.boolean() }) })
      .parse(setup.data).mcp.bootstrap_verified,
    true,
  );
  invoke(
    "add",
    "--root",
    project,
    "--type",
    "preference",
    "--title",
    "Package acceptance marker",
    "--summary",
    "Release packages must pass the crimson-moon-731 check.",
    "--body",
    "## Policy\nRun the installed package acceptance check before release.",
  );
  assert.equal(invoke("doctor", "--root", project).ok, true);
  assert.match(
    JSON.stringify(invoke("bootstrap", "--root", project)),
    /crimson-moon-731/,
  );

  // Exercise the TS bootstrap installer, including spaces and shell metacharacters.
  const installProject = path.join(base, "project with spaces $literal");
  const prefix = path.join(base, "runtime with spaces");
  fs.mkdirSync(installProject);
  const args = [
    "--experimental-strip-types",
    installer,
    "--package",
    tgz,
    "--root",
    installProject,
    "--prefix",
    prefix,
    "--git-mode",
    "ignore",
  ];
  const preview = execFileSync(process.execPath, [...args, "--dry-run"], {
    encoding: "utf8",
  });
  assert.match(preview, /No files changed/);
  assert.equal(fs.existsSync(prefix), false);
  assert.deepEqual(fs.readdirSync(installProject), []);
  execFileSync(process.execPath, args, { encoding: "utf8" });
  assert.ok(
    fs.existsSync(path.join(prefix, "node_modules/@zht7063/mwf/dist/cli.js")),
  );
  assert.equal(
    z
      .object({ git_mode: z.string() })
      .parse(
        JSON.parse(
          fs.readFileSync(
            path.join(installProject, ".mwf/config.json"),
            "utf8",
          ),
        ),
      ).git_mode,
    "ignore",
  );
  execFileSync(process.execPath, args, { encoding: "utf8" });

  const conflict = path.join(base, "conflict");
  fs.mkdirSync(path.join(conflict, ".codex"), { recursive: true });
  const existing = '[mcp_servers.mwf]\ncommand = "user-owned"\n';
  fs.writeFileSync(path.join(conflict, ".codex/config.toml"), existing);
  const failed = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      installer,
      "--package",
      tgz,
      "--root",
      conflict,
      "--prefix",
      prefix,
      "--git-mode",
      "track",
    ],
    { encoding: "utf8" },
  );
  assert.equal(failed.status, 1);
  assert.match(
    failed.stderr,
    /runtime and any completed setup steps are retained/,
  );
  assert.equal(
    fs.readFileSync(path.join(conflict, ".codex/config.toml"), "utf8"),
    existing,
  );
  assert.equal(fs.existsSync(path.join(conflict, ".mwf")), false);
  assert.ok(
    fs.existsSync(path.join(prefix, "node_modules/@zht7063/mwf/dist/cli.js")),
  );
  console.log(
    "PASS: packed files only, empty PATH, offline empty-cache install, stdio handshake, write/read/doctor, TS installer preview/install/retry/conflict retention",
  );
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
