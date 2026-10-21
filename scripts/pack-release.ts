import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { zipDirectory } from "./lib/zip.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const out = path.join(root, "releases");
fs.mkdirSync(out, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-release-"));
try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        out,
        "--cache",
        path.join(scratch, "cache"),
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const tgz = path.join(out, packed[0].filename),
    plugin = path.join(scratch, "mwf");
  fs.mkdirSync(plugin);
  execFileSync("tar", ["-xzf", tgz, "-C", scratch]);
  fs.renameSync(path.join(scratch, "package"), path.join(plugin, "runtime"));
  fs.cpSync(
    path.join(root, "packaging/codex/plugin.json"),
    path.join(plugin, "plugin.json"),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(plugin, "plugin.json"), "utf8"),
  );
  manifest.version = pkg.version;
  fs.writeFileSync(
    path.join(plugin, "plugin.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  fs.cpSync(
    path.join(root, "packaging/codex/hooks"),
    path.join(plugin, "hooks"),
    { recursive: true },
  );
  fs.cpSync(path.join(root, "assets/skills"), path.join(plugin, "skills"), {
    recursive: true,
  });
  const zip = path.join(out, `mwf-codex-${pkg.version}.zip`);
  fs.rmSync(zip, { force: true });
  zipDirectory(plugin, zip);
  const sums =
    [tgz, zip]
      .map(
        (file) =>
          createHash("sha256").update(fs.readFileSync(file)).digest("hex") +
          "  " +
          path.basename(file),
      )
      .join("\n") + "\n";
  fs.writeFileSync(path.join(out, "SHA256SUMS"), sums);
  fs.writeFileSync(
    path.join(out, "RELEASE-STATUS.json"),
    JSON.stringify(
      {
        version: pkg.version,
        publishable: false,
        reason:
          "Requires complete 44-item evidence, both real hosts, performance report and desktop workflow verification.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    sums + "Artifacts assembled; release approval gates are not implied.",
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
