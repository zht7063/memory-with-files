import { z } from "zod";
import { isHarnessId, type HarnessId } from "./harness.js";

// Host load confirmation lives inside the free-form per-client `probe` object of
// `.mwf/local/integration.json` (`probe.host_confirmation`, `probe.host_confirmed`).
// The receipt schema is strict, so a new top-level client field would make older
// 0.3.x runtimes reject the whole receipt (status/doctor INVALID, detach fails);
// `probe` is `Record<string, unknown>` for them, so the record is invisible to
// older runtimes and receipt_version stays 3. attach/rebind replace `probe`
// wholesale, so a new reload always starts unconfirmed.
const channelRecord = z
  .object({
    time: z.string(),
    host_version: z.string().nullable(),
    host_name: z.string().nullable(),
    trigger: z.string(),
  })
  .strict();
const confirmation = z
  .object({
    binding_generation: z.string(),
    runtime_version: z.string(),
    hook: channelRecord.optional(),
    extension: channelRecord.optional(),
    mcp: channelRecord.optional(),
  })
  .strict();
export type HostChannel = "hook" | "extension" | "mcp";
export type ChannelRecord = z.infer<typeof channelRecord>;
export type HostConfirmation = z.infer<typeof confirmation>;

/** The channel whose activity proves the host loaded and trusted the
 * integration. Codex hooks need an explicit trust review, so an MCP connection
 * alone proves nothing about them; Pi's in-process extension is the host load. */
export const REQUIRED_CHANNEL: Readonly<Record<HarnessId, HostChannel>> =
  Object.freeze({ codex: "hook", pi: "extension" });
export const requiredChannel = (client: string): HostChannel =>
  isHarnessId(client) ? REQUIRED_CHANNEL[client] : "mcp";

type ClientLike = {
  probe?: Record<string, unknown>;
  binding_generation?: string;
  runtime_version?: string;
};
/** The recorded confirmation if it belongs to the client's current binding
 * generation and runtime version; stale or malformed records read as absent. */
export function currentConfirmation(
  client: ClientLike,
): HostConfirmation | undefined {
  const parsed = confirmation.safeParse(client.probe?.host_confirmation);
  return parsed.success &&
    parsed.data.binding_generation === client.binding_generation &&
    parsed.data.runtime_version === client.runtime_version
    ? parsed.data
    : undefined;
}

/** Single source of truth for status/doctor and for the `probe.host_confirmed`
 * mirror: confirmed iff the required channel has fired for this binding. */
export function hostLoad(clientName: string, client: ClientLike) {
  const required = requiredChannel(clientName),
    found = currentConfirmation(client),
    record = found?.[required];
  const channels: Record<string, "confirmed" | "pending"> = {};
  for (const channel of [required, "mcp"] as HostChannel[])
    channels[channel] = found?.[channel] ? "confirmed" : "pending";
  // Codex hooks carry no version; the MCP clientInfo of the same host fills it.
  const versioned = record?.host_version
    ? record
    : [found?.hook, found?.extension, found?.mcp].find((r) => r?.host_version);
  return {
    confirmed: !!record,
    required,
    channels,
    record,
    host_version: versioned?.host_version ?? null,
    host_name: record?.host_name ?? versioned?.host_name ?? null,
  };
}
