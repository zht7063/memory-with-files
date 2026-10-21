import { z } from "zod";
import { Transaction, MWFError } from "./index.js";
import { MANAGED_SURFACES } from "../contracts/managed-surface.js";
export const receiptFile = ".mwf/local/integration.json";
const S = MANAGED_SURFACES;
// Each resource kind accepts only the managed surfaces of that kind; objects
// are strict so unknown fields fail with INVALID_CONFIG.
export const resourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("block"),
      path: z.literal(S["codex.config.block"].path),
      installed: z.string(),
      created: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      path: z.enum([
        S["legacy.pi.extension"].path,
        S["skill.memory-with-files"].path,
        S["skill.mwf-init"].path,
        S["skill.mwf-status"].path,
      ]),
      installed_hash: z.string(),
      before: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("json"),
      path: z.literal(S["legacy.pi.mcp"].path),
      installed: z.unknown(),
      before: z.unknown(),
      created: z.boolean(),
    })
    .strict(),
]);
export const clientSchema = z
  .object({
    enabled: z.boolean(),
    probe: z.record(z.unknown()).optional(),
    binding_generation: z.string().optional(),
    runtime_version: z.string().optional(),
    api_version: z.number().optional(),
    runtime_path: z.string().optional(),
    node_path: z.string().optional(),
    owned_resources: z.array(resourceSchema).default([]),
    cleanup_pending: z.boolean().default(false),
  })
  .strict();
export const receiptSchema = z
  .object({
    receipt_version: z.literal(2),
    canonical_root: z.string(),
    clients: z
      .object({ pi: clientSchema.optional(), codex: clientSchema.optional() })
      .strict(),
  })
  .strict();
export type Harness = "pi" | "codex";
export type Receipt = z.infer<typeof receiptSchema>;
export function receipt(tx: Transaction): Receipt | null {
  const raw = tx.get(receiptFile);
  if (raw === null) return null;
  const parsed = receiptSchema.safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new MWFError("INVALID_CONFIG", "Invalid integration receipt.");
  return parsed.data;
}
