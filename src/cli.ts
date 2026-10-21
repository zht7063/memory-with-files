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
import {
  locateRuntime,
  persistProbe,
  probePersistenceWarning,
} from "./lifecycle/index.js";
import { receipt } from "./storage/receipt.js";
import { Transaction } from "./storage/index.js";
import { lifecycle, setup } from "./setup.js";
const HELP = `MWF — project-local file memory
mwf init --root /project --git-mode track|ignore
mwf attach|rebind --root /project --harness pi|codex [--plugin-root PATH] --apply
mwf setup --root /project [--harness pi|codex] (default: codex; deprecated)
mwf detach --root /project --harness pi|codex|all [--apply]
mwf migrate --root /project --from 0.1 [--legacy-stopped --apply]
mwf bootstrap|recall|get|status|doctor --root /project
status|doctor: --diagnostic-limit 1..100 (default 5)
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
const UNINSTALL_HINT =
  "mwf: to uninstall or detach later, see https://github.com/zht7063/memory-with-files/blob/main/packaging/UNINSTALL.md";
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
    "diagnostic_limit",
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
  if (["attach", "rebind", "setup"].includes(op)) {
    const root = stringArg(a.project_root, "project_root");
    if (!root.trim())
      throw new MWFError("INVALID_INPUT", "project_root must not be empty.");
    if (op !== "setup" && a.harness !== "pi" && a.harness !== "codex")
      throw new MWFError("INVALID_INPUT", "harness must be pi or codex.");
    const harnesses =
      op === "setup"
        ? z
            .array(z.enum(["pi", "codex"]))
            .min(1)
            .parse(
              typeof a.harness === "string"
                ? a.harness.split(",")
                : (a.harness ?? ["codex"]),
            )
        : [a.harness];
    if (harnesses.length > 1) {
      const results = harnesses.map((harness) => {
        const child = spawnSync(
          process.execPath,
          [
            fileURLToPath(import.meta.url),
            "setup",
            "--input",
            JSON.stringify({ ...a, harness }),
          ],
          { encoding: "utf8" },
        );
        if (child.error) throw child.error;
        if (!child.stdout.trim())
          throw new Error(child.stderr || "Setup runtime failed.");
        return JSON.parse(child.stdout) as import("./core.js").Result;
      });
      const result = {
        ...results[0],
        ok: results.every((r) => r.ok),
        data: { clients: results },
        changed_files: [...new Set(results.flatMap((r) => r.changed_files))],
        warnings: [...new Set(results.flatMap((r) => r.warnings))],
      };
      console.log(serialize(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    const harness = harnesses[0];
    if (harness === "pi" || harness === "codex") {
      const target = locateRuntime(
        typeof a.plugin_root === "string" ? a.plugin_root : undefined,
        harness,
        root,
      );
      if (target.entry !== fs.realpathSync(fileURLToPath(import.meta.url))) {
        const version = spawnSync(
          process.execPath,
          [target.entry, "--version"],
          { encoding: "utf8", timeout: 15000 },
        );
        if (
          version.error ||
          version.status !== 0 ||
          version.stdout.trim() !== target.version
        )
          throw new MWFError(
            "RUNTIME_MISMATCH",
            "Installed runtime executable does not match its package version.",
          );
        const child = spawnSync(
          process.execPath,
          [target.entry, op, ...argv, "--plugin-root", target.plugin_root],
          { stdio: "inherit" },
        );
        if (child.error) throw child.error;
        process.exitCode = child.status ?? 2;
        return;
      }
    }
  }
  let result: import("./core.js").Result;
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
      const harness = a.harness as "pi" | "codex";
      const binding = receipt(new Transaction(result.project_root))!.clients[
        harness
      ]!;
      Object.assign(probes, {
        source: "attach_standalone",
        time: new Date().toISOString(),
        root: result.project_root,
        runtime_path: binding.runtime_path,
        runtime_version: RUNTIME_VERSION,
        api_version: 2,
        binding_generation: binding.binding_generation,
        host_confirmed: "unknown",
      });
      for (const stage of ["direct", "mcp"] as const) {
        try {
          if (stage === "direct") {
            const direct = execute("bootstrap", {
              project_root: result.project_root,
            });
            if (!direct.ok) throw new Error(JSON.stringify(direct));
            probes.direct = "pass";
          } else
            probes.mcp = await probe(
              result.project_root,
              fileURLToPath(import.meta.url),
            );
        } catch (error) {
          probes[stage] = { result: "fail", error: String(error) };
          probes.failed = true;
          stages.state = "configured/degraded";
          result.warnings.push(
            `${stage} standalone probing failed; reload and verify the host.`,
          );
        }
      }
      try {
        result.changed_files.push(
          ...persistProbe(
            result.project_root,
            harness,
            binding.binding_generation!,
            probes,
          ).filter((file) => !result.changed_files.includes(file)),
        );
      } catch (error) {
        const warning = probePersistenceWarning(error);
        stages.state = "configured/degraded";
        probes.failed = true;
        result.warnings.push(warning);
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
  // stdout stays pure JSON for hosts; the human hint goes to stderr only.
  else if (!a.dry_run && (op === "init" || (op === "attach" && a.apply)))
    console.error(UNINSTALL_HINT);
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
