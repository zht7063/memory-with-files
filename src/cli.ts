#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { RUNTIME_VERSION } from "./contracts/version.js";
import { failure } from "./contracts/result.js";
import { serialize } from "./context/output.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { execute, Operation, schemas } from "./core.js";
import { MWFError } from "./storage.js";
import { serve, probe } from "./mcp.js";
import { lifecycle, setup } from "./setup.js";
const HELP = `MWF — project-local file memory
mwf init --root /project --git-mode track|ignore
mwf attach|rebind --root /project --harness pi|codex [--plugin-root PATH] --apply
mwf detach --root /project --harness pi|codex|all [--apply]
mwf migrate --root /project --from 0.1 [--legacy-stopped --apply]
mwf bootstrap|recall|get|status|doctor --root /project
mwf handoff --root /project --action list|read|save --task TASK --input-file FILE
mwf mcp --root /project [--profile agent|maintenance]
Use --input-file for structured JSON. Reads support --max-reference-tokens and --max-output-bytes.
Maintenance and lifecycle changes preview unless --apply. setup is deprecated.
`;
function stringArg(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new MWFError("INVALID_INPUT", `${label} must be a string.`);
  return value;
}
function parse(argv: string[]) {
  const args: Record<string, string | string[] | boolean> = {};
  const arrays = new Set([
    "file_type",
    "component",
    "tool",
    "operation",
    "phase",
    "keyword",
    "completed",
    "decisions",
    "blockers",
    "relevant_ids",
  ]);
  const booleans = new Set([
    "apply",
    "dry_run",
    "redact",
    "legacy",
    "legacy_stopped",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") continue;
    if (flag === "--no-install-pi-adapter") {
      args.install_pi_adapter = false;
      continue;
    }
    if (!flag.startsWith("--"))
      throw new MWFError("INVALID_INPUT", `Unexpected argument: ${flag}`);
    const key = flag.slice(2).replaceAll("-", "_");
    if (booleans.has(key)) {
      args[key] = true;
      continue;
    }
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--"))
      throw new MWFError("INVALID_INPUT", `Missing value for ${flag}`);
    const value = argv[++i];
    if (arrays.has(key) || key === "path") {
      const previous = args[key];
      args[key] = [...(Array.isArray(previous) ? previous : []), value];
    } else args[key] = value;
  }
  let input: Record<string, unknown> = {};
  if (args.input && args.input_file)
    throw new MWFError("INVALID_INPUT", "Use input or input-file, not both.");
  if (args.input || args.input_file) {
    try {
      input = JSON.parse(
        typeof args.input === "string"
          ? args.input
          : fs.readFileSync(stringArg(args.input_file, "input-file"), "utf8"),
      );
    } catch {
      throw new MWFError("INVALID_INPUT", "Invalid input JSON.");
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new MWFError("INVALID_INPUT", "Input must be a JSON object.");
  }
  delete args.input;
  delete args.input_file;
  Object.assign(input, args);
  if (input.root) {
    input.project_root = path.resolve(stringArg(input.root, "root"));
    delete input.root;
  }
  if (input.body_file) {
    if (input.body)
      throw new MWFError("INVALID_INPUT", "Use body or body-file, not both.");
    input.body = fs.readFileSync(
      stringArg(input.body_file, "body-file"),
      "utf8",
    );
    delete input.body_file;
  }
  for (const key of [
    "item",
    "limit",
    "threshold",
    "expected_revision",
    "max_reference_tokens",
    "max_output_bytes",
  ])
    if (input[key] !== undefined) input[key] = Number(input[key]);

  if (typeof input.scope === "string") input.scope = JSON.parse(input.scope);
  if (input.task) {
    input.task_id = input.task;
    delete input.task;
  }
  if (input.scope_kind || input.scope_id) {
    input.target_scope = { kind: input.scope_kind, id: input.scope_id };
    delete input.scope_kind;
    delete input.scope_id;
  }
  return input;
}
async function main() {
  const [op, ...argv] = process.argv.slice(2);
  if (!op || op === "--help" || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  if (op === "--version") {
    console.log(RUNTIME_VERSION);
    return;
  }
  const a = parse(argv);
  if (["add", "propose", "update"].includes(op)) {
    const mapping: Record<string, string> = {
      path: "paths",
      file_type: "file_types",
      component: "components",
      tool: "tools",
      operation: "operations",
      phase: "phases",
      keyword: "keywords",
    };
    for (const [from, to] of Object.entries(mapping))
      if (a[from] !== undefined) {
        a.scope ??= {};
        if (!a.scope || typeof a.scope !== "object" || Array.isArray(a.scope))
          throw new MWFError("INVALID_INPUT", "Scope must be a JSON object.");
        (a.scope as Record<string, unknown>)[to] = a[from];
        delete a[from];
      }
  } else if (Array.isArray(a.path)) {
    if (a.path.length > 1)
      throw new MWFError("INVALID_INPUT", "Recall accepts one path.");
    a.path = a.path[0];
  }
  if (op === "mcp") {
    const opts = z
      .object({
        project_root: z.string(),
        harness: z.enum(["pi", "codex"]).optional(),
        binding_generation: z.string().optional(),
        session_ref: z.string().optional(),
        profile: z.enum(["agent", "maintenance"]).default("agent"),
      })
      .strict()
      .parse(a);
    await serve(opts.project_root, opts);
    return;
  }
  if (
    ["attach", "rebind", "setup"].includes(op) &&
    typeof a.plugin_root === "string"
  ) {
    const runtime = path.join(
      a.plugin_root,
      a.harness === "pi" ? "" : "runtime",
      "dist/cli.js",
    );
    if (
      fs.realpathSync(runtime) !==
      fs.realpathSync(fileURLToPath(import.meta.url))
    ) {
      const child = spawnSync(process.execPath, [runtime, op, ...argv], {
        stdio: "inherit",
      });
      process.exitCode = child.status ?? 2;
      return;
    }
  }
  let result;
  if (op === "setup") {
    if (typeof a.harness === "string") a.harness = a.harness.split(",");
    result = await setup(a);
  } else if (op === "attach" || op === "rebind" || op === "detach") {
    result = lifecycle(op, a);
    if (op !== "detach" && a.apply && !a.dry_run && result.ok) {
      const stages = result.data as Record<string, unknown>;
      const probes: Record<string, unknown> = {
        direct: "not_run",
        mcp: "not_run",
        scope: "standalone_runtime",
        host_reload: "pending",
      };
      stages.probed = probes;
      try {
        execute("bootstrap", { project_root: result.project_root });
        probes.direct = "pass";
        probes.mcp = await probe(
          result.project_root,
          fileURLToPath(import.meta.url),
        );
      } catch {
        probes.failed = true;
        result.warnings.push(
          "Resources committed, but standalone probing failed; inspect doctor and reload the host.",
        );
      }
    }
  } else {
    if (!Object.hasOwn(schemas, op))
      throw new MWFError(
        "UNKNOWN_OPERATION",
        `Unknown operation ${op}. Use --help.`,
      );
    if (
      [
        "add",
        "propose",
        "update",
        "forget",
        "compact",
        "rebuild-index",
      ].includes(op) ||
      (op === "handoff" && a.action === "save")
    )
      a.request_id ??= randomUUID();
    result = execute(op as Operation, a);
  }
  console.log(serialize(result));
  if (!result.ok) process.exitCode = 1;
}
main().catch((e) => {
  const args = process.argv.slice(2),
    at = args.indexOf("--root");
  const output = serialize(
    failure(args[0] ?? "unknown", at >= 0 ? args[at + 1] : "", e),
  );
  if (args[0] === "mcp") console.error(output);
  else console.log(output);
  process.exitCode = 2;
});
