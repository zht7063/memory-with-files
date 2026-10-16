import { loaderModule, runnerModule, sessionModule } from "./pi-contract.ts";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [project, piPackage] = process.argv.slice(2);
if (!project || !piPackage)
  throw new Error(
    "Usage: node --experimental-strip-types scripts/check-pi.ts PROJECT PI_PACKAGE_DIRECTORY",
  );
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-pi-check-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
let wrapperPath: string | undefined;
try {
  const pi = path.resolve(piPackage);
  const { loadExtensions } = loaderModule(
    await import(
      pathToFileURL(path.join(pi, "dist/core/extensions/loader.js")).href
    ),
  );
  const { ExtensionRunner } = runnerModule(
    await import(
      pathToFileURL(path.join(pi, "dist/core/extensions/runner.js")).href
    ),
  );
  const { SessionManager } = sessionModule(
    await import(
      pathToFileURL(path.join(pi, "dist/core/session-manager.js")).href
    ),
  );
  const root = fs.realpathSync(project);
  const config = JSON.parse(fs.readFileSync(root + "/.pi/mcp.json", "utf8"));
  const wrapper = path.join(
    root,
    `.mwf/local/pi-acceptance-${randomUUID()}.ts`,
  );
  wrapperPath = wrapper;
  fs.writeFileSync(
    wrapper,
    `import {createMcpAdapter} from ${JSON.stringify(root + "/.pi/npm/node_modules/pi-mcp-adapter/index.ts")};\nexport default createMcpAdapter({config:${JSON.stringify(config)}});`,
  );
  const loaded = await loadExtensions(
    [wrapper, root + "/.pi/extensions/mwf.js"],
    root,
  );
  assert.deepEqual(loaded.errors, []);
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    root,
    SessionManager.inMemory(root),
    {},
  );
  let active: string[] = [];
  const actions = new Proxy(
    {
      getActiveTools: () => active,
      setActiveTools: (n: string[]) => {
        active = n;
      },
      getAllTools: () =>
        runner.getAllRegisteredTools().map((t) => ({
          name: t.definition.name,
          description: t.definition.description,
        })),
      refreshTools: () => {},
      getCommands: () => [],
    },
    { get: (o, k) => Reflect.get(o, k) ?? (() => {}) },
  );
  const context = {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => new AbortController().signal,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: root }),
  };
  runner.bindCore(actions, context);
  const errors: unknown[] = [];
  runner.onError((e) => errors.push(e));
  try {
    await runner.emit({ type: "session_start", reason: "startup" });
    await runner.emitInput("Continue the project", undefined, "interactive");
    const registered = runner.getAllRegisteredTools();
    assert.ok(registered.length >= 17);
    const bootstrap = registered.find((t) =>
      t.definition.name.endsWith("mwf_bootstrap"),
    );
    assert.ok(bootstrap, "MCP bootstrap must register directly");
    const result = await bootstrap.definition.execute(
      "acceptance",
      { project_root: root },
      new AbortController().signal,
      undefined,
      runner.createContext(),
    );
    assert.match(JSON.stringify(result), /Project handoff/);
    const first = await runner.emitBeforeAgentStart(
      "Continue the project",
      undefined,
      "system",
      { cwd: root },
    );
    assert.ok(first?.messages.some((m) => m.customType === "mwf-bootstrap"));
    assert.match(JSON.stringify(first), /Project handoff/);
    const second = await runner.emitBeforeAgentStart(
      "Next step",
      undefined,
      "system",
      { cwd: root },
    );
    assert.ok(
      !second?.messages?.some((m) => m.customType === "mwf-bootstrap"),
      "No duplicate bootstrap each turn",
    );
    await runner.emit({ type: "session_start", reason: "resume" });
    const resumed = await runner.emitBeforeAgentStart(
      "Resume",
      undefined,
      "system",
      { cwd: root },
    );
    assert.ok(resumed?.messages.some((m) => m.customType === "mwf-bootstrap"));
    assert.deepEqual(errors, []);
    console.log(
      "PASS: real Pi loader + adapter tools + first-turn context + resume",
    );
  } finally {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  }
} finally {
  if (wrapperPath) fs.rmSync(wrapperPath, { force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(agentDir, { recursive: true, force: true });
}
