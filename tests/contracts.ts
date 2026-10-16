/** Validate untrusted operation outputs before tests use them; never cast unknown to any. */
import { z } from "zod";
import { execute as rawExecute } from "../dist/core.js";
import type { Operation } from "../dist/core.js";
export const recordData = z
  .object({ id: z.string(), path: z.string(), status: z.string() })
  .passthrough();
export const recallData = z.array(
  z
    .object({
      id: z.string(),
      path: z.string(),
      body: z.string(),
      summary: z.string(),
      incident_boundaries: z.record(z.string()).optional(),
    })
    .passthrough(),
);
export const bootstrapData = z
  .object({ handoff: z.string(), index: z.string(), matches: recallData })
  .passthrough();
const contracts = {
  init: z.object({ preview: z.boolean().optional() }).passthrough(),
  status: z
    .object({ initialized: z.boolean(), runtime_owner: z.string() })
    .passthrough(),
  doctor: z.object({
    ok: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  bootstrap: bootstrapData,
  recall: recallData,
  add: recordData,
  propose: recordData,
  duplicates: z.array(z.unknown()),
  migrate: z
    .object({
      migration_required: z.boolean().optional(),
      backup: z.string().optional(),
    })
    .passthrough(),
  update: z.unknown(),
  handoff: z.unknown(),
  "process-inbox": z.unknown(),
  compact: z.unknown(),
  "rebuild-index": z.unknown(),
  forget: z.unknown(),
} satisfies Record<Operation, z.ZodTypeAny>;
export function execute<K extends Operation>(
  op: K,
  input: unknown,
  options?: Parameters<typeof rawExecute>[2],
) {
  const result = rawExecute(op, input, options);
  // K and contracts[K] refer to the same operation; the schema validates the boundary.
  const data = contracts[op].parse(result.data) as z.output<
    (typeof contracts)[K]
  >;
  return { ...result, data };
}
export const setupData = z
  .object({
    preview: z.boolean().optional(),
    mcp: z.object({ bootstrap_verified: z.boolean() }).passthrough().optional(),
  })
  .passthrough();
export const previewData = z.object({ preview: z.boolean() }).passthrough();
