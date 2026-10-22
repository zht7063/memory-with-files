import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lifecycle } from "../dist/setup.js";
import { execute as rawExecute } from "../dist/core.js";
import { execute } from "./contracts.ts";
import type { TestContext } from "node:test";
import { z } from "zod";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const core = fileURLToPath(new URL("../dist/core.js", import.meta.url));
const legacyFixture = fileURLToPath(
  new URL("./fixtures/legacy-schema-1/", import.meta.url),
);
function legacyProject(t: TestContext) {
  const root = temp(t);
  fs.cpSync(path.join(legacyFixture, "project"), root, { recursive: true });
  return root;
}
const temp = (t: TestContext) => {
  const p = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-test-")),
  );
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
};
const init = (root: string) =>
  execute("init", { project_root: root, git_mode: "track" });
const add = (root: string, overrides: Record<string, unknown> = {}) =>
  execute("add", {
    project_root: root,
    type: "preference",
    title: "Use clear names",
    summary: "Keep names clear",
    body: "## Guidance\n\nUse clear names.",
    ...overrides,
  });
function child(args: string[]) {
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    out: string;
    err: string;
  }>((resolve) => {
    const p = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code, signal) => resolve({ code, signal, out, err }));
  });
}

test("status and initialization preview leave an unconnected project untouched", (t) => {
  const root = temp(t);
  assert.equal(
    execute("status", { project_root: root }).data.initialized,
    false,
  );
  assert.equal(
    execute("init", { project_root: root, git_mode: "track", dry_run: true })
      .data.preview,
    true,
  );
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(
    () => execute("bootstrap", { project_root: root }),
    /not connected/,
  );
  assert.deepEqual(fs.readdirSync(root), []);
});
test("init preserves user text and is idempotent; local privacy and schema are enforced", (t) => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# User rules\nKeep these.\n");
  fs.writeFileSync(
    path.join(root, "CLAUDE.md"),
    "# User Claude rules\r\nKeep these too.\r\n",
  );
  const rules = ["AGENTS.md", "CLAUDE.md"].map(
    (file) => [file, fs.readFileSync(path.join(root, file))] as const,
  );
  fs.writeFileSync(path.join(root, ".gitignore"), "build/\n");
  init(root);
  assert.match(
    fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"),
    /Keep these/,
  );
  assert.deepEqual(init(root).changed_files, []);
  assert.equal(execute("doctor", { project_root: root }).ok, true);
  execute("init", { project_root: root, git_mode: "ignore" });
  assert.match(
    fs.readFileSync(path.join(root, ".gitignore"), "utf8"),
    /^\.mwf\/local\/$/m,
  );
  const config = path.join(root, ".mwf/config.json");
  const c = JSON.parse(fs.readFileSync(config, "utf8"));
  c.schema_version = 99;
  fs.writeFileSync(config, JSON.stringify(c));
  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.throws(() => init(root), /newer/);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), agents);
  assert.throws(() => add(root), /newer/);
  for (const [file, bytes] of rules)
    assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes);
});
test("initialization ignores unrelated malformed AGENTS markers", (t) => {
  const root = temp(t);
  fs.writeFileSync(
    path.join(root, "AGENTS.md"),
    "<!-- memory-with-files:end -->\n<!-- memory-with-files:start -->",
  );
  init(root);
  assert.equal(fs.existsSync(path.join(root, ".mwf/config.json")), true);
});
test("record recall preserves scoped incident boundaries and candidates are marked", (t) => {
  const root = temp(t);
  init(root);
  const incident = add(root, {
    type: "incident",
    status: "resolved",
    title: "Preserve embedded DOCX objects",
    summary: "Use LibreOffice when Pandoc loses embedded objects",
    body: "## Applicability\nDOCX embedded objects; Pandoc remains valid for text-only files.\n\n## Invalid when\nConverter upgrade changes behavior.",
    scope: {
      file_types: [".docx"],
      tools: ["pandoc", "libreoffice"],
      operations: ["conversion"],
      keywords: ["embedded objects"],
    },
  });
  assert.deepEqual(
    execute("recall", { project_root: root, file_type: [".docx"] }).data
      .entries,
    [],
  );
  const matches = execute("recall", {
    project_root: root,
    file_type: [".docx"],
    operation: ["conversion"],
  }).data.entries;
  assert.equal(matches[0].id, incident.data.id);
  assert.ok(matches[0].boundaries);
  assert.match(matches[0].boundaries.applicability, /Pandoc remains valid/);
  const proposed = execute("propose", {
    project_root: root,
    type: "preference",
    title: "Possible policy",
    summary: "Scope is not confirmed",
    scope: { tools: ["pandoc"] },
  });
  assert.equal(proposed.data.status, "candidate");
  assert.equal(execute("doctor", { project_root: root }).ok, true);
  assert.throws(
    () =>
      execute("update", {
        project_root: root,
        id: proposed.data.id,
        status: "stable",
        apply: true,
      }),
    /Promotion requires/,
  );
  execute("update", {
    project_root: root,
    id: proposed.data.id,
    status: "stable",
    body: "## Guidance\nConfirmed conversion scope.",
    apply: true,
  });
  assert.equal(execute("doctor", { project_root: root }).ok, true);
});
test("strict schemas reject unknown input, missing bodies and secrets in routing too", (t) => {
  const root = temp(t);
  init(root);
  assert.throws(
    () =>
      execute("add", {
        project_root: root,
        type: "preference",
        title: "x",
        summary: "y",
      }),
    /body/,
  );
  assert.throws(
    () =>
      add(root, {
        scope: { tools: ["api_key=sk-abcdefghijklmnopqrstuvwxyz123456"] },
      }),
    /credential/,
  );
  assert.throws(() => add(root, { surprise: "ignored?" }), /Unrecognized/);
});
test("inbox redaction never echoes a credential and handoff is structured", (t) => {
  const root = temp(t);
  init(root);
  const file = path.join(root, ".mwf/inbox.md");
  const secret = "api_key=sk-abcdefghijklmnopqrstuvwxyz123456";
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("- [ ]", "- [ ] " + secret),
  );
  assert.equal(execute("doctor", { project_root: root }).ok, false);
  assert.doesNotMatch(
    JSON.stringify(execute("process-inbox", { project_root: root })),
    /abcdefghijklmnopqrstuvwxyz/,
  );
  assert.throws(
    () =>
      execute("process-inbox", {
        project_root: root,
        item: 1,
        outcome: "Rejected",
        apply: true,
      }),
    /redact/,
  );
  execute("process-inbox", {
    project_root: root,
    item: 1,
    outcome: "Rejected",
    redact: true,
    apply: true,
  });
  assert.doesNotMatch(
    fs.readFileSync(file, "utf8"),
    /abcdefghijklmnopqrstuvwxyz/,
  );
  execute("handoff", {
    project_root: root,
    action: "save",
    task_id: "migration",
    expected_revision: 0,
    request_id: "handoff",
    data: {
      goal: "Migrate MWF",
      next_action: "Test installed package",
      completed: ["Core implemented"],
    },
  });
  assert.match(
    execute("bootstrap", { project_root: root, task_id: "migration" }).data
      .handoff!.next_action,
    /Test installed package/,
  );
  assert.equal(execute("doctor", { project_root: root }).ok, true);
});
test("compaction preserves scope/evidence and forgetting previews by default", (t) => {
  const root = temp(t);
  init(root);
  const a = add(root, { scope: { tools: ["ts"], operations: ["build"] } });
  const b = add(root, {
    title: "Use clear names also",
    scope: { tools: ["ts"], operations: ["build"], paths: ["src/**"] },
    body: "## Additional evidence\nA concrete verified example.",
  });
  assert.ok(
    execute("duplicates", { project_root: root, threshold: 0.2 }).data.length,
  );
  execute("compact", {
    project_root: root,
    canonical: a.data.id,
    duplicate: b.data.id,
  });
  assert.ok(fs.existsSync(path.join(root, b.data.path)));
  execute("compact", {
    project_root: root,
    canonical: a.data.id,
    duplicate: b.data.id,
    apply: true,
  });
  const merged = fs.readFileSync(path.join(root, a.data.path), "utf8");
  assert.match(merged, /src\/\*\*/);
  assert.match(merged, /concrete verified/);
  const next = add(root, { title: "Another memory" });
  assert.notEqual(next.data.id, b.data.id);
  execute("forget", { project_root: root, id: a.data.id });
  assert.ok(fs.existsSync(path.join(root, a.data.path)));
  execute("forget", { project_root: root, id: a.data.id, apply: true });
  assert.equal(fs.existsSync(path.join(root, a.data.path)), false);
  assert.equal(execute("doctor", { project_root: root }).ok, true);
});
test("persistent idempotency replays same write and rejects changed input", (t) => {
  const root = temp(t);
  init(root);
  const first = add(root, { request_id: "same-request" });
  assert.equal(add(root, { request_id: "same-request" }).replayed, true);
  assert.equal(
    add(root, { request_id: "same-request" }).data.id,
    first.data.id,
  );
  assert.throws(
    () => add(root, { request_id: "same-request", title: "Different" }),
    /different input/,
  );
});
test("concurrent processes with different titles allocate unique IDs and a complete index", async (t) => {
  const root = temp(t);
  init(root);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      child([
        cli,
        "add",
        "--input",
        JSON.stringify({
          project_root: root,
          type: "preference",
          title: "Concurrent " + i,
          summary: "Separate memory " + i,
          body: "Distinct evidence " + i,
          request_id: "parallel-" + i,
        }),
      ]),
    ),
  );
  for (const r of results) assert.equal(r.code, 0, r.err);
  const ids = results.map((r) => JSON.parse(r.out).data.id);
  assert.equal(new Set(ids).size, 12);
  assert.equal(execute("doctor", { project_root: root }).ok, true);
});
test("killed writer releases lock and next call recovers durable journal and receipt", async (t) => {
  const root = temp(t);
  init(root);
  const args = {
    project_root: root,
    type: "preference",
    title: "Recovered write",
    summary: "Recover once",
    body: "## Evidence\nPersistent transaction",
    request_id: "crash-write",
  };
  const script = `import {execute} from ${JSON.stringify("file://" + core)}; execute('add',${JSON.stringify(args)},{fault(stage){if(stage==='applied:0')process.kill(process.pid,'SIGKILL')}});`;
  const crashed = await child(["--input-type=module", "-e", script]);
  assert.equal(crashed.signal, "SIGKILL");
  const replay = execute("add", args);
  assert.equal(replay.replayed, true);
  assert.equal(execute("doctor", { project_root: root }).ok, true);
  assert.equal(
    fs.existsSync(path.join(root, ".mwf/local/transaction.json")),
    false,
  );
});
test("recovery refuses an external edit instead of overwriting it", (t) => {
  const root = temp(t);
  init(root);
  assert.throws(
    () =>
      execute(
        "add",
        {
          project_root: root,
          type: "preference",
          title: "Conflict",
          summary: "Conflict test",
          body: "Original intended body",
        },
        {
          fault(stage) {
            if (stage === "prepared") throw Error("injected interruption");
          },
        },
      ),
    /injected/,
  );
  const journal = JSON.parse(
    fs.readFileSync(path.join(root, ".mwf/local/transaction.json"), "utf8"),
  );
  const file = journal.changes[0].path;
  fs.writeFileSync(path.join(root, file), "User replacement");
  assert.throws(
    () => execute("status", { project_root: root }),
    /External edit/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, file), "utf8"),
    "User replacement",
  );
});
test("symlink boundaries protect records, local lock and root-owned configuration", (t) => {
  const root = temp(t),
    outside = temp(t);
  fs.symlinkSync(outside, path.join(root, ".mwf"));
  assert.throws(() => init(root), /Symlinks/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(root, ".mwf"));
  init(root);
  fs.symlinkSync(
    path.join(outside, "missing.md"),
    path.join(root, ".mwf/preferences/dangling.md"),
  );
  assert.throws(() => execute("recall", { project_root: root }), /Symlinks/);
});
test("migration keeps recoverable backup and forget clears MWF-owned snapshots", (t) => {
  const root = temp(t);
  init(root);
  const a = add(root);
  const f = path.join(root, ".mwf/config.json"),
    c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.schema_version = 0;
  fs.writeFileSync(f, JSON.stringify(c));
  assert.equal(
    execute("migrate", { project_root: root }).data.migration_required,
    true,
  );
  const result = execute("migrate", {
    project_root: root,
    git_mode: "track",
    apply: true,
  });
  assert.ok(result.data.backup);
  assert.ok(fs.existsSync(path.join(root, result.data.backup)));
  execute("forget", { project_root: root, id: a.data.id, apply: true });
  assert.equal(fs.existsSync(path.join(root, result.data.backup)), false);
});
test("legacy schema-1 golden files preserve scoped recall", (t) => {
  const root = legacyProject(t);
  const expected = JSON.parse(
    fs.readFileSync(path.join(legacyFixture, "recall.json"), "utf8"),
  );
  const query = {
    project_root: root,
    query: "embedded objects",
    path: "reports/a.docx",
    file_type: [".docx"],
    operation: ["conversion"],
  };
  const recall = () =>
    execute("recall", query).data.entries.map(
      ({ content_hash, complete, boundaries, ...rest }) => ({
        ...rest,
        incident_boundaries: boundaries,
      }),
    );
  assert.deepEqual(recall(), expected);
  assert.deepEqual(
    execute("recall", { project_root: root, file_type: [".docx"] }).data
      .entries,
    [],
  );
  init(root);
  assert.deepEqual(recall(), expected);
});

