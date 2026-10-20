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
export interface PiContext {
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
export default function extension(pi: PiAPI) {
  let binding: Binding | undefined,
    ref: string | undefined,
    snapshot: boolean | undefined;
  let lastError = "";
  const clear = () => {
    if (binding) pi.unregisterMcpServer("mwf");
    binding = undefined;
    ref = undefined;
    snapshot = undefined;
  };
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
      ref = beginContext(binding, ctx.sessionManager.getSessionId(), true);
      execute(
        "bootstrap",
        { project_root: root, session_ref: ref },
        { guard: (tx) => checkBinding(tx, binding!) },
      );
      snapshot = true;
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
    } catch {
      clear();
      report(ctx);
    }
  };
  pi.on("session_start", start);
  for (const event of ["session_compact", "session_tree"]) pi.on(event, start);
  pi.on("before_agent_start", (event, ctx) => {
    if (!binding || !ref || !ctx.isProjectTrusted()) {
      clear();
      return;
    }
    try {
      if (discover(ctx.cwd) !== binding.root) {
        start(event, ctx);
        return;
      }
      checkBinding(new Transaction(binding.root), binding);
      const output = prepareContext(
        binding,
        ref,
        typeof event.prompt === "string" ? event.prompt : "",
        snapshot === true,
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
  pi.on("session_shutdown", () => clear());
}
