// Host-neutral runtime selection used by every adapter's detect().
import fs from "node:fs";
import path from "node:path";
import { MWFError } from "../../storage/index.js";

export function jsonObject(raw: string | null): Record<string, unknown> {
  const value = JSON.parse(raw ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MWFError("INVALID_CONFIG", "Expected JSON object.");
  return value;
}

/** Validate candidates and require exactly one distinct runtime entry.
 * `runtimeRoot` maps a candidate to its package directory; `check` adds the
 * host-specific validation (throw to reject). */
export function selectRuntime(
  candidates: readonly string[],
  pluginRoot: string | undefined,
  runtimeRoot: (base: string) => string,
  check: (
    base: string,
    runtimeRoot: string,
    pkg: Record<string, unknown> & { version: string },
  ) => void,
) {
  const valid: { plugin_root: string; entry: string; version: string }[] = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const base = fs.realpathSync(candidate);
      const root = runtimeRoot(base);
      const pkg = jsonObject(
        fs.readFileSync(path.join(root, "package.json"), "utf8"),
      );
      if (pkg.name !== "@zht7063/mwf" || typeof pkg.version !== "string")
        throw Error("Invalid runtime package");
      check(base, root, { ...pkg, version: pkg.version });
      const entry = fs.realpathSync(path.join(root, "dist/cli.js"));
      if (!valid.some((v) => v.entry === entry))
        valid.push({ plugin_root: base, entry, version: pkg.version });
    } catch (error) {
      if (pluginRoot)
        throw new MWFError(
          "PLUGIN_RUNTIME_REQUIRED",
          `Invalid plugin runtime: ${String(error)}`,
        );
    }
  }
  if (valid.length !== 1)
    throw new MWFError(
      "PLUGIN_RUNTIME_REQUIRED",
      valid.length
        ? "Multiple installed runtimes; specify --plugin-root."
        : "Cannot locate an installed plugin runtime; specify --plugin-root.",
    );
  return valid[0]!;
}
