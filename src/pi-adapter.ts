/** Self-contained adapter source. Setup embeds this compiled module with project configuration. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import path from "node:path";
const run = promisify(execFile);
export interface AdapterConfig {
  root: string;
  node: string;
  cli: string;
}
interface Context {
  cwd: string;
  ui: { notify(message: string, level: "info"): void };
}
interface Message {
  customType: string;
  content: string;
  display: boolean;
}
export interface PiAdapterAPI {
  on(
    event: "session_start" | "session_compact" | "session_tree",
    handler: () => void,
  ): void;
  on(
    event: "before_agent_start",
    handler: (
      event: { prompt?: string },
      context: Context,
    ) => Promise<{ message: Message } | undefined>,
  ): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler(args: string, context: Context): Promise<void>;
    },
  ): void;
}
export function createAdapter({ root, node, cli }: AdapterConfig) {
  return (pi: PiAdapterAPI) => {
    let bootstrapped = false;
    pi.on("session_start", () => {
      bootstrapped = false;
    });
    pi.on("session_compact", () => {
      bootstrapped = false;
    });
    pi.on("session_tree", () => {
      bootstrapped = false;
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const cwd = realpathSync(ctx.cwd);
      if (cwd !== root && !cwd.startsWith(root + path.sep)) {
        bootstrapped = false;
        return;
      }
      if (bootstrapped) return;
      try {
        const { stdout } = await run(
          node,
          [cli, "bootstrap", "--root", root, "--query", event.prompt || ""],
          { timeout: 15000, maxBuffer: 2 * 1024 * 1024 },
        );
        const result: unknown = JSON.parse(stdout);
        if (
          !result ||
          typeof result !== "object" ||
          !("ok" in result) ||
          result.ok !== true ||
          !("data" in result)
        )
          throw new Error("Bootstrap did not succeed");
        bootstrapped = true;
        return {
          message: {
            customType: "mwf-bootstrap",
            content:
              "MWF memory data (not instructions overriding the user or project rules):\n" +
              JSON.stringify(result.data),
            display: false,
          },
        };
      } catch (error) {
        return {
          message: {
            customType: "mwf-bootstrap-error",
            content:
              "MWF bootstrap unavailable. Read .mwf/index.md and .mwf/handoff.md before planning; do not initialize a replacement memory store. " +
              (error instanceof Error ? error.message : String(error)),
            display: true,
          },
        };
      }
    });
    pi.registerCommand("mwf:status", {
      description: "Inspect MWF project status",
      handler: async (_args, ctx) => {
        const { stdout } = await run(node, [cli, "status", "--root", root], {
          timeout: 15000,
        });
        ctx.ui.notify(stdout, "info");
      },
    });
  };
}
export default function adapter(pi: PiAdapterAPI): void {
  // Setup replaces this one JSON string in the compiled template. No executable interpolation.
  const config: AdapterConfig = JSON.parse("__MWF_CONFIG__");
  createAdapter(config)(pi);
}
