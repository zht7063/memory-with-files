// PR-03 safety regression tests (refactor plan §3 tests 1, 1b, 2, 3, 4).
// These run against the current 0.2 storage/lifecycle code and must keep passing
// through the refactor. Rejection cases only use paths outside the 0.2 whitelist;
// `.pi/mcp.json` and `.pi/extensions/mwf.js` are still legal until PR-08.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import * as storage from "../dist/storage/index.js";
import * as receiptModule from "../dist/storage/receipt.js";
import { lifecycle } from "../dist/lifecycle/index.js";

const { recover, hash, Transaction } = storage;
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const JOURNAL = ".mwf/local/transaction.json";
const RECEIPT = ".mwf/local/integration.json";
const BLOCK =
  '# mwf:mcp:start\n[mcp_servers.mwf]\ncommand = "node"\nargs = []\n# mwf:mcp:end';

function sandbox(t: TestContext) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mwf-safety-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, "project"),
    outside = path.join(base, "outside");
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  execFileSync(
    process.execPath,
    [cli, "init", "--root", project, "--git-mode", "track"],
    { stdio: "pipe" },
  );
  fs.writeFileSync(path.join(project, "src.ts"), "user code\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside\n");
  return { base, project, outside };
}

type Snap = Map<string, string>;
// Full tree snapshot (lstat based: files hashed, links by target, dirs marked).
function snapshot(dir: string, prefix = "", out: Snap = new Map()): Snap {
  for (const entry of fs.readdirSync(path.join(dir, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, rel);
    if (entry.isSymbolicLink()) out.set(rel, `link:${fs.readlinkSync(abs)}`);
    else if (entry.isDirectory()) {
      out.set(rel, "dir");
      snapshot(dir, rel, out);
    } else
      out.set(
        rel,
        createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
      );
  }
  return out;
}
function diff(a: Snap, b: Snap): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}
// 0.2 managed surface (storage/index.ts allowedChange) plus parent dirs it may create.
function managed(rel: string) {
  return (
    rel === ".mwf" ||
    rel.startsWith(".mwf/") ||
    ["AGENTS.md", ".gitignore", ".codex", ".codex/config.toml"].includes(rel)
  );
}
function writeJournal(project: string, changes: unknown[]) {
  const text = JSON.stringify({ version: 1, changes });
  fs.writeFileSync(path.join(project, JOURNAL), text);
  return text;
}
function expectCode(fn: () => unknown, codes: string[]) {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "expected an error");
  const code = (caught as { code?: string }).code;
  assert.ok(
    code && codes.includes(code),
    `expected one of ${codes.join("/")}, got ${code}: ${(caught as Error).message}`,
  );
  return code;
}

// ---- Test 1: tampered journal outside the 0.2 whitelist ----
for (const target of [
  "src.ts",
  "src/index.ts",
  ".mwf/runtime.sqlite",
  ".mwf/local/runtime.sqlite",
  JOURNAL,
  ".codex/other.toml",
  "package.json",
]) {
  test(`test 1: tampered journal targeting ${target} is rejected`, (t) => {
    const { project, outside } = sandbox(t);
    const journal = writeJournal(project, [
      { path: target, before: null, after: "pwned\n" },
    ]);
    const before = snapshot(project),
      outBefore = snapshot(outside);
    expectCode(() => recover(project), ["INVALID_JOURNAL"]);
    assert.deepEqual(diff(before, snapshot(project)), []);
    assert.deepEqual(diff(outBefore, snapshot(outside)), []);
    assert.equal(fs.readFileSync(path.join(project, JOURNAL), "utf8"), journal);
  });
}
test("test 1: journal delete of an existing non-managed file is rejected", (t) => {
  const { project } = sandbox(t);
  const journal = writeJournal(project, [
    { path: "src.ts", before: hash("user code\n"), after: null },
  ]);
  const before = snapshot(project);
  expectCode(() => recover(project), ["INVALID_JOURNAL"]);
  assert.deepEqual(diff(before, snapshot(project)), []);
  assert.equal(fs.readFileSync(path.join(project, JOURNAL), "utf8"), journal);
});
test("test 1: a mixed journal is rejected before any entry is applied", (t) => {
  const { project } = sandbox(t);
  const journal = writeJournal(project, [
    { path: ".mwf/inbox.md", before: null, after: "first\n" },
    { path: "src/index.ts", before: null, after: "pwned\n" },
  ]);
  // .mwf/inbox.md exists, so before must match it; use its real hash.
  const inbox = fs.readFileSync(path.join(project, ".mwf/inbox.md"), "utf8");
  const fixed = journal.replace('"before":null', `"before":"${hash(inbox)}"`);
  fs.writeFileSync(path.join(project, JOURNAL), fixed);
  const before = snapshot(project);
  expectCode(() => recover(project), ["INVALID_JOURNAL"]);
  assert.deepEqual(diff(before, snapshot(project)), []);
});

