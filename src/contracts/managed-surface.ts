// Closed whitelist of project files MWF may create, modify or delete outside
// `.mwf/`. There is deliberately no registration or extension API: the object
// and every entry are frozen, and ManagedSurfaceId is a closed literal union.
// storage/ is the only layer that validates paths against this list.
//
// 0.3: the 0.1 legacy paths (`.pi/mcp.json`, `.pi/extensions/mwf.js`,
// `.agents/skills/*`) are no longer managed. 0.2 attach never wrote them.
export type ManagedSurfaceKind = "block" | "file";
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

/** Resources a v2 receipt (0.2.x) could own that 0.3 no longer manages. They
 * are recognised only so a v2 receipt still holding them fails closed with
 * LEGACY_RESOURCE_PENDING instead of INVALID_CONFIG; never writable. */
export const LEGACY_V2_RESOURCES = Object.freeze({
  file: Object.freeze([
    ".pi/extensions/mwf.js",
    ".agents/skills/memory-with-files/SKILL.md",
    ".agents/skills/mwf-init/SKILL.md",
    ".agents/skills/mwf-status/SKILL.md",
  ] as const),
  json: Object.freeze([".pi/mcp.json"] as const),
});
