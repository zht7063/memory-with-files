import { execute } from "../../core.js";
import { fileURLToPath } from "node:url";
import { Transaction } from "../../storage/index.js";
import {
  discover,
  receipt,
  checkBinding,
  type Binding,
} from "../shared/binding.js";
import { piConflicts } from "../../lifecycle/index.js";
import {
  beginContext,
  prepareContext,
  finishContext,
} from "../shared/context.js";
import type { BudgetInput } from "../../context/output.js";
export interface PiContext {
  contextLimits?: Omit<BudgetInput, "cursor">;
  cwd: string;
  isProjectTrusted(): boolean;
  sessionManager: { getSessionId(): string };
  ui?: { notify(message: string, level: string): void };
}
export interface PiAPI {
  on(
    event: string,
    handler: (event: Record<string, unknown>, ctx: PiContext) => unknown,
  ): void;
  registerMcpServer(
    name: string,
    config: { command: string; args: string[]; exposure: "direct" },
  ): void;
  unregisterMcpServer(name: string): void;
}
// A replacement invalidates callbacks retained by the previous loader instance.
const owners = new WeakMap<PiAPI, () => void>();
export default function extension(pi: PiAPI) {
  owners.get(pi)?.();
  let active = true;
  let registered = false;
  let binding: Binding | undefined,
    ref: string | undefined,
    snapshot: boolean | undefined,
    hostSession: string | undefined;
  let lastError = "";
  const clear = () => {
    if (registered) pi.unregisterMcpServer("mwf");
    registered = false;
    binding = undefined;
    ref = undefined;
    snapshot = undefined;
    hostSession = undefined;
  };
  owners.set(pi, () => {
    active = false;
    clear();
  });
  const report = (ctx: PiContext) => {
    if (lastError !== ctx.sessionManager.getSessionId()) {
      lastError = ctx.sessionManager.getSessionId();
      ctx.ui?.notify(
        "MWF: memory unavailable; inspect mwf doctor and the active MCP configuration.",
        "warning",
      );
    }
  };
  const start = (_event: Record<string, unknown>, ctx: PiContext) => {
    if (!active) return;
    clear();
    if (!ctx.isProjectTrusted()) return;
    try {
      const root = discover(ctx.cwd);
      if (!root) return;
      const c = receipt(new Transaction(root))?.clients.pi;
      if (!c?.enabled) return;
      if (piConflicts(root).length) throw new Error("MCP conflict");
      binding = {
        root,
        harness: "pi",
        generation: c.binding_generation ?? "",
        runtime: fileURLToPath(new URL("../../cli.js", import.meta.url)),
        cwd: ctx.cwd,
      };
      checkBinding(new Transaction(root), binding);
      hostSession = ctx.sessionManager.getSessionId();
      ref = beginContext(binding, hostSession, true);
      execute(
        "bootstrap",
        { project_root: root, session_ref: ref },
        { guard: (tx) => checkBinding(tx, binding!) },
      );
      snapshot = true;
      try {
        pi.registerMcpServer("mwf", {
          command: process.execPath,
          args: [
            binding.runtime,
            "mcp",
            "--root",
            root,
            "--harness",
            "pi",
            "--binding-generation",
            binding.generation,
            "--session-ref",
            ref,
            "--profile",
            "agent",
          ],
          exposure: "direct",
        });
        registered = true;
      } catch {
        // Direct recovery is independent of the tool connection.
        report(ctx);
      }
    } catch {
      clear();
      report(ctx);
    }
  };
  pi.on("session_start", start);
  for (const event of ["session_compact", "session_tree"]) pi.on(event, start);
  pi.on("before_agent_start", (event, ctx) => {
    if (!active) return;
    if (!binding || !ref || !ctx.isProjectTrusted()) {
      clear();
      return;
    }
    try {
      if (
        discover(ctx.cwd) !== binding.root ||
        hostSession !== ctx.sessionManager.getSessionId()
      ) {
        start(event, ctx);
        if (!binding || !ref) return;
      }
      checkBinding(new Transaction(binding.root), binding);
      const output = prepareContext(
        binding,
        ref,
        typeof event.prompt === "string" ? event.prompt : "",
        snapshot === true,
        ctx.contextLimits,
      );
      snapshot = undefined;
      if (!output) return;
      finishContext(binding, ref, output.id, "submitted");
      return {
        message: { customType: "mwf", content: output.text, display: false },
      };
    } catch {
      clear();
      report(ctx);
    }
  });
  pi.on("session_shutdown", () => {
    if (active) clear();
  });
}