// ---- Test 1b: normalization and absolute paths ----
for (const target of [
  "../etc/x",
  "../outside/secret.txt",
  "/etc/passwd",
  "./.codex/../x",
  ".mwf/../x",
  ".mwf/../../x",
  ".mwf/../../outside/secret.txt",
  ".codex/config.toml/../../x",
  ".mwf/./x/../../src.ts",
  ".mwf\\..\\src.ts",
  "",
]) {
  test(`test 1b: journal path ${JSON.stringify(target)} is rejected`, (t) => {
    const { base, project, outside } = sandbox(t);
    const abs = path.join(base, "abs-target");
    const p = target === "/etc/passwd" ? abs : target; // absolute, but in a tmp dir
    const journal = writeJournal(project, [
      { path: p, before: null, after: "pwned\n" },
    ]);
    const before = snapshot(project),
      outBefore = snapshot(outside);
    expectCode(
      () => recover(project),
      ["INVALID_JOURNAL", "UNSAFE_PATH", "SYMLINK"],
    );
    assert.deepEqual(diff(before, snapshot(project)), []);
    assert.deepEqual(diff(outBefore, snapshot(outside)), []);
    assert.equal(fs.existsSync(abs), false);
    assert.equal(fs.existsSync(path.join(base, "x")), false);
    assert.equal(fs.readFileSync(path.join(project, JOURNAL), "utf8"), journal);
  });
}
test("test 1b: literal /etc/passwd journal entry is rejected", (t) => {
  const { project } = sandbox(t);
  writeJournal(project, [
    { path: "/etc/passwd", before: hash("x"), after: "pwned\n" },
  ]);
  expectCode(() => recover(project), ["INVALID_JOURNAL", "UNSAFE_PATH"]);
  assert.ok(fs.existsSync(path.join(project, JOURNAL)));
});

// ---- Test 1b: symlinks ----
function symlinkCase(
  name: string,
  setup: (p: { base: string; project: string; outside: string }) => {
    journalPath: string;
  },
) {
  test(`test 1b: ${name}`, (t) => {
    const s = sandbox(t);
    const { journalPath } = setup(s);
    const journal = writeJournal(s.project, [
      { path: journalPath, before: null, after: "pwned\n" },
    ]);
    const before = snapshot(s.project),
      outBefore = snapshot(s.outside);
    expectCode(
      () => recover(s.project),
      ["INVALID_JOURNAL", "UNSAFE_PATH", "SYMLINK"],
    );
    assert.deepEqual(diff(before, snapshot(s.project)), []);
    assert.deepEqual(diff(outBefore, snapshot(s.outside)), []);
    assert.equal(
      fs.readFileSync(path.join(s.project, JOURNAL), "utf8"),
      journal,
    );
  });
}
symlinkCase(
  ".codex symlinked to an outside dir, journal writes .codex/config.toml",
  ({ project, outside }) => {
    fs.symlinkSync(outside, path.join(project, ".codex"), "dir");
    return { journalPath: ".codex/config.toml" };
  },
);
symlinkCase(
  ".codex dangling symlink, journal writes .codex/config.toml",
  ({ base, project }) => {
    fs.symlinkSync(
      path.join(base, "missing-dir"),
      path.join(project, ".codex"),
    );
    return { journalPath: ".codex/config.toml" };
  },
);
symlinkCase(
  ".codex/config.toml symlinked to an outside file",
  ({ project, outside }) => {
    fs.mkdirSync(path.join(project, ".codex"));
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(project, ".codex/config.toml"),
    );
    return { journalPath: ".codex/config.toml" };
  },
);
symlinkCase(
  "AGENTS.md symlinked to an outside file",
  ({ project, outside }) => {
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(project, "AGENTS.md"),
    );
    return { journalPath: "AGENTS.md" };
  },
);
symlinkCase(
  "AGENTS.md dangling symlink to an outside path",
  ({ project, outside }) => {
    fs.symlinkSync(
      path.join(outside, "created.md"),
      path.join(project, "AGENTS.md"),
    );
    return { journalPath: "AGENTS.md" };
  },
);
symlinkCase(
  ".gitignore symlinked to an outside file",
  ({ project, outside }) => {
    fs.rmSync(path.join(project, ".gitignore"));
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(project, ".gitignore"),
    );
    return { journalPath: ".gitignore" };
  },
);
symlinkCase(
  ".mwf/archive symlinked to an outside dir",
  ({ project, outside }) => {
    fs.rmSync(path.join(project, ".mwf/archive"), { recursive: true });
    fs.symlinkSync(outside, path.join(project, ".mwf/archive"), "dir");
    return { journalPath: ".mwf/archive/x.md" };
  },
);

