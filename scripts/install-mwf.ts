/** Install a prebuilt runtime; project initialization and host enablement are separate. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
try {
  const { values } = parseArgs({
    options: {
      package: { type: "string" },
      prefix: {
        type: "string",
        default: path.join(os.homedir(), ".local/share/mwf"),
      },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(
      "install-mwf --package FILE.tgz [--prefix DIRECTORY] [--dry-run]\nInstalls only the runtime. Then explicitly init and attach each project. Node >=22.19 required.",
    );
  else {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19))
      throw Error("Node >=22.19 required");
    if (!values.package)
      throw Error(
        "Supply --package FILE.tgz; installation does not build a checkout.",
      );
    const bundle = fs.realpathSync(values.package),
      prefix = path.resolve(values.prefix);
    if (!fs.statSync(bundle).isFile()) throw Error("Package must be a file");
    if (values["dry-run"])
      console.log(`Would install ${bundle} into ${prefix}. No files changed.`);
    else {
      const cache = fs.mkdtempSync(
        path.join(os.tmpdir(), "mwf-installer-cache-"),
      );
      try {
        execFileSync(
          "npm",
          [
            "install",
            "--cache",
            cache,
            "--prefix",
            prefix,
            "--offline",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            bundle,
          ],
          { stdio: "inherit" },
        );
        const cli = path.join(prefix, "node_modules/@zht7063/mwf/dist/cli.js");
        console.log(
          execFileSync(process.execPath, [cli, "--version"], {
            encoding: "utf8",
          }).trim(),
        );
        console.log(
          "Installed runtime only. Project data and host configuration were not changed.",
        );
      } finally {
        fs.rmSync(cache, { recursive: true, force: true });
      }
    }
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
