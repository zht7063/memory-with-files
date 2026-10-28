import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute } from "../dist/core.js";
import { lifecycle } from "../dist/lifecycle/index.js";
import { Transaction } from "../dist/storage/index.js";
import {
  checkBinding,
  type Binding,
} from "../dist/integrations/shared/binding.js";
import { receipt } from "../dist/storage/receipt.js";
import { registerSession } from "../dist/core/identity.js";
import extension, { type PiContext } from "../dist/integrations/pi/index.js";
import { handleHook } from "../dist/integrations/codex/hook.js";

for (const disabled of ["pi", "codex"] as const) {
  test(`T09 ${disabled}: independent detach, simulated uninstall/reload/reinstall and data recovery`, (t) => {
    const base = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "mwf-t09-")),
    );
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, "project");
    fs.mkdirSync(root);
    // Filesystem installation fixture; no real host installation is claimed.
    const plugin = path.join(base, "plugin");
    fs.mkdirSync(plugin);
    fs.writeFileSync(
      path.join(plugin, "plugin.json"),
      JSON.stringify({ name: "mwf", version: "0.4.0" }),
    );
    const piPackage = path.join(base, "pi-package");
    fs.symlinkSync(process.cwd(), piPackage, "dir");
    const install = () =>
      fs.symlinkSync(process.cwd(), path.join(plugin, "runtime"), "dir");
    install();
    execute("init", { project_root: root, git_mode: "track" });
    const attach = (harness: "pi" | "codex") =>
      lifecycle("attach", {
        project_root: root,
        harness,
        plugin_root: harness === "pi" ? piPackage : plugin,
        apply: true,
      });
    attach("pi");
    attach("codex");
    execute("add", {
      project_root: root,
      type: "preference",
      title: "Original",
      summary: "T09_ORIGINAL",
      body: "Original Markdown 正文",
    });
    const tx = new Transaction(root);
    const ref = registerSession(tx, disabled, "original-session").session_ref;
    tx.commit();
    for (const scope of [{ session_ref: ref }, { task_id: "original-task" }]) {
      execute("handoff", {
        project_root: root,
        action: "save",
        ...scope,
        expected_revision: 0,
        request_id: JSON.stringify(scope),
        data: { goal: "T09_HANDOFF", next_action: "Resume original" },
      });
    }
    const snapshot = () => {
      const tx = new Transaction(root);
      return Object.fromEntries(
        [
          ...tx
            .files(".mwf")
            .filter((file) => file.endsWith(".md") && file !== ".mwf/index.md"),
          ...tx.files(".mwf/local/handoffs"),
          `.mwf/local/contexts/${ref}.json`,
        ].map((file) => [file, tx.get(file)]),
      );
    };
    const original = snapshot();
    assert.ok(
      Object.keys(original).some(
        (file) => file.endsWith(".md") && file !== ".mwf/index.md",
      ),
    );
    const bindings = Object.fromEntries(
      (["pi", "codex"] as const).map((harness) => {
        const c = receipt(new Transaction(root))!.clients[harness]!;
        return [
          harness,
          {
            root,
            cwd: root,
            harness,
            runtime: c.runtime_path!,
            generation: c.binding_generation!,
          },
        ];
      }),
    ) as Record<"pi" | "codex", Binding>;
    const handlers = new Map<
      string,
      (e: Record<string, unknown>, ctx: PiContext) => unknown
    >();
    const servers = new Set<string>();
    const api = {
      on: (
        name: string,
        fn: (e: Record<string, unknown>, ctx: PiContext) => unknown,
      ) => {
        handlers.set(name, fn);
      },
      registerMcpServer: (name: string) => {
        servers.add(name);
      },
      unregisterMcpServer: (name: string) => {
        servers.delete(name);
      },
    };
    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "pi-host" },
    };
    const emit = (name: string) => handlers.get(name)!({}, ctx);
    const hook = () =>
      handleHook({
        cwd: root,
        session_id: "codex-host",
        hook_event_name: "SessionStart",
      });
    extension(api);
    emit("session_start");
    assert.equal(servers.size, 1);
    assert.match(JSON.stringify(hook()), /T09_ORIGINAL/);
    const oldRequest = (operation: "status" | "add") =>
      execute(
        operation,
        {
          project_root: root,
          ...(operation === "add"
            ? {
                type: "preference",
                title: "Rejected",
                summary: "Rejected",
                body: "Must not persist",
              }
            : {}),
        },
        { guard: (tx) => checkBinding(tx, bindings[disabled]) },
      );
    const other = disabled === "pi" ? "codex" : "pi";
    lifecycle("detach", { project_root: root, harness: disabled, apply: true });
    const verifyDisabled = () => {
      assert.throws(
        () => checkBinding(new Transaction(root), bindings[disabled]),
        /disabled|revoked/,
      );
      for (const operation of ["status", "add"] as const)
        assert.throws(() => oldRequest(operation), /disabled|revoked/);
      checkBinding(new Transaction(root), bindings[other]);
      emit("session_start");
      assert.equal(servers.size, disabled === "pi" ? 0 : 1);
      if (disabled === "pi") {
        assert.equal(emit("before_agent_start"), undefined);
        assert.match(JSON.stringify(hook()), /T09_ORIGINAL/);
      } else {
        assert.deepEqual(hook(), {});
        assert.match(
          JSON.stringify(emit("before_agent_start")),
          /T09_ORIGINAL/,
        );
        assert.ok(!fs.existsSync(path.join(root, ".codex/config.toml")));
      }
    };
    verifyDisabled();
    fs.unlinkSync(disabled === "pi" ? piPackage : path.join(plugin, "runtime")); // Simulated package removal.
    extension(api); // Simulated host reload with callbacks from the old loader retired.
    verifyDisabled();
    if (disabled === "pi") fs.symlinkSync(process.cwd(), piPackage, "dir");
    else install();
    verifyDisabled(); // Installing alone must not enable the client.
    execute(
      "add",
      {
        project_root: root,
        type: "preference",
        title: "Survivor",
        summary: "Other client still writes",
        body: "Evidence",
      },
      { guard: (tx) => checkBinding(tx, bindings[other]) },
    );
    attach(disabled);
    assert.throws(
      () => checkBinding(new Transaction(root), bindings[disabled]),
      /revoked/,
    );
    checkBinding(new Transaction(root), bindings[other]);
    emit("session_start");
    assert.equal(servers.size, 1);
    assert.match(JSON.stringify(hook()), /T09_ORIGINAL/);
    const recovered = snapshot();
    for (const [file, content] of Object.entries(original))
      assert.equal(recovered[file], content);
    assert.doesNotMatch(
      JSON.stringify(execute("recall", { project_root: root })),
      /Rejected/,
    );
    assert.match(
      JSON.stringify(execute("recall", { project_root: root })),
      /T09_ORIGINAL/,
    );
    for (const scope of [{ session_ref: ref }, { task_id: "original-task" }]) {
      assert.match(
        JSON.stringify(
          execute("handoff", { project_root: root, action: "read", ...scope }),
        ),
        /T09_HANDOFF/,
      );
    }
  });
}
