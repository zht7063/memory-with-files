import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { execute } from "../dist/core.js";
import { Transaction, withProjectLock } from "../dist/storage.js";
import { render, emptyScope } from "../dist/protocol.js";
import { measure, serialize } from "../dist/context/output.js";
const baseline = process.argv[2];
if (!baseline) throw Error("Pass the compiled fixed 0.1.0 core path.");
const old = await import(pathToFileURL(path.resolve(baseline)).href);
const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-benchmark-")),
  ),
  rows = [];
try {
  for (const count of [10, 100, 1000]) {
    const root = path.join(base, String(count));
    fs.mkdirSync(root);
    old.execute("init", { project_root: root, git_mode: "track" });
    withProjectLock(root, () => {
      const tx = new Transaction(root);
      for (let i = 0; i < count; i++) {
        const scope = emptyScope();
        if (i % 10 !== 0) scope.tools = ["proxy"];
        const id = "KNOW-20261016-" + String(i + 1).padStart(3, "0"),
          file = ".mwf/knowledge/" + id + ".md";
        tx.set(
          file,
          render({
            path: file,
            title: "代理设置 " + i,
            body:
              "# 代理设置 " +
              i +
              "\n\nVerified synthetic configuration guidance.",
            metadata: {
              id,
              type: "knowledge",
              status: "stable",
              created: "2026-10-16",
              updated: "2026-10-16",
              summary: "代理设置：明确项目边界与回退步骤 " + i,
              scope,
            },
          }),
        );
      }
      tx.commit();
    });
    old.execute("rebuild-index", { project_root: root });
    for (const scenario of [
      { name: "new-session", operation: "bootstrap", query: "" },
      { name: "known-solution", operation: "recall", query: "代理设置" },
      { name: "no-relevant", operation: "recall", query: "unrelated-zzzz" },
      { name: "task-switch", operation: "recall", query: "proxy" },
      { name: "parallel-session-read", operation: "bootstrap", query: "proxy" },
    ]) {
      for (const [version, run] of [
        ["0.1.0", old.execute],
        ["0.2.0", execute],
      ] as const) {
        const start = performance.now();
        const result = run(scenario.operation, {
          project_root: root,
          query: scenario.query,
        });
        const elapsed = performance.now() - start;
        const m = measure(serialize(result));
        rows.push({
          records: count,
          scenario: scenario.name,
          version,
          memory_reference_tokens: m.reference_tokens,
          memory_bytes: m.bytes,
          read_ms: Math.round(elapsed * 100) / 100,
        });
      }
      rows.push({
        records: count,
        scenario: scenario.name,
        version: "no-mwf",
        memory_reference_tokens: 0,
        memory_bytes: 0,
        read_ms: 0,
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        kind: "deterministic memory-output comparison",
        rows,
        limitations: [
          "Not end-to-end model task completion or billed token measurements",
          "Tool schema and maintenance call costs require the same real model task harness",
          "Parallel-session correctness is covered by separate tests, not latency simulation",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
