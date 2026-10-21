import { RUNTIME_VERSION } from "../../contracts/version.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { execute } from "../../core/index.js";
import {
  Transaction,
  withProjectLock,
  recover,
  hash,
  MWFError,
} from "../../storage/index.js";
import { checkBinding, type Binding } from "./binding.js";
import { registerSession, resolveSession } from "../../core/identity.js";
import {
  boundResult,
  measure,
  serialize,
  limits,
  type BudgetInput,
} from "../../context/output.js";
const outputSchema = z.object({
  id: z.string(),
  keys: z.array(z.string()),
  tokens: z.number(),
  bytes: z.number(),
  status: z.enum(["pending", "submitted", "accepted", "unknown"]),
  hash: z.string(),
  entry_count: z.number().optional(),
});
const stateSchema = z.object({
  epoch: z.string(),
  used: z.number(),
  bytes: z.number(),
  outputs: z.array(outputSchema),
  diagnostics: z.array(
    z.object({
      client: z.enum(["pi", "codex"]).optional(),
      session_ref: z.string().optional(),
      epoch: z.string().optional(),
      runtime_version: z.string().optional(),
      api_version: z.number().optional(),
      result_code: z.string().optional(),
      entry_count: z.number().optional(),
      event: z.string(),
      at: z.string(),
      hash: z.string(),
      reference_tokens: z.number(),
      bytes: z.number(),
    }),
  ),
});
type State = z.infer<typeof stateSchema>;
const stateFile = (ref: string) => `.mwf/local/contexts/${ref}-state.json`;
function state(tx: Transaction, ref: string): State {
  resolveSession(tx, ref);
  const raw = tx.get(stateFile(ref));
  return raw
    ? stateSchema.parse(JSON.parse(raw))
    : { epoch: randomUUID(), used: 0, bytes: 0, outputs: [], diagnostics: [] };
}
function locked<T>(binding: Binding, fn: (tx: Transaction) => T) {
  return withProjectLock(binding.root, () => {
    recover(binding.root);
    const tx = new Transaction(binding.root);
    checkBinding(tx, binding, false);
    const value = fn(tx);
    checkBinding(tx, binding, false);
    tx.commit();
    return value;
  });
}
export function beginContext(
  binding: Binding,
  hostId: string,
  reset: boolean,
  branch: string | null = null,
) {
  return locked(binding, (tx) => {
    const identity = registerSession(tx, binding.harness, hostId, branch);
    const s = state(tx, identity.session_ref);
    // A new host invocation cannot confirm delivery of an unfinished reservation.
    // Preserve its keys and charge until an explicit failure or epoch reset.
    for (const output of s.outputs)
      if (output.status === "pending") output.status = "unknown";
    if (reset) {
      s.epoch = randomUUID();
      s.used = 0;
      s.bytes = 0;
      s.outputs = [];
    }
    tx.set(stateFile(identity.session_ref), JSON.stringify(s));
    return identity.session_ref;
  });
}
export function prepareContext(
  binding: Binding,
  ref: string,
  query: string = "",
  bootstrap = false,
  hostLimits: Omit<BudgetInput, "cursor"> = {},
) {
  const result = execute(
    bootstrap ? "bootstrap" : "recall",
    {
      project_root: binding.root,
      query,
      ...(bootstrap ? { session_ref: ref } : {}),
    },
    { guard: (tx) => checkBinding(tx, binding, false) },
  );
  return locked(binding, (tx) => {
    const s = state(tx, ref),
      d = result.data as {
        entries: { id: string; content_hash: string }[];
        handoff?: unknown;
        [key: string]: unknown;
      };
    const loaded = new Set(s.outputs.flatMap((o) => o.keys));
    const key = (entry: { id: string; content_hash: string }) =>
      `${entry.id}:${entry.content_hash}:summary`;
    const count = d.entries.length;
    d.entries = d.entries.filter((e) => !loaded.has(key(e)));
    const handoffKey = d.handoff
      ? "handoff:" + hash(JSON.stringify(d.handoff))
      : null;
    if (handoffKey && loaded.has(handoffKey)) d.handoff = null;
    if (!d.entries.length && !d.handoff) return null;
    const remaining = 8192 - s.used;
    if (remaining <= 0) return null;
    d.session_ref = ref;
    d.epoch = s.epoch;
    d.omitted = {
      by_budget: 0,
      by_status: 0,
      already_loaded: count - d.entries.length,
    };
    try {
      boundResult(
        result,
        {
          max_reference_tokens: Math.min(
            bootstrap ? 1024 : 2048,
            remaining,
            hostLimits.max_reference_tokens ?? Infinity,
          ),
          max_output_bytes: Math.min(
            limits[bootstrap ? "bootstrap" : "recall"][1],
            hostLimits.max_output_bytes ?? Infinity,
          ),
        },
        bootstrap ? "bootstrap" : "recall",
      );
    } catch (e) {
      if (e instanceof MWFError && e.code === "BUDGET_TOO_SMALL") return null;
      throw e;
    }
    if (!d.entries.length && !d.handoff) return null;
    const text = serialize(result),
      m = measure(text),
      id = randomUUID();
    s.outputs.push({
      id,
      keys: [
        ...d.entries.map(key),
        ...(d.handoff && handoffKey ? [handoffKey] : []),
      ],
      tokens: m.reference_tokens,
      bytes: m.bytes,
      status: "pending",
      entry_count: d.entries.length,
      hash: hash(text)!,
    });
    s.used += m.reference_tokens;
    s.bytes += m.bytes;
    tx.set(stateFile(ref), JSON.stringify(s));
    return { id, text, epoch: s.epoch };
  });
}
export function finishContext(
  binding: Binding,
  ref: string,
  id: string,
  outcome: "submitted" | "accepted" | "unknown" | "failed",
) {
  locked(binding, (tx) => {
    const s = state(tx, ref),
      o = s.outputs.find((o) => o.id === id);
    if (!o) return;
    if (outcome === "failed") {
      s.used -= o.tokens;
      s.bytes -= o.bytes;
      s.outputs = s.outputs.filter((v) => v.id !== id);
    } else o.status = outcome;
    s.diagnostics.push({
      client: binding.harness,
      session_ref: ref,
      epoch: s.epoch,
      runtime_version: RUNTIME_VERSION,
      api_version: 2,
      result_code: outcome,
      entry_count: o.entry_count ?? 0,
      event: outcome,
      at: new Date().toISOString(),
      hash: o.hash,
      reference_tokens: o.tokens,
      bytes: o.bytes,
    });
    s.diagnostics = s.diagnostics.slice(-100);
    tx.set(stateFile(ref), JSON.stringify(s));
  });
}