test("0.1 project: UNSUPPORTED_LEGACY_INSTALL on mutation, migrate, attach and doctor; nothing changes", (t) => {
  const root = legacyProject(t);
  const snap = () =>
    Object.fromEntries(
      (fs.readdirSync(root, { recursive: true }) as string[])
        .filter(
          (f) =>
            fs.statSync(path.join(root, f)).isFile() &&
            !f.startsWith(".mwf/local/runtime.sqlite"),
        )
        .map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]),
    );
  const before = snap();
  assert.equal(
    execute("status", { project_root: root }).data.runtime_owner,
    "legacy",
  );
  const unsupported = (e: { code?: string; message?: string }) =>
    e.code === "UNSUPPORTED_LEGACY_INSTALL" && /0\.2\.x/.test(e.message ?? "");
  assert.throws(() => add(root), unsupported);
  assert.throws(
    () => execute("migrate", { project_root: root, apply: true }),
    unsupported,
  );
  assert.throws(
    () =>
      execute("migrate", {
        project_root: root,
        from: "0.1",
        apply: true,
        legacy_stopped: true,
      }),
    unsupported,
  );
  for (const harness of ["pi", "codex"])
    assert.throws(
      () =>
        lifecycle("attach", {
          project_root: root,
          harness,
          plugin_root: process.cwd(),
          apply: true,
        }),
      unsupported,
    );
  const doctor = execute("doctor", { project_root: root });
  assert.equal(doctor.ok, false);
  assert.ok(
    (doctor.data as { errors: string[] }).errors.includes(
      "UNSUPPORTED_LEGACY_INSTALL",
    ),
  );
  assert.deepEqual(snap(), before);
});
test("every multi-file commit boundary recovers to one consistent result", (t) => {
  for (const stage of [
    "prepared",
    "applied:0",
    "applied:1",
    "applied:2",
    "before-cleanup",
  ]) {
    const root = temp(t);
    init(root);
    const args = {
      project_root: root,
      type: "preference",
      title: "Boundary " + stage,
      summary: "Boundary recovery",
      body: "## Evidence\nCommit boundary test.",
      request_id: "boundary",
    };
    assert.throws(
      () =>
        execute("add", args, {
          fault(actual) {
            if (actual === stage) throw Error("fault " + stage);
          },
        }),
      /fault/,
    );
    const recovered = execute("add", args);
    assert.equal(recovered.replayed, true, stage);
    assert.equal(execute("doctor", { project_root: root }).ok, true, stage);
  }
});

