import fs from "node:fs";
import { spawnSync } from "node:child_process";
const contracts = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--test",
    "tests/mcp.test.ts",
    "tests/pi-adapter.test.ts",
    "tests/lifecycle.test.ts",
    "tests/codex-desktop.test.ts",
  ],
  { stdio: "inherit" },
);
const summary: Record<string, string | boolean> = {
  contracts: contracts.status === 0 ? "pass" : "fail",
  pi_cli: "not_run",
  codex_cli: "not_run",
  codex_desktop: "not_run",
};
if (contracts.status !== 0) process.exitCode = 1;
for (const [variable, script, key, evidence] of [
  ["MWF_PI_BINARY", "pi.py", "pi_cli", "pi-cli.json"],
  ["MWF_CODEX_BINARY", "codex.py", "codex_cli", "codex-cli.json"],
]) {
  // Stale evidence never survives a new run; not_run leaves no file.
  fs.rmSync("releases/evidence/" + evidence, { force: true });
  const binary = process.env[variable];
  if (!binary) continue;
  const host = spawnSync(
    "python3",
    ["tests/integrations/release/" + script, binary],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        MWF_EVIDENCE_OUT: "releases/evidence/" + evidence,
      },
    },
  );
  if (host.status !== 0)
    fs.rmSync("releases/evidence/" + evidence, { force: true });
  summary[key] = host.status === 0 ? "pass" : "fail";
  if (host.status !== 0) process.exitCode = 1;
}
console.log(JSON.stringify(summary));
console.log(
  "Release decision is computed by `npm run pack:release` from releases/evidence/*.json.",
);
