// The only module that knows every harness adapter (refactor plan §2).
import path from "node:path";
import type {
  DiagnosticIssue,
  HarnessAdapter,
  HarnessContext,
  HarnessId,
  OwnedResource,
} from "../contracts/harness.js";
import { isHarnessId } from "../contracts/harness.js";
import {
  MANAGED_SURFACES,
  surfaceOf,
  type ManagedSurfaceId,
} from "../contracts/managed-surface.js";
import { codexAdapter } from "./codex/adapter.js";
import { piAdapter } from "./pi/adapter.js";

export const adapters: Readonly<Record<HarnessId, HarnessAdapter>> =
  Object.freeze({ pi: piAdapter, codex: codexAdapter });
export function adapterFor(id: HarnessId): HarnessAdapter {
  return adapters[id];
}
/** The adapter that declares `surface` as managed, if any. */
export function adapterForSurface(
  surface: ManagedSurfaceId,
): HarnessAdapter | undefined {
  return Object.values(adapters).find((a) =>
    a.managedSurfaces.includes(surface),
  );
}
/** Adapter view of a project; `get` reads a project-relative path (usually a
 * Transaction, so staged content is visible). */
export function harnessContext(
  root: string,
  get: (file: string) => string | null,
): HarnessContext {
  return {
    root,
    env: process.env,
    nodePath: process.execPath,
    read: (surface) => get(MANAGED_SURFACES[surface].path),
  };
}
type ReceiptResource = {
  kind: string;
  path: string;
  installed?: unknown;
  installed_hash?: string;
  before?: unknown;
  created?: boolean;
};
/** Map a receipt resource to its surface-keyed form; throws when the path is
 * not a managed surface of that kind (schema prevents this for valid receipts). */
export function toOwned(resource: ReceiptResource): OwnedResource {
  const surface = surfaceOf(resource.path);
  if (!surface || MANAGED_SURFACES[surface].kind !== resource.kind)
    throw new Error(`unmanaged resource ${resource.path}`);
  return { ...resource, surface } as unknown as OwnedResource;
}

/** Host-specific status/doctor issues for one receipt client, as strings
 * (`CODE` or `CODE:detail`). Injected into Core by the entry layer. */
export function hostIssues(
  client: string,
  root: string,
  get: (file: string) => string | null,
  receiptClient: {
    enabled: boolean;
    cleanup_pending: boolean;
    owned_resources: readonly ReceiptResource[];
  },
  options: { conflicts: boolean },
): string[] {
  if (!isHarnessId(client)) return [];
  const ctx = harnessContext(root, get);
  const adapter = adapterFor(client);
  const format = (i: DiagnosticIssue) => {
    const detail =
      i.detail ?? (i.surface ? MANAGED_SURFACES[i.surface].path : undefined);
    return detail === undefined ? i.code : `${i.code}:${detail}`;
  };
  const issues = adapter
    .diagnose(ctx, {
      enabled: receiptClient.enabled,
      ownedCount: receiptClient.owned_resources.length,
      cleanupPending: receiptClient.cleanup_pending,
      owned: [],
    })
    .map(format);
  const ownedPaths = new Set<string>();
  for (const resource of receiptClient.owned_resources) {
    ownedPaths.add(path.join(root, resource.path));
    try {
      const owned = toOwned(resource);
      const owner = adapterForSurface(owned.surface);
      if (!owner) throw new Error("no owner");
      issues.push(
        ...owner
          .diagnose(ctx, {
            enabled: true,
            ownedCount: 1,
            cleanupPending: false,
            owned: [owned],
          })
          .map(format),
      );
    } catch {
      issues.push(`OWNERSHIP_CONFLICT:${resource.path}`);
    }
  }
  if (options.conflicts)
    try {
      for (const conflict of adapter.conflicts(ctx)) {
        // An entry this receipt owns is MWF's own (verified above), not a conflict.
        if (ownedPaths.has(path.resolve(conflict.path))) continue;
        issues.push(`OWNERSHIP_CONFLICT:${conflict.path}: ${conflict.reason}`);
      }
    } catch (e) {
      issues.push(
        `OWNERSHIP_CONFLICT:${e instanceof Error ? e.message : String(e)}`,
      );
    }
  return issues;
}
