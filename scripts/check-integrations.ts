import { spawnSync } from "node:child_process";
const contracts = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--test",
    "tests/mcp.test.ts",
    "tests/pi-adapter.test.ts",
    "tests/lifecycle.test.ts",
  ],
  { stdio: "inherit" },
);
const summary: Record<string, string | boolean> = {
  contracts: contracts.status === 0 ? "pass" : "fail",
  real_pi: "not_run",
  codex_cli: "not_run",
  codex_desktop: "not_run",
  release_eligible: false,
};
if (contracts.status !== 0) process.exitCode = 1;
for (const [variable, script, key] of [
  ["MWF_PI_BINARY", "pi.py", "real_pi"],
  ["MWF_CODEX_BINARY", "codex.py", "codex_cli"],
]) {
  const binary = process.env[variable];
  if (!binary) continue;
  const host = spawnSync(
    "python3",
    ["tests/integrations/release/" + script, binary],
    { stdio: "inherit" },
  );
  summary[key] =
    host.status === 0 ? (key === "real_pi" ? "partial" : "pass") : "fail";
  if (host.status !== 0) process.exitCode = 1;
}
console.log(JSON.stringify(summary));
