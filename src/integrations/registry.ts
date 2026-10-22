// The only module that knows every harness adapter (refactor plan §2).
// PR-06 registers Codex; Pi still runs through lifecycle until PR-07, after
// which this becomes a total Record<HarnessId, HarnessAdapter>.
import type { HarnessAdapter, HarnessId } from "../contracts/harness.js";
import type { ManagedSurfaceId } from "../contracts/managed-surface.js";
import { codexAdapter } from "./codex/adapter.js";

export const adapters: Readonly<Partial<Record<HarnessId, HarnessAdapter>>> =
  Object.freeze({ codex: codexAdapter });
export function adapterFor(id: HarnessId): HarnessAdapter | undefined {
  return Object.hasOwn(adapters, id) ? adapters[id] : undefined;
}
/** The adapter that declares `surface` as managed, if any. */
export function adapterForSurface(
  surface: ManagedSurfaceId,
): HarnessAdapter | undefined {
  return Object.values(adapters).find((a) =>
    a.managedSurfaces.includes(surface),
  );
}
