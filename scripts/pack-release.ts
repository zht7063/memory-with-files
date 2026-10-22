import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { zipDirectory } from "./lib/zip.ts";
import { extractTgz, tgzDirectory } from "./lib/tgz.ts";
import { decide } from "./lib/release-decision.ts";
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
        scratch,
        "--cache",
        path.join(scratch, "cache"),
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const tgz = path.join(out, packed[0].filename);
  const plugin = path.join(scratch, "mwf");
  const runtime = path.join(plugin, "runtime");
  extractTgz(fs.readFileSync(path.join(scratch, packed[0].filename)), scratch);
  fs.mkdirSync(plugin);
  fs.renameSync(path.join(scratch, "package"), runtime);
  tgzDirectory(runtime, tgz);
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
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const decision = decide(root, commit);
  fs.writeFileSync(
    path.join(out, "RELEASE-STATUS.json"),
    JSON.stringify(
      {
        version: pkg.version,
        artifacts: [path.basename(tgz), path.basename(zip)],
        ...decision,
        reason: decision.publishable
          ? "All Linux CLI harnesses passed for this commit (criteria linux-cli-harness/1)."
          : "Linux CLI harness evidence missing, stale or failing; see items.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    sums +
      `publishable: ${decision.publishable} (${decision.items.map((i) => `${i.item}=${i.status}`).join(", ")})`,
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
