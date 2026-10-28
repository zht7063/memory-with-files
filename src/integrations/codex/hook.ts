import { fileURLToPath } from "node:url";
import { z } from "zod";
import { discover, checkBinding, type Binding } from "../shared/binding.js";
import { confirmHostLoad } from "../shared/confirm.js";
import { receipt } from "../../storage/receipt.js";
import { Transaction } from "../../storage/index.js";
import { stopReason } from "./stop.js";
import { claimStopGuard } from "./guard.js";
import {
  beginContext,
  prepareContext,
  finishContext,
} from "../shared/context.js";
export type HookOutput = {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: "SessionStart" | "UserPromptSubmit";
    additionalContext: string;
  };
  decision?: "block";
  reason?: string;
};
function bindingFor(
  root: string,
  generation: string | undefined,
  cwd: string,
): Binding {
  return {
    root,
    harness: "codex",
    generation: generation ?? "",
    runtime: fileURLToPath(new URL("../../cli.js", import.meta.url)),
    cwd,
  };
}
// Stop never reads memory or touches the context budget; its only write is the
// bounded loop-guard marker. A first fire in an enabled project asks the agent to
// self-check; any re-entry or failure allows the stop.
function handleStop(a: {
  cwd: string;
  session_id?: string;
  stop_hook_active?: boolean | null;
  turn_id?: unknown;
  transcript_path?: unknown;
  last_assistant_message?: unknown;
}): HookOutput {
  if (a.stop_hook_active) return {};
  try {
    const root = discover(a.cwd);
    if (!root) return {};
    const client = receipt(new Transaction(root))?.clients.codex;
    if (!client?.enabled) return {};
    checkBinding(
      new Transaction(root),
      bindingFor(root, client.binding_generation, a.cwd),
      false,
    );
    // Defence in depth when the host omits stop_hook_active: block at most once
    // per (session_id, turn_id). Without those identifiers only an explicit
    // `stop_hook_active: false` is trusted.
    if (a.session_id && typeof a.turn_id === "string" && a.turn_id) {
      if (!claimStopGuard(root, a.session_id, a.turn_id)) return {};
    } else if (a.stop_hook_active !== false) return {};
    return { decision: "block", reason: stopReason(a) };
  } catch {
    return {};
  }
}
export function handleHook(input: unknown): HookOutput {
  const a = z
    .object({
      cwd: z.string(),
      session_id: z.string().min(1).optional(),
      hook_event_name: z.enum(["SessionStart", "UserPromptSubmit", "Stop"]),
      source: z.string().optional(),
      context_limits: z
        .object({
          max_reference_tokens: z.number().int().positive().optional(),
          max_output_bytes: z.number().int().positive().optional(),
        })
        .optional(),
      prompt: z.string().max(20000).optional(),
      turn_id: z.unknown().optional(),
      stop_hook_active: z.boolean().nullish(),
      transcript_path: z.unknown().optional(),
      last_assistant_message: z.unknown().optional(),
    })
    .passthrough()
    .parse(input);
  if (a.hook_event_name === "Stop") return handleStop(a);
  const root = discover(a.cwd);
  if (!root) return {};
  const client = receipt(new Transaction(root))?.clients.codex;
  if (!client?.enabled) return {};
  const binding = bindingFor(root, client.binding_generation, a.cwd);
  checkBinding(new Transaction(root), binding, false);
  // The host ran this hook: it loaded and trusted the plugin.
  confirmHostLoad(binding, {
    channel: "hook",
    trigger: `hook:${a.hook_event_name}`,
    // The documented hook input has no version field; take one if a Codex build
    // sends it. Otherwise status falls back to the MCP clientInfo version.
    hostVersion: [a.codex_version, a.client_version, a.version].find(
      (v): v is string => typeof v === "string" && v !== "",
    ),
    hostName: "codex",
  });
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
