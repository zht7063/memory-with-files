// Closed whitelist of project files MWF may create, modify or delete outside
// `.mwf/`. There is deliberately no registration or extension API: the object
// and every entry are frozen, and ManagedSurfaceId is a closed literal union.
// storage/ is the only layer that validates paths against this list.
//
// Entries marked legacy are 0.1 artifacts still accepted by 0.2.x; PR-08 removes
// them. PR-07 confirmed that 0.2 attach never installs `.agents/skills/*` (the
// skills ship inside the Codex plugin / Pi package); those entries are 0.1
// legacy too and stay only so 0.2 can still detach/migrate 0.1 receipts.
export type ManagedSurfaceKind = "block" | "file" | "json";
type Surface = { readonly path: string; readonly kind: ManagedSurfaceKind };

function surfaces<const T extends Record<string, Surface>>(
  table: T,
): Readonly<{ [K in keyof T]: Readonly<T[K]> }> {
  for (const entry of Object.values(table)) Object.freeze(entry);
  return Object.freeze(table);
}

export const MANAGED_SURFACES = surfaces({
  "agents.block": { path: "AGENTS.md", kind: "block" },
  gitignore: { path: ".gitignore", kind: "file" },
  "codex.config.block": { path: ".codex/config.toml", kind: "block" },
  /** legacy 0.1 skill copies (0.2 attach does not write them); removed in PR-08 */
  "skill.memory-with-files": {
    path: ".agents/skills/memory-with-files/SKILL.md",
    kind: "file",
  },
  "skill.mwf-init": { path: ".agents/skills/mwf-init/SKILL.md", kind: "file" },
  "skill.mwf-status": {
    path: ".agents/skills/mwf-status/SKILL.md",
    kind: "file",
  },
  /** legacy 0.1 Pi MCP config; removed in PR-08 */
  "legacy.pi.mcp": { path: ".pi/mcp.json", kind: "json" },
  /** legacy 0.1 Pi extension copy; removed in PR-08 */
  "legacy.pi.extension": { path: ".pi/extensions/mwf.js", kind: "file" },
});

export type ManagedSurfaceId = keyof typeof MANAGED_SURFACES;
export type ManagedPath = (typeof MANAGED_SURFACES)[ManagedSurfaceId]["path"];
export const SURFACE_IDS = Object.freeze(
  Object.keys(MANAGED_SURFACES) as ManagedSurfaceId[],
);
export const MANAGED_PATHS: readonly ManagedPath[] = Object.freeze(
  SURFACE_IDS.map((id) => MANAGED_SURFACES[id].path),
);

/** Directories that may hold an interrupted atomic-write temp file of a
 * managed path: the parent directories of MANAGED_PATHS ("" = project root). */
export const TEMP_SCAN_DIRS: readonly string[] = Object.freeze([
  ...new Set(
    MANAGED_PATHS.map((p) =>
      p.includes("/") ? p.replace(/\/[^/]+$/, "") : "",
    ),
  ),
]);

export const MWF_DIR = ".mwf";
export const JOURNAL_PATH = ".mwf/local/transaction.json";
/** `.mwf/**` is MWF-owned except the runtime database and the journal itself. */
export function isMwfOwned(file: string) {
  return (
    file.startsWith(`${MWF_DIR}/`) &&
    !file.includes("runtime.sqlite") &&
    file !== JOURNAL_PATH
  );
}

/** The surface whose path is exactly `file`, if any (no normalization). */
export function surfaceOf(file: string): ManagedSurfaceId | undefined {
  return SURFACE_IDS.find((id) => MANAGED_SURFACES[id].path === file);
}
