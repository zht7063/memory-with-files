#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execute, Operation, schemas } from "./core.js";
import { MWFError } from "./storage.js";
import { serve } from "./mcp.js";
import { detach, setup } from "./setup.js";
const HELP = `MWF — project-local file memory\n\nmwf setup --root /project --harness codex,pi --git-mode track\nmwf mcp --root /project\nmwf bootstrap|recall|status|doctor --root /project\nmwf add|propose --root /project --type preference --title ... --summary ... --body ...\nmwf handoff|update|process-inbox|duplicates|compact|rebuild-index|migrate|forget --root /project\nmwf detach --root /project [--apply]\n\nAll operations emit JSON. Use --input JSON or --input-file FILE for structured input.\nUse --scope JSON for record routing. --path/--tool/--component/--operation flags are repeatable.\nMaintenance previews by default; --apply commits. init/setup require --git-mode track|ignore.\nsetup --dry-run previews; --no-install-pi-adapter requires the pinned adapter already configured.\nMCP servers are bound to one explicit root. --help shows this help; --version shows package version.\n`;
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
  const booleans = new Set(["apply", "dry_run", "redact"]);
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
  for (const key of ["item", "limit", "threshold"])
    if (input[key] !== undefined) input[key] = Number(input[key]);
  if (typeof input.harness === "string")
    input.harness = input.harness.split(",");
  if (typeof input.scope === "string") input.scope = JSON.parse(input.scope);
  return input;
}
async function main() {
  const [op, ...argv] = process.argv.slice(2);
  if (!op || op === "--help" || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  if (op === "--version") {
    console.log("0.1.0");
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
    if (Object.keys(a).some((k) => k !== "project_root") || !a.project_root)
      throw new MWFError("INVALID_INPUT", "mcp requires --root only.");
    await serve(stringArg(a.project_root, "root"));
    return;
  }
  let result;
  if (op === "setup") result = await setup(a);
  else if (op === "detach") {
    if (
      Object.keys(a).some((k) => !["project_root", "apply"].includes(k)) ||
      !a.project_root
    )
      throw new MWFError(
        "INVALID_INPUT",
        "detach requires --root and optional --apply.",
      );
    result = detach(stringArg(a.project_root, "root"), a.apply === true);
  } else {
    if (!Object.hasOwn(schemas, op))
      throw new MWFError(
        "UNKNOWN_OPERATION",
        `Unknown operation ${op}. Use --help.`,
      );
    result = execute(op as Operation, a);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
main().catch((e) => {
  const error =
    e instanceof MWFError
      ? { code: e.code, message: e.message }
      : { code: "IO_ERROR", message: e.message };
  console.error(JSON.stringify({ ok: false, error }));
  process.exitCode = 2;
});
