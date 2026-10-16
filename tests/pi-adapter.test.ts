import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAdapter } from "../dist/pi-adapter.js";
import type { PiAdapterAPI } from "../dist/pi-adapter.js";
import { execute } from "../dist/core.js";
import { setup, detach } from "../dist/setup.js";
import type { TestContext } from "node:test";
function temp(t: TestContext) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-adapter-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function harness() {
  type BeforeHandler = Parameters<
    Extract<
      PiAdapterAPI["on"],
      (event: "before_agent_start", ...args: never[]) => void
    >
  >[1];
  const events = new Map<string, () => void>();
  let before: BeforeHandler | undefined;
  let command: Parameters<PiAdapterAPI["registerCommand"]>[1] | undefined;
  const pi: PiAdapterAPI = {
    on(event, handler) {
      if (event === "before_agent_start") before = handler as BeforeHandler;
      else events.set(event, handler as () => void);
    },
    registerCommand(name, options) {
      assert.equal(name, "mwf:status");
      command = options;
    },
  };
  return {
    pi,
    reset: (event: string) => events.get(event)?.(),
    call: (cwd: string) => {
      assert.ok(before);
      return before({ prompt: "Continue" }, { cwd, ui: { notify() {} } });
    },
    status: async (cwd: string) => {
      assert.ok(command);
      let output = "";
      await command.handler("", {
        cwd,
        ui: {
          notify(message) {
            output = message;
          },
        },
      });
      return output;
    },
  };
}
test("typed Pi adapter injects once, resets across all session events and respects project boundaries", async (t) => {
  const root = temp(t),
    outside = temp(t),
    h = harness();
  execute("init", { project_root: root, git_mode: "track" });
  createAdapter({
    root,
    node: process.execPath,
    cli: fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
  })(h.pi);
  assert.equal((await h.call(root))?.message.customType, "mwf-bootstrap");
  assert.equal(await h.call(root), undefined);
  for (const event of ["session_start", "session_compact", "session_tree"]) {
    h.reset(event);
    assert.equal((await h.call(root))?.message.customType, "mwf-bootstrap");
  }
  assert.equal(await h.call(outside), undefined);
  assert.equal((await h.call(root))?.message.customType, "mwf-bootstrap");
  assert.match(await h.status(root), /"initialized":\s*true/);
});
test("adapter failure remains visible and retries after project recovery", async (t) => {
  const root = temp(t),
    h = harness();
  createAdapter({
    root,
    node: process.execPath,
    cli: fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
  })(h.pi);
  assert.equal((await h.call(root))?.message.customType, "mwf-bootstrap-error");
  execute("init", { project_root: root, git_mode: "track" });
  assert.equal((await h.call(root))?.message.customType, "mwf-bootstrap");
});
test("Pi setup refreshes a v1 owned extension to typed v2 and detach restores the original absence", async (t) => {
  const root = path.join(temp(t), 'project "quoted" $literal');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, ".pi/npm/node_modules/pi-mcp-adapter"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, ".pi/settings.json"),
    JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.32.1"] }),
  );
  fs.writeFileSync(
    path.join(root, ".pi/npm/node_modules/pi-mcp-adapter/package.json"),
    JSON.stringify({ version: "2.32.1" }),
  );
  const input = {
    project_root: root,
    git_mode: "track",
    harness: ["pi"],
    install_pi_adapter: false,
  };
  await setup(input);
  const extension = path.join(root, ".pi/extensions/mwf.js");
  const { hash } = await import("../dist/storage.js");
  const receiptPath = path.join(root, ".mwf/local/setup.json");
  const receipt: { files: Record<string, { after_hash: string | null }> } =
    JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  const old = "// Generated MWF adapter v1\nexport default function(pi) {}\n";
  fs.writeFileSync(extension, old);
  receipt.files[".pi/extensions/mwf.js"].after_hash = hash(old);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  await setup(input);
  const generated = fs.readFileSync(extension, "utf8");
  assert.match(generated, /Generated MWF adapter v2/);
  assert.ok(!generated.includes("__MWF_CONFIG__"));
  const module: unknown = await import(pathToFileURL(extension).href);
  assert.ok(
    module &&
      typeof module === "object" &&
      "default" in module &&
      typeof module.default === "function",
  );
  const h = harness();
  module.default(h.pi);
  assert.equal((await h.call(root))?.message.customType, "mwf-bootstrap");
  assert.deepEqual((await setup(input)).changed_files, []);
  fs.appendFileSync(extension, "// user edit\n");
  await assert.rejects(setup(input), /changed since setup/);
  assert.throws(() => detach(root, true), /modified/);
  fs.writeFileSync(extension, generated);
  detach(root, true);
  assert.ok(!fs.existsSync(extension));
});
