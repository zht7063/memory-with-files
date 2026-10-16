import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  canonicalRoot,
  read,
  Transaction,
  MWFError,
} from "../../storage/index.js";
import { RUNTIME_VERSION } from "../../contracts/version.js";
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
export function discover(cwd: string) {
  let dir = canonicalRoot(cwd);
  while (true) {
    if (read(dir, ".mwf/config.json") !== null) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
export type Binding = {
  root: string;
  harness: Harness;
  generation: string;
  runtime: string;
  cwd: string;
  session_ref?: string;
};
export function checkBinding(tx: Transaction, b: Binding, checkRuntime = true) {
  if (tx.root !== b.root || discover(b.cwd) !== b.root)
    throw new MWFError(
      "ROOT_MISMATCH",
      "Host project differs from bound root; rebind this project.",
    );
  const r = receipt(tx);
  if (r?.canonical_root !== tx.root)
    throw new MWFError("ROOT_MISMATCH", "Receipt belongs to another location.");
  const client = r.clients[b.harness];
  if (!client?.enabled)
    throw new MWFError("INTEGRATION_DISABLED", "Client is disabled.");
  if (client.binding_generation !== b.generation)
    throw new MWFError(
      "BINDING_STALE",
      "Binding was revoked; restart after rebind.",
    );
  if (
    checkRuntime &&
    (client.api_version !== 2 ||
      client.runtime_version !== RUNTIME_VERSION ||
      client.runtime_path !== b.runtime ||
      !fs.existsSync(b.runtime))
  )
    throw new MWFError(
      "RUNTIME_MISMATCH",
      "Runtime changed; rebind from installed plugin.",
    );
  return client;
}
