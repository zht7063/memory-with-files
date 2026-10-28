import { z } from "zod";
import { Transaction, MWFError, atomicWrite } from "./index.js";
import {
  LEGACY_V2_RESOURCES,
  MANAGED_SURFACES,
} from "../contracts/managed-surface.js";
export const receiptFile = ".mwf/local/integration.json";
export const RECEIPT_VERSION = 3;

// v3: the only resource a receipt can own is the Codex config block. Objects
// are strict so unknown fields fail with INVALID_CONFIG.
const blockResource = z
  .object({
    kind: z.literal("block"),
    path: z.literal(MANAGED_SURFACES["codex.config.block"].path),
    installed: z.string(),
    created: z.boolean(),
  })
  .strict();
export const resourceSchema = z.discriminatedUnion("kind", [blockResource]);
// Written by the first hook / extension start / MCP call that reaches the
// runtime after attach. Every attach/rebind rebuilds the client entry, so a
// re-attach (new reload) starts unconfirmed again.
const hostConfirmationSchema = z
  .object({
    time: z.string(),
    host_version: z.string().nullable(),
    host_name: z.string().nullable(),
    trigger: z.string(),
    binding_generation: z.string(),
    runtime_version: z.string(),
  })
  .strict();
function client<T extends z.ZodTypeAny>(resource: T) {
  return z
    .object({
      enabled: z.boolean(),
      probe: z.record(z.unknown()).optional(),
      host_confirmation: hostConfirmationSchema.optional(),
      binding_generation: z.string().optional(),
      runtime_version: z.string().optional(),
      api_version: z.number().optional(),
      runtime_path: z.string().optional(),
      node_path: z.string().optional(),
      owned_resources: z.array(resource).default([]),
      cleanup_pending: z.boolean().default(false),
    })
    .strict();
}
export const clientSchema = client(resourceSchema);
function receiptOf<V extends number, C extends z.ZodTypeAny>(v: V, c: C) {
  return z
    .object({
      receipt_version: z.literal(v),
      canonical_root: z.string(),
      clients: z.object({ pi: c.optional(), codex: c.optional() }).strict(),
    })
    .strict();
}
export const receiptSchema = receiptOf(RECEIPT_VERSION, clientSchema);

// v2 (0.2.x) additionally allowed the 0.1 legacy resources. They are accepted
// here only to report them; anything else fails as before.
const v2Resource = z.discriminatedUnion("kind", [
  blockResource,
  z
    .object({
      kind: z.literal("file"),
      path: z.enum(LEGACY_V2_RESOURCES.file),
      installed_hash: z.string(),
      before: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("json"),
      path: z.enum(LEGACY_V2_RESOURCES.json),
      installed: z.unknown(),
      before: z.unknown(),
      created: z.boolean(),
    })
    .strict(),
]);
const receiptV2Schema = receiptOf(2, client(v2Resource));

export type Harness = "pi" | "codex";
export type Receipt = z.infer<typeof receiptSchema>;

/** Parse a stored receipt. A v2 receipt is upgraded in memory to v3; if it
 * still owns resources 0.3 no longer manages, fail closed: nothing is
 * written and the user must detach them with 0.2.x first. */
export function parseReceipt(value: unknown): Receipt {
  const version =
    value && typeof value === "object"
      ? (value as { receipt_version?: unknown }).receipt_version
      : undefined;
  if (version === 2) {
    const v2 = receiptV2Schema.safeParse(value);
    if (!v2.success)
      throw new MWFError("INVALID_CONFIG", "Invalid integration receipt.");
    const pending = Object.entries(v2.data.clients).flatMap(([name, c]) =>
      (c?.owned_resources ?? [])
        .filter((r) => r.kind !== "block")
        .map((r) => ({ client: name, path: r.path })),
    );
    if (pending.length)
      throw new MWFError(
        "LEGACY_RESOURCE_PENDING",
        `This receipt (v2) still owns resources MWF 0.3 no longer manages: ${pending
          .map((p) => `${p.client}: ${p.path}`)
          .join(", ")}. With MWF 0.2.x, run ${[
          ...new Set(pending.map((p) => p.client)),
        ]
          .map((c) => `\`mwf detach --root <project> --harness ${c} --apply\``)
          .join(" and ")} first, then retry with 0.3.`,
      );
    return receiptSchema.parse({
      ...v2.data,
      receipt_version: RECEIPT_VERSION,
    });
  }
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success)
    throw new MWFError("INVALID_CONFIG", "Invalid integration receipt.");
  return parsed.data;
}
export function receipt(tx: Transaction): Receipt | null {
  const raw = tx.get(receiptFile);
  if (raw === null) return null;
  return parseReceipt(JSON.parse(raw));
}
/** Persist a v2→v3 upgrade. It is a single atomic file replacement with no
 * journal: a failure at any point leaves the original v2 bytes (and every
 * other file) untouched, and a retry upgrades from scratch. Returns true when
 * an upgrade was written. Throws, changing nothing, for
 * LEGACY_RESOURCE_PENDING or an invalid receipt. Call under the project lock. */
export function upgradeReceipt(
  root: string,
  fault?: (stage: string) => void,
): boolean {
  const raw = new Transaction(root).get(receiptFile);
  if (raw === null) return false;
  const stored = JSON.parse(raw) as { receipt_version?: unknown };
  const r = parseReceipt(stored);
  if (stored.receipt_version === RECEIPT_VERSION) return false;
  fault?.("prepared");
  atomicWrite(root, receiptFile, JSON.stringify(r, null, 2) + "\n");
  return true;
}
