import { z } from "zod";
import { hash, MWFError, Transaction } from "../storage/index.js";
export const identitySchema = z
  .object({
    canonical_root: z.string(),
    client: z.enum(["pi", "codex"]),
    host_session_id: z.string().min(1).max(1000),
    stable_branch_id: z.string().max(1000).nullable(),
    session_key: z.string().regex(/^[a-f0-9]{64}$/),
    session_ref: z.string().regex(/^s_[a-f0-9]{64}$/),
  })
  .strict();
export function sessionIdentity(
  root: string,
  client: "pi" | "codex",
  hostId: string,
  branch: string | null = null,
) {
  const key = hash(JSON.stringify([client, hostId, branch]))!;
  return identitySchema.parse({
    canonical_root: root,
    client,
    host_session_id: hostId,
    stable_branch_id: branch,
    session_key: key,
    session_ref: "s_" + hash(JSON.stringify([root, key])),
  });
}
export function registerSession(
  tx: Transaction,
  client: "pi" | "codex",
  hostId: string,
  branch: string | null = null,
) {
  const identity = sessionIdentity(tx.root, client, hostId, branch);
  const file = `.mwf/local/contexts/${identity.session_ref}.json`;
  const raw = tx.get(file);
  // Reuse the same root and integrity checks when a later hook process resumes.
  // A corrupt mapping must never be silently replaced by registration.
  if (raw !== null) resolveSession(tx, identity.session_ref);
  else tx.set(file, JSON.stringify(identity));
  return identity;
}
export function resolveSession(tx: Transaction, ref: string) {
  if (!/^s_[a-f0-9]{64}$/.test(ref))
    throw new MWFError("CONTEXT_REQUIRED", "Invalid session reference.");
  try {
    const value = identitySchema.parse(
      JSON.parse(tx.get(`.mwf/local/contexts/${ref}.json`) ?? "null"),
    );
    if (value.canonical_root !== tx.root) throw new Error();
    const expected = sessionIdentity(
      tx.root,
      value.client,
      value.host_session_id,
      value.stable_branch_id,
    );
    if (
      JSON.stringify(value) !== JSON.stringify(expected) ||
      ref !== expected.session_ref
    )
      throw new MWFError("CONTEXT_REQUIRED", "Session mapping conflicts");
    return value;
  } catch (error) {
    if (error instanceof MWFError) throw error;
    throw new MWFError(
      "CONTEXT_REQUIRED",
      "Session reference is missing or belongs to another project.",
    );
  }
}
