import { Transaction, withProjectLock, recover } from "../../storage/index.js";
import { receipt, receiptFile } from "../../storage/receipt.js";
import type { Binding } from "./binding.js";
import { RUNTIME_VERSION } from "../../contracts/version.js";

export type HostTrigger = {
  /** What reached the runtime: `hook:SessionStart`, `hook:UserPromptSubmit`,
   * `extension:session_start`, `mcp:<operation>` ... */
  trigger: string;
  /** Host version/name when the host reports one (MCP clientInfo, hook or
   * extension payload); null when it does not. */
  hostVersion?: string | null;
  hostName?: string | null;
};

/** Record that the host really loaded this integration: the first hook run,
 * extension start or MCP call after attach/rebind writes
 * `clients.<harness>.host_confirmation` into `.mwf/local/integration.json`
 * and flips `probe.host_confirmed` from "unknown" to "confirmed". Later calls
 * are a cheap read; a version missing from the first trigger may be filled in
 * once. Best effort: it never throws, so a failure cannot break a hook, an
 * extension start or a tool call. Returns true once the integration is
 * confirmed (a long-lived caller can then stop checking), else false. */
export function confirmHostLoad(binding: Binding, t: HostTrigger): boolean {
  try {
    const current = (tx: Transaction) => {
      const client = receipt(tx)?.clients[binding.harness];
      return client?.enabled &&
        client.binding_generation === binding.generation &&
        client.runtime_version === RUNTIME_VERSION
        ? client
        : undefined;
    };
    const needs = (tx: Transaction) => {
      const client = current(tx);
      if (!client) return false;
      const c = client.host_confirmation;
      if (
        c &&
        c.binding_generation === binding.generation &&
        c.runtime_version === RUNTIME_VERSION
      )
        return !c.host_version && !!t.hostVersion;
      return true;
    };
    if (!needs(new Transaction(binding.root)))
      return !!current(new Transaction(binding.root));
    return withProjectLock(binding.root, () => {
      recover(binding.root);
      const tx = new Transaction(binding.root);
      if (!needs(tx)) return !!current(tx);
      const r = receipt(tx)!,
        client = r.clients[binding.harness]!,
        previous = client.host_confirmation;
      client.host_confirmation = previous ?? {
        time: new Date().toISOString(),
        host_version: null,
        host_name: null,
        trigger: t.trigger,
        binding_generation: binding.generation,
        runtime_version: RUNTIME_VERSION,
      };
      if (t.hostVersion && !client.host_confirmation.host_version) {
        client.host_confirmation.host_version = t.hostVersion;
        client.host_confirmation.host_name ??= t.hostName ?? null;
      }
      if (client.probe) client.probe.host_confirmed = "confirmed";
      tx.set(receiptFile, JSON.stringify(r, null, 2) + "\n");
      tx.commit();
      return true;
    });
  } catch {
    return false;
  }
}
