import fs from "node:fs";
import path from "node:path";
import {
  canonicalRoot,
  read,
  Transaction,
  MWFError,
} from "../../storage/index.js";
import { RUNTIME_VERSION } from "../../contracts/version.js";
import { receipt, type Harness } from "../../storage/receipt.js";
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
