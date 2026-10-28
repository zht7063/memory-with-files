// Cold Codex hook latency: runs runner.js as a fresh process per invocation
// (the way Codex does) against a throwaway project and prints JSON timings.
// Usage: node --experimental-strip-types scripts/measure-hook.ts <runtime-dir> [runs] [records]
// <runtime-dir> holds dist/, assets/, package.json and node_modules/ (a built
// checkout, or an unpacked release runtime). Used for issue #30 on slow hosts.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const runtime = path.resolve(process.argv[2] ?? ".");
const runs = Number(process.argv[3] ?? 10);
const records = Number(process.argv[4] ?? 20);
const base = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "mwf-measure-hook-")),
);
const plugin = path.join(base, "plugin"),
  project = path.join(base, "project");
fs.mkdirSync(plugin, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.symlinkSync(runtime, path.join(plugin, "runtime"), "dir");
fs.writeFileSync(
  path.join(plugin, "plugin.json"),
  JSON.stringify({
    name: "mwf",
    version: JSON.parse(
      fs.readFileSync(path.join(runtime, "package.json"), "utf8"),
    ).version,
    description: "measure",
  }),
);
const cli = path.join(runtime, "dist/cli.js"),
  runner = path.join(runtime, "dist/integrations/codex/runner.js");
function mwf(...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: project,
    encoding: "utf8",
  });
  if (r.status !== 0)
    throw new Error(`mwf ${args[0]} failed: ${r.stdout}${r.stderr}`);
}
mwf("init", "--root", project, "--git-mode", "track");
mwf(
  "attach",
  "--root",
  project,
  "--harness",
  "codex",
  "--plugin-root",
  plugin,
  "--apply",
);
for (let i = 0; i < records; i++)
  mwf(
    "add",
    "--root",
    project,
    "--type",
    "preference",
    "--title",
    `Measure ${i}`,
    "--summary",
    `Synthetic memory ${i}: proxy settings and fallback steps`,
    "--body",
    "Synthetic fixture only",
  );
function hook(event: string, session: string) {
  return new Promise<{ ms: number; ok: boolean }>((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, [runner], {
      cwd: project,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stdin.end(
      JSON.stringify({
        cwd: project,
        session_id: session,
        hook_event_name: event,
        source: "startup",
        prompt: "proxy settings",
      }),
    );
    child.on("close", () => {
      let ok = false;
      try {
        ok = "hookSpecificOutput" in JSON.parse(out) || out.trim() === "{}";
      } catch {}
      resolve({ ms: Math.round(performance.now() - started), ok });
    });
  });
}
const results: Record<string, number[]> = {
  SessionStart: [],
  UserPromptSubmit: [],
};
let failures = 0;
for (let i = 0; i < runs; i++) {
  const session = `measure-${i}`;
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const r = await hook(event, session);
    results[event].push(r.ms);
    if (!r.ok) failures++;
  }
}
const stats = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return {
    first_ms: v[0],
    min_ms: s[0],
    median_ms: s[Math.floor(s.length / 2)],
    max_ms: s[s.length - 1],
  };
};
console.log(
  JSON.stringify({
    node: process.version,
    cpus: os.cpus().length,
    load: os.loadavg()[0],
    runs,
    records,
    failures,
    SessionStart: stats(results.SessionStart),
    UserPromptSubmit: stats(results.UserPromptSubmit),
  }),
);
fs.rmSync(base, { recursive: true, force: true });