test("retrying a forgotten add cannot resurrect it or expose its old title", (t) => {
  const root = temp(t);
  init(root);
  const args = { request_id: "remember-once", title: "Private subject name" };
  const first = add(root, args);
  execute("forget", {
    project_root: root,
    id: first.data.id,
    apply: true,
    request_id: "forget-once",
  });
  const replay = rawExecute("add", {
    project_root: root,
    type: "preference",
    summary: "Keep names clear",
    body: "## Guidance\n\nUse clear names.",
    ...args,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.ok, false);
  assert.equal(
    z.object({ forgotten: z.literal(true) }).parse(replay.data).forgotten,
    true,
  );
  assert.doesNotMatch(JSON.stringify(replay), /Private subject name/);
  assert.equal(fs.existsSync(path.join(root, first.data.path)), false);
});

test("recovery removes orphaned atomic-write temp files before forgetting", (t) => {
  const root = temp(t);
  init(root);
  const a = add(root);
  const orphan = a.data.path + ".mwf-tmp-12345678-1234-1234-1234-123456789abc";
  fs.writeFileSync(path.join(root, orphan), "Hidden copy of body");
  execute("forget", { project_root: root, id: a.data.id, apply: true });
  assert.equal(fs.existsSync(path.join(root, orphan)), false);
});
