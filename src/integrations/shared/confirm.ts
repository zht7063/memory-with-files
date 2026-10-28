import {
  Transaction,
  withProjectLock,
  withLockDeadline,
  recover,
} from "../../storage/index.js";
import { receipt, receiptFile } from "../../storage/receipt.js";
import type { Binding } from "./binding.js";
import { RUNTIME_VERSION } from "../../contracts/version.js";
import {
  currentConfirmation,
  hostLoad,
  type HostChannel,
} from "../../contracts/host-confirmation.js";

export type HostTrigger = {
  /** Which kind of host activity this is. */
  channel: HostChannel;
  /** What reached the runtime: `hook:SessionStart`, `extension:session_start`,
   * `mcp:<operation>` ... */
  trigger: string;
  /** Host version/name when the host reports one (MCP clientInfo, hook or
   * extension payload); null when it does not. */
  hostVersion?: string | null;
  hostName?: string | null;
};

// First confirmation runs inside hooks and the MCP event loop: wait for the
// project lock only briefly and retry on the next trigger instead of delaying
// the host.
export const CONFIRM_LOCK_WAIT_MS = 250;

/** Record that the host really loaded this integration. The first hook run,
 * extension start or MCP call after attach/rebind writes
 * `probe.host_confirmation.<channel>` (time, host version, trigger) into
 * `.mwf/local/integration.json`; `probe.host_confirmed` flips from "unknown" to
 * "confirmed" once the channel that proves the load (hostLoad().required: the
 * Codex hook, the Pi extension) has fired. Later calls are a cheap read; a
 * version missing from the first trigger may be filled in once. Best effort: it
 * never throws and never waits long for the lock, so it cannot break or delay a
 * hook, an extension start or a tool call. Returns true when this caller has
 * nothing left to record (a long-lived caller can stop checking). */
export function confirmHostLoad(binding: Binding, t: HostTrigger): boolean {
  try {
    const clientOf = (tx: Transaction) => {
      const client = receipt(tx)?.clients[binding.harness];
      return client?.enabled &&
        client.binding_generation === binding.generation &&
        client.runtime_version === RUNTIME_VERSION
        ? client
        : undefined;
    };
    const needs = (tx: Transaction) => {
      const client = clientOf(tx);
      if (!client) return false;
      const record = currentConfirmation(client)?.[t.channel];
      return !record || (!record.host_version && !!t.hostVersion);
    };
    if (!needs(new Transaction(binding.root))) return true;
    return withLockDeadline(CONFIRM_LOCK_WAIT_MS, () =>
      withProjectLock(binding.root, () => {
        recover(binding.root);
        const tx = new Transaction(binding.root);
        if (!needs(tx)) return true;
        const r = receipt(tx)!,
          client = r.clients[binding.harness]!;
        // A stale record (other generation/runtime) is dropped, not extended.
        const found = currentConfirmation(client) ?? {
          binding_generation: binding.generation,
          runtime_version: RUNTIME_VERSION,
        };
        const previous = found[t.channel];
        found[t.channel] = {
          time: previous?.time ?? new Date().toISOString(),
          host_version: previous?.host_version ?? t.hostVersion ?? null,
          host_name: previous?.host_name ?? t.hostName ?? null,
          trigger: previous?.trigger ?? t.trigger,
        };
        client.probe = {
          ...client.probe,
          host_confirmation: found,
          host_confirmed: hostLoad(binding.harness, {
            ...client,
            probe: { host_confirmation: found },
          }).confirmed
            ? "confirmed"
            : "unknown",
        };
        tx.set(receiptFile, JSON.stringify(r, null, 2) + "\n");
        tx.commit();
        return true;
      }),
    );
  } catch {
    return false;
  }
}
