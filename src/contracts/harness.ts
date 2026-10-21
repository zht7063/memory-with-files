// L0: harness adapter contract (refactor plan §2). Types and constants only.
// Adapters declare intent; they never write. Lifecycle stages PlannedChanges
// into a Transaction and storage validates every path against the closed
// managed-surface whitelist.
import type { ManagedSurfaceId } from "./managed-surface.js";

export const HARNESS_IDS = Object.freeze(["pi", "codex"] as const);
export type HarnessId = (typeof HARNESS_IDS)[number];
export function isHarnessId(value: unknown): value is HarnessId {
  return (HARNESS_IDS as readonly unknown[]).includes(value);
}

/** A located, validated runtime (same fields lifecycle.locateRuntime returns). */
export interface RuntimeLocation {
  pluginRoot: string;
  /** realpath of the runtime's dist/cli.js */
  runtimePath: string;
  version: string;
}
export interface Conflict {
  path: string;
  reason: string;
}
export interface DiagnosticIssue {
  code: string;
  /** reported as `CODE:<surface path>` */
  surface?: ManagedSurfaceId;
  detail?: string;
}

/** A receipt `owned_resources` entry, keyed by managed surface. */
export type OwnedResource =
  | {
      kind: "block";
      surface: "codex.config.block";
      installed: string;
      created: boolean;
    }
  | {
      kind: "file";
      surface:
        | "legacy.pi.extension"
        | "skill.memory-with-files"
        | "skill.mwf-init"
        | "skill.mwf-status";
      installed_hash: string;
      before: string | null;
    }
  | {
      kind: "json";
      surface: "legacy.pi.mcp";
      installed: unknown;
      before: unknown;
      created: boolean;
    };
export interface PlannedChange {
  surface: ManagedSurfaceId;
  /** null = delete the file */
  after: string | null;
  /** receipt record for an attach; absent for a detach */
  resource?: OwnedResource;
}

export interface HarnessContext {
  /** canonical project root */
  root: string;
  /** injected environment; adapters do not read process.env directly */
  env: Readonly<Record<string, string | undefined>>;
  /** node executable that will run the runtime */
  nodePath: string;
  /** current (staged) content of a managed surface */
  read(surface: ManagedSurfaceId): string | null;
}
export interface ClientReceiptView {
  enabled: boolean;
  ownedCount: number;
  cleanupPending: boolean;
  /** resources to verify; diagnose() checks only those on its own surfaces */
  owned: readonly OwnedResource[];
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  /** must be a subset of MANAGED_SURFACES (tested) */
  readonly managedSurfaces: readonly ManagedSurfaceId[];
  readonly contextInjection: "hook-process" | "in-process-extension";
  /** Locate the installed runtime. Throws PLUGIN_RUNTIME_REQUIRED when none
   * or several are found (the error text is user-visible and kept stable). */
  detect(ctx: HarnessContext, hint?: { pluginRoot?: string }): RuntimeLocation;
  /** Host configuration that blocks attach. */
  conflicts(ctx: HarnessContext): Conflict[];
  /** Changes for attach; throws OWNERSHIP_CONFLICT for unowned/modified state. */
  planAttach(
    ctx: HarnessContext,
    runtime: RuntimeLocation,
    binding: { generation: string; owned: readonly OwnedResource[] },
  ): PlannedChange[];
  /** Changes that undo owned resources; throws if one was modified. */
  planDetach(
    ctx: HarnessContext,
    owned: readonly OwnedResource[],
  ): PlannedChange[];
  /** Host-specific status/doctor checks. */
  diagnose(ctx: HarnessContext, client: ClientReceiptView): DiagnosticIssue[];
  /** Non-fatal warnings shown after a successful attach. */
  attachWarnings?(ctx: HarnessContext): string[];
  /** MCP-side session check for hosts that bind a session reference; throws
   * CONTEXT_REQUIRED when the reference does not belong to this host. */
  resolveSession?(ctx: HarnessContext, sessionRef: string): string | null;
}
