/** Bootstrap entry point: runs on Node 22.16+ without installed dependencies. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HELP = `Usage: node --experimental-strip-types scripts/install-mwf.ts --root PROJECT --git-mode track|ignore [options]
  --harness codex|pi|codex,pi   Clients to configure (default: codex)
  --prefix DIRECTORY          Runtime location (default: ~/.local/share/mwf)
  --package FILE.tgz          Install a prebuilt bundle; otherwise build this checkout
  --no-install-pi-adapter     Require the pinned Pi adapter already installed
  --dry-run                  Print the installation plan without writing files
  --help                     Show this help
Requires Node >=22.16 and npm; Pi must be installed when selected.`;
function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
try {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      "git-mode": { type: "string" },
      harness: { type: "string", default: "codex" },
      prefix: {
        type: "string",
        default: path.join(os.homedir(), ".local/share/mwf"),
      },
      package: { type: "string" },
      "no-install-pi-adapter": { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) console.log(HELP);
  else {
    if (
      !values.root ||
      !fs.existsSync(values.root) ||
      !fs.statSync(values.root).isDirectory()
    )
      throw new Error("--root must name an existing project directory");
    if (!["track", "ignore"].includes(values["git-mode"] ?? ""))
      throw new Error("--git-mode must be track or ignore");
    if (!["codex", "pi", "codex,pi", "pi,codex"].includes(values.harness))
      throw new Error("Invalid --harness");
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 16))
      throw new Error("Node >=22.16 is required");
    run("npm", ["--version"]);
    if (values.harness.includes("pi")) run("pi", ["--version"]);
    const project = fs.realpathSync(values.root),
      prefix = path.resolve(values.prefix);
    let bundle = values.package ? fs.realpathSync(values.package) : undefined;
    if (bundle && !fs.statSync(bundle).isFile())
      throw new Error(`Package not found: ${bundle}`);
    const repo = fileURLToPath(new URL("../", import.meta.url));
    const packageRoot = repo;
    if (!bundle && !fs.existsSync(path.join(packageRoot, "package.json")))
      throw new Error(
        "Run from a source checkout or supply --package FILE.tgz",
      );
    console.log(
      `Project: ${project}\nRuntime: ${prefix}\nClients: ${values.harness}\nGit mode: ${values["git-mode"]}`,
    );
    if (values["dry-run"])
      console.log(
        `Would install ${bundle ?? "a fresh build of this checkout"}, then run MWF setup (including MCP probe). No files changed.`,
      );
    else {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-install-"));
      try {
        const cache = path.join(scratch, "cache");
        if (!bundle) {
          console.log("Installing build dependencies and building MWF…");
          console.log(
            run("npm", [
              "ci",
              "--prefix",
              packageRoot,
              "--cache",
              cache,
              "--no-audit",
              "--no-fund",
            ]),
          );
          console.log(run("npm", ["run", "build", "--prefix", packageRoot]));
          const packed: unknown = JSON.parse(
            run(
              "npm",
              [
                "pack",
                "--ignore-scripts",
                "--json",
                "--pack-destination",
                scratch,
                "--cache",
                cache,
              ],
              packageRoot,
            ),
          );
          const entries: unknown[] = Array.isArray(packed)
            ? packed
            : packed && typeof packed === "object"
              ? Object.values(packed)
              : [];
          const first = entries[0];
          if (
            !first ||
            typeof first !== "object" ||
            !("filename" in first) ||
            typeof first.filename !== "string"
          )
            throw new Error("npm pack did not return a filename");
          bundle = path.join(scratch, first.filename);
        }
        console.log(
          run("npm", [
            "install",
            "--prefix",
            prefix,
            "--ignore-scripts",
            "--offline",
            "--no-audit",
            "--no-fund",
            "--cache",
            cache,
            bundle,
          ]),
        );
        const cli = path.join(prefix, "node_modules/@zht7063/mwf/dist/cli.js");
        if (!fs.existsSync(cli))
          throw new Error("Bundle did not install @zht7063/mwf");
        console.log(run(process.execPath, [cli, "--version"]));
        try {
          console.log(
            run(process.execPath, [
              cli,
              "setup",
              "--root",
              project,
              "--harness",
              values.harness,
              "--git-mode",
              values["git-mode"]!,
              ...(values["no-install-pi-adapter"]
                ? ["--no-install-pi-adapter"]
                : []),
            ]),
          );
        } catch (error) {
          throw new Error(
            `Setup failed. The runtime and any completed setup steps are retained; resolve the reported issue and rerun this command.\n${error instanceof Error ? error.message : String(error)}`,
          );
        }
        console.log(
          `Installed. Restart/reload the selected client and trust the project.\nCLI: ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)}`,
        );
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
} catch (error) {
  console.error(
    `MWF installer: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
