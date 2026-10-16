import { z } from "zod";
import { hash, MWFError, Transaction } from "../storage/index.js";
import { requireSafe } from "../contracts/records.js";
import { resolveSession } from "../integrations/shared/identity.js";
export const scopeSchema = z
  .object({
    kind: z.enum(["session", "task"]),
    id: z.string().min(1).max(1000),
  })
  .strict();
const list = z.array(z.string().max(1000)).max(20).default([]);
export const handoffDataSchema = z
  .object({
    goal: z.string().min(1).max(2000),
    completed: list,
    decisions: list,
    blockers: list,
    next_action: z.string().min(1).max(2000),
    relevant_ids: z.array(z.string().max(200)).max(50).default([]),
  })
  .strict();
export const handoffSchema = z
  .object({
    handoff_version: z.literal(1),
    scope: scopeSchema,
    revision: z.number().int().positive(),
    updated_at: z.string(),
    written_by_session_ref: z.string().nullable(),
    data: handoffDataSchema,
  })
  .strict();
export const routingFields = {
  session_ref: z.string().optional(),
  task_id: z.string().min(1).max(1000).optional(),
};
export function currentScope(
  tx: Transaction,
  a: { session_ref?: string; task_id?: string },
) {
  if (a.task_id) return { kind: "task" as const, id: a.task_id };
  if (a.session_ref)
    return {
      kind: "session" as const,
      id: resolveSession(tx, a.session_ref).session_key,
    };
  throw new MWFError(
    "CONTEXT_REQUIRED",
    "Specify task_id or a registered session_ref.",
  );
}
function file(scope: z.infer<typeof scopeSchema>) {
  if (scope.kind === "session" && !/^[a-f0-9]{64}$/.test(scope.id))
    throw new MWFError("CONTEXT_REQUIRED", "Invalid session scope ID.");
  return `.mwf/local/handoffs/${scope.kind}s/${scope.kind === "task" ? hash(scope.id) : scope.id}.json`;
}
export function readHandoff(
  tx: Transaction,
  scope: z.infer<typeof scopeSchema>,
) {
  const raw = tx.get(file(scope));
  if (!raw) return null;
  const value = handoffSchema.parse(JSON.parse(raw));
  if (value.scope.kind !== scope.kind || value.scope.id !== scope.id)
    throw new MWFError("INVALID_HANDOFF", "Scope does not match file.");
  requireSafe(raw);
  return value;
}
export function saveHandoff(
  tx: Transaction,
  a: {
    session_ref?: string;
    task_id?: string;
    expected_revision?: number;
    data?: z.infer<typeof handoffDataSchema>;
  },
) {
  const scope = currentScope(tx, a);
  if (a.session_ref) resolveSession(tx, a.session_ref);
  if (a.expected_revision === undefined || !a.data)
    throw new MWFError(
      "INVALID_INPUT",
      "Save requires expected_revision and data.",
    );
  const previous = readHandoff(tx, scope);
  if ((previous?.revision ?? 0) !== a.expected_revision)
    throw new MWFError(
      "HANDOFF_CONFLICT",
      `Current revision: ${previous?.revision ?? 0}. Read and reconcile before saving.`,
      { current_revision: previous?.revision ?? 0 },
    );
  const value = handoffSchema.parse({
    handoff_version: 1,
    scope,
    revision: a.expected_revision + 1,
    updated_at: new Date().toISOString(),
    written_by_session_ref: a.session_ref ?? null,
    data: a.data,
  });
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > 65536)
    throw new MWFError("INPUT_TOO_LARGE", "Handoff exceeds 64 KiB.");
  requireSafe(raw);
  tx.set(file(scope), raw);
  return value;
}
export function listHandoffs(tx: Transaction) {
  return tx
    .files(".mwf/local/handoffs")
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const v = handoffSchema.parse(JSON.parse(tx.get(f)!));
      readHandoff(tx, v.scope);
      return {
        scope: v.scope,
        revision: v.revision,
        updated_at: v.updated_at,
        goal: [...v.data.goal].slice(0, 120).join(""),
      };
    })
    .sort((a, b) =>
      JSON.stringify(a.scope).localeCompare(JSON.stringify(b.scope), "en"),
    );
}
