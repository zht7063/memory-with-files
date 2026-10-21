import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { zipDirectory } from "./lib/zip.ts";
import { tgzDirectory } from "./lib/tgz.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const out = path.join(root, "releases");
fs.mkdirSync(out, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-release-"));
try {
  const tgz = path.join(
    out,
    `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`,
  );
  const plugin = path.join(scratch, "mwf");
  const runtime = path.join(plugin, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const included = new Set<string>(["package.json", "LICENSE", ...pkg.files]);
  // npm includes the readme regardless of its filename's capitalization.
  for (const name of fs.readdirSync(root))
    if (/^readme(?:\..*)?$/i.test(name)) included.add(name);
  for (const name of included) {
    const source = path.join(root, name);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(runtime, name), { recursive: true });
  }
  // npm applies each bundled package's own publish file list.
  for (const name of pkg.bundleDependencies) {
    const directory = path.join(root, "node_modules", name);
    const dependency = JSON.parse(
      fs.readFileSync(path.join(directory, "package.json"), "utf8"),
    );
    const patterns: string[] = dependency.files;
    const excluded = patterns
      .filter((pattern) => pattern.startsWith("!"))
      .map((pattern) => pattern.slice(1));
    const selected = new Set<string>(["package.json"]);
    for (const pattern of patterns.filter(
      (pattern) => !pattern.startsWith("!"),
    ))
      for (const file of fs.globSync(pattern, {
        cwd: directory,
        exclude: excluded,
      }))
        selected.add(file);
    for (const file of fs.readdirSync(directory))
      if (/^(readme|licen[sc]e|copying)(\..*)?$/i.test(file))
        selected.add(file);
    for (const file of selected)
      fs.cpSync(
        path.join(directory, file),
        path.join(runtime, "node_modules", name, file),
        { recursive: true },
      );
  }
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
  fs.writeFileSync(
    path.join(out, "RELEASE-STATUS.json"),
    JSON.stringify(
      {
        version: pkg.version,
        artifacts: [path.basename(tgz), path.basename(zip)],
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
