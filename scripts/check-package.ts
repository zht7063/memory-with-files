import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)),
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mwf-packed-")));
try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        base,
        "--cache",
        path.join(base, "cache"),
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const tgz = path.join(base, packed[0].filename),
    prefix = path.join(base, "installed");
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
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
  const installed = path.join(prefix, "node_modules/@zht7063/mwf"),
    cli = path.join(installed, "dist/cli.js");
  assert.equal(fs.existsSync(path.join(installed, "src")), false);
  assert.equal(fs.existsSync(path.join(installed, "scripts")), false);
  const project = path.join(base, "项目 with spaces $literal");
  fs.mkdirSync(project);
  const invoke = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, ...args], {
        cwd: project,
        env: { ...process.env, PATH: "", HOME: base },
        encoding: "utf8",
      }),
    );
  invoke("init", "--root", project, "--git-mode", "track");
  assert.equal(fs.existsSync(path.join(project, "AGENTS.md")), false);
  fs.mkdirSync(path.join(project, ".pi"));
  fs.writeFileSync(
    path.join(project, ".pi/settings.json"),
    JSON.stringify({ packages: [installed] }),
  );
  const attached = invoke(
    "attach",
    "--root",
    project,
    "--harness",
    "pi",
    "--apply",
  );
  assert.equal(attached.data.probed.direct, "pass");
  assert.equal(attached.data.probed.mcp.status_verified, true);
  assert.equal(attached.data.session_observed, "unknown");
  assert.equal(attached.data.probed.host_reload, "pending");
  const added = invoke(
    "add",
    "--root",
    project,
    "--type",
    "preference",
    "--title",
    "Marker",
    "--summary",
    "crimson-moon-731",
    "--body",
    "Verified offline",
  );
  assert.match(
    JSON.stringify(invoke("bootstrap", "--root", project)),
    /crimson-moon-731/,
  );
  assert.ok(
    invoke("get", "--root", project, "--id", added.data.id).data.fragment,
  );
  assert.equal(invoke("doctor", "--root", project).ok, true);
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const core=await import('@zht7063/mwf'); if(!core.execute('status',{project_root:${JSON.stringify(project)}}).ok)process.exit(1); await import(${JSON.stringify("file://" + path.join(installed, "dist/integrations/pi/index.js"))});`,
    ],
    { cwd: prefix, env: { ...process.env, PATH: "", HOME: base } },
  );
  const sdk = path.join(
    installed,
    "node_modules/@modelcontextprotocol/sdk/dist/esm",
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {Client} from ${JSON.stringify("file://" + path.join(sdk, "client/index.js"))};
    import {StdioClientTransport} from ${JSON.stringify("file://" + path.join(sdk, "client/stdio.js"))};
    const client = new Client({name:"package-check",version:"0.2.0"});
    const transport = new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(cli)},"mcp","--root",${JSON.stringify(project)}],stderr:"pipe"});
    try { await client.connect(transport); const result=await client.callTool({name:"mwf_bootstrap",arguments:{project_root:${JSON.stringify(project)}}}); if(result.isError || !JSON.stringify(result).includes("crimson-moon-731")) throw Error("Packed MCP did not restore memory"); }
    finally { await client.close(); await transport.close(); }
  `,
    ],
    {
      cwd: prefix,
      env: { ...process.env, PATH: "", HOME: base },
      timeout: 20000,
    },
  );
  const installer = path.join(root, "scripts/install-mwf.ts"),
    destination = path.join(base, "runtime with spaces");
  const args = [
    "--experimental-strip-types",
    installer,
    "--package",
    tgz,
    "--prefix",
    destination,
  ];
  assert.match(
    execFileSync(process.execPath, [...args, "--dry-run"], {
      encoding: "utf8",
    }),
    /No files changed/,
  );
  assert.equal(fs.existsSync(destination), false);
  execFileSync(process.execPath, args, { encoding: "utf8" });
  execFileSync(process.execPath, args, { encoding: "utf8" });
  assert.ok(
    fs.existsSync(
      path.join(destination, "node_modules/@zht7063/mwf/dist/cli.js"),
    ),
  );
  const failed = spawnSync(
    process.execPath,
    [cli, "attach", "--root", project, "--harness", "codex", "--apply"],
    { encoding: "utf8" },
  );
  assert.equal(failed.status, 2);
  assert.match(failed.stdout, /PLUGIN_RUNTIME_REQUIRED/);
  assert.equal(fs.existsSync(path.join(project, ".codex")), false);
  console.log(
    "PASS: real offline tarball, isolated HOME/empty PATH, Core root import/CLI/MCP/Pi imports, tokenizer, init/read/write/doctor, installer preview/retry, plugin runtime requirement",
  );
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
