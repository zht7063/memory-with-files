import { z } from "zod";
import { Transaction, MWFError } from "./index.js";
export const receiptFile = ".mwf/local/integration.json";
export const resourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("block"),
    path: z.literal(".codex/config.toml"),
    installed: z.string(),
    created: z.boolean(),
  }),
  z.object({
    kind: z.literal("file"),
    path: z.enum([
      ".pi/extensions/mwf.js",
      ".agents/skills/memory-with-files/SKILL.md",
      ".agents/skills/mwf-init/SKILL.md",
      ".agents/skills/mwf-status/SKILL.md",
    ]),
    installed_hash: z.string(),
    before: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("json"),
    path: z.literal(".pi/mcp.json"),
    installed: z.unknown(),
    before: z.unknown(),
    created: z.boolean(),
  }),
]);
export const clientSchema = z
  .object({
    enabled: z.boolean(),
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