test("test 1b: lifecycle attach reading a symlinked AGENTS.md fails with SYMLINK", (t) => {
  for (const dangling of [false, true]) {
    const { project, outside } = sandbox(t);
    const target = path.join(outside, dangling ? "nope.md" : "secret.txt");
    fs.symlinkSync(target, path.join(project, "AGENTS.md"));
    const before = snapshot(project),
      outBefore = snapshot(outside);
    expectCode(
      () =>
        lifecycle("attach", {
          project_root: project,
          harness: "codex",
          plugin_root: path.join(outside, "plugin"),
          apply: true,
        }),
      ["SYMLINK"],
    );
    assert.deepEqual(diff(before, snapshot(project)), []);
    assert.deepEqual(diff(outBefore, snapshot(outside)), []);
    assert.equal(fs.existsSync(target), !dangling);
  }
});

test("test 1b: project root reached through a symlink writes only inside realpath(root)", (t) => {
  const { base, project, outside } = sandbox(t);
  const link = path.join(base, "root-link");
  fs.symlinkSync(project, link, "dir");
  const inbox = fs.readFileSync(path.join(project, ".mwf/inbox.md"), "utf8");
  writeJournal(project, [
    { path: ".mwf/inbox.md", before: hash(inbox), after: "recovered\n" },
  ]);
  const before = snapshot(project),
    outBefore = snapshot(outside);
  const root = storage.canonicalRoot(link);
  assert.equal(root, fs.realpathSync(project));
  assert.equal(recover(root), true);
  const changes = diff(before, snapshot(project));
  assert.deepEqual(changes, [".mwf/inbox.md", JOURNAL]);
  for (const c of changes.filter((c) => fs.existsSync(path.join(project, c))))
    assert.ok(
      fs.realpathSync(path.join(project, c)).startsWith(root + path.sep),
    );
  assert.deepEqual(diff(outBefore, snapshot(outside)), []);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  // The CLI resolves --root the same way.
  const out = JSON.parse(
    execFileSync(process.execPath, [cli, "status", "--root", link], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  assert.equal(out.project_root, root);
});

// ---- Test 2: tampered receipt ----
function codexReceipt(project: string, resources: unknown[], extra = {}) {
  return {
    receipt_version: 3,
    canonical_root: project,
    clients: {
      codex: {
        enabled: true,
        binding_generation: "g",
        runtime_version: "0.2.0",
        api_version: 2,
        runtime_path: "/x/cli.js",
        node_path: process.execPath,
        owned_resources: resources,
        cleanup_pending: false,
      },
    },
    ...extra,
  };
}
const fileRes = (p: string) => ({
  kind: "file",
  path: p,
  installed_hash: hash("user code\n"),
  before: null,
});
const tamperedReceipts: [string, (p: string) => unknown][] = [
  [
    "file resource src/index.ts",
    (p) => codexReceipt(p, [fileRes("src/index.ts")]),
  ],
  ["file resource src.ts", (p) => codexReceipt(p, [fileRes("src.ts")])],
  ["file resource ../x", (p) => codexReceipt(p, [fileRes("../x")])],
  [
    "file resource .codex/../x",
    (p) => codexReceipt(p, [fileRes(".codex/../x")]),
  ],
  [
    "absolute file resource",
    (p) => codexReceipt(p, [fileRes(path.join(p, "src.ts"))]),
  ],
  [
    "block resource on another file",
    (p) =>
      codexReceipt(p, [
        {
          kind: "block",
          path: "src.ts",
          installed: "user code",
          created: false,
        },
      ]),
  ],
  [
    "unknown kind",
    (p) => codexReceipt(p, [{ kind: "dir", path: "src", created: false }]),
  ],
  [
    "unknown client cursor",
    (p) => {
      const r = codexReceipt(p, []) as { clients: Record<string, unknown> };
      r.clients.cursor = r.clients.codex;
      return r;
    },
  ],
  ["extra top-level field", (p) => codexReceipt(p, [], { extra: true })],
  [
    "extra client field",
    (p) => {
      const r = codexReceipt(p, []) as { clients: { codex: object } };
      Object.assign(r.clients.codex, { extra_paths: ["src.ts"] });
      return r;
    },
  ],
  [
    "receipt_version 4",
    (p) => ({ ...(codexReceipt(p, []) as object), receipt_version: 4 }),
  ],
];
for (const [name, make] of tamperedReceipts) {
  test(`test 2: tampered receipt (${name}) is rejected and detach changes nothing`, (t) => {
    const { project, outside } = sandbox(t);
    fs.writeFileSync(
      path.join(project, RECEIPT),
      JSON.stringify(make(project), null, 2),
    );
    expectCode(
      () => receiptModule.receipt(new Transaction(project)),
      ["INVALID_CONFIG"],
    );
    const before = snapshot(project),
      outBefore = snapshot(outside);
    for (const apply of [false, true])
      expectCode(
        () =>
          lifecycle("detach", { project_root: project, harness: "all", apply }),
        ["INVALID_CONFIG"],
      );
    assert.deepEqual(diff(before, snapshot(project)), []);
    assert.deepEqual(diff(outBefore, snapshot(outside)), []);
  });
}

// ---- Test 3: full before/after snapshot of recovery and detach ----
test("test 3: recovery changes only whitelisted paths", (t) => {
  const { project, outside } = sandbox(t);
  fs.mkdirSync(path.join(project, ".codex"));
  fs.writeFileSync(path.join(project, ".codex/config.toml"), "a = 1\n");
  fs.writeFileSync(path.join(project, ".codex/other.toml"), "b = 2\n");
  writeJournal(project, [
    { path: ".codex/config.toml", before: hash("a = 1\n"), after: "a = 2\n" },
    { path: "AGENTS.md", before: null, after: "# agents\n" },
    { path: ".mwf/knowledge/new.md", before: null, after: "k\n" },
  ]);
  const before = snapshot(project),
    outBefore = snapshot(outside);
  assert.equal(recover(project), true);
  const changes = diff(before, snapshot(project));
  assert.deepEqual(changes, [
    ".codex/config.toml",
    ".mwf/knowledge/new.md",
    JOURNAL,
    "AGENTS.md",
  ]);
  assert.ok(changes.every(managed), changes.join(","));
  assert.equal(
    fs.readFileSync(path.join(project, "src.ts"), "utf8"),
    "user code\n",
  );
  assert.deepEqual(diff(outBefore, snapshot(outside)), []);
});
test("test 3: leftover temp files are removed only in scanned managed dirs", (t) => {
  const { project, outside } = sandbox(t);
  const tmp = ".mwf-tmp-12345678-1234-1234-1234-123456789abc";
  fs.mkdirSync(path.join(project, ".codex"));
  fs.mkdirSync(path.join(project, "src"));
  for (const f of [
    `AGENTS.md${tmp}`,
    `.codex/config.toml${tmp}`,
    `.mwf/inbox.md${tmp}`,
    `src/x${tmp}`,
  ])
    fs.writeFileSync(path.join(project, f), "tmp");
  const before = snapshot(project);
  assert.equal(recover(project), false);
  const changes = diff(before, snapshot(project));
  assert.deepEqual(changes, [
    `.codex/config.toml${tmp}`,
    `.mwf/inbox.md${tmp}`,
    `AGENTS.md${tmp}`,
  ]);
  assert.ok(fs.existsSync(path.join(project, `src/x${tmp}`)));
  assert.deepEqual(snapshot(outside).size, 1);
});
test("test 3: detach changes only whitelisted paths", (t) => {
  const { project, outside } = sandbox(t);
  fs.mkdirSync(path.join(project, ".codex"));
  const config = `# user\nmodel = "x"\n${BLOCK}\n`;
  fs.writeFileSync(path.join(project, ".codex/config.toml"), config);
  fs.writeFileSync(path.join(project, ".codex/other.toml"), "b = 2\n");
  fs.writeFileSync(path.join(project, "AGENTS.md"), "# user agents\n");
  fs.writeFileSync(
    path.join(project, RECEIPT),
    JSON.stringify(
      codexReceipt(project, [
        {
          kind: "block",
          path: ".codex/config.toml",
          installed: BLOCK,
          created: false,
        },
      ]),
      null,
      2,
    ),
  );
  const before = snapshot(project),
    outBefore = snapshot(outside);
  const preview = lifecycle("detach", {
    project_root: project,
    harness: "all",
  });
  assert.equal(preview.ok, true);
  assert.deepEqual(
    diff(before, snapshot(project)).filter(
      (c) => c !== ".mwf/local/runtime.sqlite",
    ),
    [],
  );
  const result = lifecycle("detach", {
    project_root: project,
    harness: "all",
    apply: true,
  });
  assert.equal(result.ok, true);
  const changes = diff(before, snapshot(project));
  assert.ok(changes.every(managed), changes.join(","));
  assert.ok(changes.includes(".codex/config.toml"));
  assert.equal(
    fs.readFileSync(path.join(project, ".codex/config.toml"), "utf8"),
    '# user\nmodel = "x"\n',
  );
  for (const c of result.changed_files as string[]) assert.ok(managed(c), c);
  assert.deepEqual(diff(outBefore, snapshot(outside)), []);
});

// ---- Test 4 (current-code form): the whitelist has no extension surface ----
test("test 4: storage exposes no API to extend the managed surface", async () => {
  assert.deepEqual(Object.keys(storage).sort(), [
    "MWFError",
    "Transaction",
    "atomicWrite",
    "canonicalRoot",
    "hash",
    "read",
    "recover",
    "safePath",
    "walk",
    "withProjectLock",
  ]);
  assert.deepEqual(Object.keys(receiptModule).sort(), [
    "RECEIPT_VERSION",
    "clientSchema",
    "parseReceipt",
    "receipt",
    "receiptFile",
    "receiptSchema",
    "resourceSchema",
    "upgradeReceipt",
  ]);
  // Mutating exported values must not widen what recovery accepts.
  const { project } = sandbox({ after: () => {} } as unknown as TestContext);
  try {
    assert.throws(() => {
      (storage as Record<string, unknown>).allowedChange = () => true;
    });
    writeJournal(project, [{ path: "src/index.ts", before: null, after: "x" }]);
    expectCode(() => recover(project), ["INVALID_JOURNAL"]);
    assert.equal(fs.existsSync(path.join(project, "src/index.ts")), false);
    // The receipt schema is closed: a resource path outside the enum never parses.
    assert.equal(
      receiptModule.resourceSchema.safeParse(fileRes("src/index.ts")).success,
      false,
    );
  } finally {
    fs.rmSync(path.dirname(project), { recursive: true, force: true });
  }
});

// PR-05: resource objects are strict, so an unknown field on a resource is
// rejected with INVALID_CONFIG and detach touches nothing.
test("test 2: unknown resource field is rejected with INVALID_CONFIG and nothing changes", (t) => {
  const { project, outside } = sandbox(t);
  fs.mkdirSync(path.join(project, ".codex"));
  fs.writeFileSync(path.join(project, ".codex/config.toml"), `${BLOCK}\n`);
  fs.writeFileSync(
    path.join(project, RECEIPT),
    JSON.stringify(
      codexReceipt(project, [
        {
          kind: "block",
          path: ".codex/config.toml",
          installed: BLOCK,
          created: false,
          also: "src.ts",
        },
      ]),
    ),
  );
  expectCode(
    () => receiptModule.receipt(new Transaction(project)),
    ["INVALID_CONFIG"],
  );
  const before = snapshot(project),
    outBefore = snapshot(outside);
  for (const apply of [false, true])
    expectCode(
      () =>
        lifecycle("detach", { project_root: project, harness: "all", apply }),
      ["INVALID_CONFIG"],
    );
  assert.deepEqual(diff(before, snapshot(project)), []);
  assert.deepEqual(diff(outBefore, snapshot(outside)), []);
});
