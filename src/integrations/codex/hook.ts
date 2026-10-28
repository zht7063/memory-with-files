import { fileURLToPath } from "node:url";
import { z } from "zod";
import { discover, checkBinding, type Binding } from "../shared/binding.js";
import { receipt } from "../../storage/receipt.js";
import { Transaction } from "../../storage/index.js";
import {
  beginContext,
  prepareContext,
  finishContext,
} from "../shared/context.js";
export function handleHook(input: unknown) {
  const a = z
    .object({
      cwd: z.string(),
      session_id: z.string().min(1).optional(),
      hook_event_name: z.enum(["SessionStart", "UserPromptSubmit"]),
      source: z.string().optional(),
      context_limits: z
        .object({
          max_reference_tokens: z.number().int().positive().optional(),
          max_output_bytes: z.number().int().positive().optional(),
        })
        .optional(),
      prompt: z.string().max(20000).optional(),
    })
    .passthrough()
    .parse(input);
  const root = discover(a.cwd);
  if (!root) return {};
  const client = receipt(new Transaction(root))?.clients.codex;
  if (!client?.enabled) return {};
  const binding: Binding = {
    root,
    harness: "codex",
    generation: client.binding_generation ?? "",
    runtime: fileURLToPath(new URL("../../cli.js", import.meta.url)),
    cwd: a.cwd,
  };
  checkBinding(new Transaction(root), binding, false);
  if (!a.session_id)
    return {
      systemMessage:
        "MWF: session identity unavailable; use explicit project recall or task handoff.",
    };
  const ref = beginContext(
    binding,
    a.session_id,
    a.hook_event_name === "SessionStart",
  );
  const output = prepareContext(
    binding,
    ref,
    a.prompt ?? "",
    a.hook_event_name === "SessionStart",
    a.context_limits,
    // Hook processes are short-lived: never build the o200k tokenizer here (#30).
    "estimate",
  );
  if (!output) return {};
  // stdout completion is not a host acknowledgement.
  finishContext(binding, ref, output.id, "unknown");
  return {
    hookSpecificOutput: {
      hookEventName: a.hook_event_name,
      additionalContext: output.text,
    },
  };
}
