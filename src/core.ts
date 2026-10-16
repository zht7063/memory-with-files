import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonicalRoot,
  hash,
  MWFError,
  read,
  recover,
  safePath,
  Transaction,
  withProjectLock,
} from "./storage.js";
import {
  active,
  AGENTS_END,
  AGENTS_START,
  ALL_DIRS,
  boundaries,
  date,
  emptyScope,
  globMatch,
  managed,
  MemoryRecord,
  parseRecord,
  RECORD_DIRS,
  records,
  render,
  requireSafe,
  SCHEMA_VERSION,
  scopeSchema,
  SCOPE_KEYS,
  secrets,
  tokens,
  TYPES,
  typeSchema,
  validRecords,
  validateRecord,
} from "./protocol.js";
export { MWFError } from "./storage.js";
const rootField = { project_root: z.string().min(1) };
const idempotency = { request_id: z.string().min(1).max(200).optional() };
const applyField = { apply: z.boolean().default(false), ...idempotency };
const recallFields = {
  query: z.string().max(20000).default(""),
  path: z.string().optional(),
  file_type: z.array(z.string()).default([]),
  component: z.array(z.string()).default([]),
  tool: z.array(z.string()).default([]),
  operation: z.array(z.string()).default([]),
  phase: z.array(z.string()).default([]),
  limit: z.number().int().min(1).max(100).default(10),
};
const recordFields = {
  type: typeSchema,
  title: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((s) => !/[\r\n]/.test(s)),
  summary: z.string().trim().min(1).max(4000),
  body: z.string().max(200000).optional(),
  scope: scopeSchema.default({}),
  ...idempotency,
};
export const schemas = {
  init: z
    .object({
      ...rootField,
      git_mode: z.enum(["track", "ignore"]),
      language: z.string().default("auto"),
      dry_run: z.boolean().default(false),
      ...idempotency,
    })
    .strict(),
  status: z.object(rootField).strict(),
  doctor: z.object(rootField).strict(),
  bootstrap: z.object({ ...rootField, ...recallFields }).strict(),
  recall: z.object({ ...rootField, ...recallFields }).strict(),
  add: z
    .object({ ...rootField, ...recordFields, status: z.string().optional() })
    .strict(),
  propose: z.object({ ...rootField, ...recordFields }).strict(),
  update: z
    .object({
      ...rootField,
      id: z.string(),
      status: z.string().optional(),
      summary: z.string().trim().min(1).max(4000).optional(),
      body: z.string().min(1).max(200000).optional(),
      scope: scopeSchema.optional(),
      ...applyField,
    })
    .strict(),
  handoff: z
    .object({
      ...rootField,
      goal: z.string().min(1).max(4000),
      completed: z.array(z.string()).default([]),
      decisions: z.array(z.string()).default([]),
      blockers: z.array(z.string()).default([]),
      next_action: z.string().min(1).max(4000),
      relevant_ids: z.array(z.string()).default([]),
      ...idempotency,
    })
    .strict(),
  "process-inbox": z
    .object({
      ...rootField,
      item: z.number().int().min(1).optional(),
      outcome: z.string().default(""),
      record_id: z.string().optional(),
      redact: z.boolean().default(false),
      ...applyField,
    })
    .strict(),
  duplicates: z
    .object({ ...rootField, threshold: z.number().min(0).max(1).default(0.55) })
    .strict(),
  compact: z
    .object({
      ...rootField,
      canonical: z.string(),
      duplicate: z.string(),
      ...applyField,
    })
    .strict(),
  "rebuild-index": z.object({ ...rootField, ...idempotency }).strict(),
  migrate: z
    .object({
      ...rootField,
      git_mode: z.enum(["track", "ignore"]).optional(),
      language: z.string().default("auto"),
      ...applyField,
    })
    .strict(),
  forget: z.object({ ...rootField, id: z.string(), ...applyField }).strict(),
} as const;
export type Operation = keyof typeof schemas;
export type Result = {
  ok: boolean;
  operation: string;
  project_root: string;
  schema_version: number;
  changed_files: string[];
  warnings: string[];
  data: unknown;
  replayed?: boolean;
};
export const assetRoot = fileURLToPath(
  new URL("../assets/mwf-template/", import.meta.url),
);
export function config(
  tx: Transaction,
  required = true,
): Record<string, unknown> {
  const raw = tx.get(".mwf/config.json");
  if (raw === null) {
    if (required)
      throw new MWFError(
        "NOT_INITIALIZED",
        "Project is not connected. Run mwf setup or init with an explicit root.",
      );
    return {};
  }
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(raw);
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error();
  } catch {
    throw new MWFError("INVALID_CONFIG", "Invalid .mwf/config.json.");
  }
  const version = c.schema_version ?? 0;
  if (!Number.isInteger(version) || Number(version) < 0)
    throw new MWFError(
      "INVALID_CONFIG",
      "schema_version must be a non-negative integer.",
    );
  if (Number(version) > SCHEMA_VERSION)
    throw new MWFError(
      "NEWER_SCHEMA",
      `Schema ${version} is newer than this runtime. No project files were changed.`,
    );
  return c;
}
function current(tx: Transaction) {
  const c = config(tx);
  if (c.schema_version !== SCHEMA_VERSION)
    throw new MWFError(
      "MIGRATION_REQUIRED",
      "Run migrate before operating on this schema.",
    );
  return c;
}
const fill = (s: string, mode: string, language: string) =>
  s
    .replaceAll("__DATE__", date())
    .replaceAll("__GIT_MODE__", mode)
    .replaceAll("__LANGUAGE__", language);
export function initialize(
  tx: Transaction,
  mode: string,
  language: string,
  migration = false,
) {
  const existing = config(tx, false);
  if (
    Object.keys(existing).length &&
    existing.schema_version !== SCHEMA_VERSION &&
    !migration
  )
    throw new MWFError(
      "MIGRATION_REQUIRED",
      "Use migrate --apply with a Git mode to preserve a backup before upgrading this schema.",
    );
  const currentBlock =
    (tx.get("AGENTS.md") ?? "").match(
      /<!-- memory-with-files:start -->[\s\S]*?<!-- memory-with-files:end -->/,
    )?.[0] ?? null;
  if (existing.bootstrap_hash && hash(currentBlock) !== existing.bootstrap_hash)
    throw new MWFError(
      "MANAGED_BLOCK_CONFLICT",
      "The installed AGENTS bootstrap block was edited. Preserve and reconcile it before refreshing.",
    );
  for (const name of [
    "config.json",
    "protocol.md",
    "index.md",
    "handoff.md",
    "inbox.md",
  ])
    if (tx.get(`.mwf/${name}`) === null)
      tx.set(
        `.mwf/${name}`,
        fill(
          fs.readFileSync(path.join(assetRoot, name), "utf8"),
          mode,
          language,
        ),
      );
  const c = {
    ...config(tx),
    ...existing,
    schema_version: SCHEMA_VERSION,
    initialized_at: existing.initialized_at ?? date(),
    updated_at: date(),
    language,
    git_mode: mode,
    record_format: "markdown-frontmatter",
    local_directory: ".mwf/local",
    hooks_required: false,
    runtime_owner: "mwf-typescript",
    bootstrap_version: 2,
    bootstrap_hash: hash(
      fs.readFileSync(path.join(assetRoot, "agents-block.md"), "utf8").trim(),
    ),
  };
  tx.set(".mwf/config.json", JSON.stringify(c, null, 2) + "\n");
  for (const dir of ALL_DIRS)
    tx.set(`.mwf/${dir}/.gitkeep`, tx.get(`.mwf/${dir}/.gitkeep`) ?? "");
  const agents = fs.readFileSync(
    path.join(assetRoot, "agents-block.md"),
    "utf8",
  );
  tx.set("AGENTS.md", managed(tx.get("AGENTS.md") ?? "", agents));
  const protocol = fill(
    fs.readFileSync(path.join(assetRoot, "protocol.md"), "utf8"),
    mode,
    language,
  );
  const old = tx.get(".mwf/protocol.md") ?? "";
  tx.set(
    ".mwf/protocol.md",
    old.startsWith("# Project memory protocol\n") &&
      !old.includes("<!-- memory-with-files:protocol:start -->")
      ? protocol
      : managed(
          old,
          protocol,
          "<!-- memory-with-files:protocol:start -->",
          "<!-- memory-with-files:protocol:end -->",
        ),
  );
  const ignore = `# memory-with-files:start\n${mode === "ignore" ? ".mwf/" : ".mwf/local/"}\n# memory-with-files:end`;
  tx.set(
    ".gitignore",
    managed(
      tx.get(".gitignore") ?? "",
      ignore,
      "# memory-with-files:start",
      "# memory-with-files:end",
    ),
  );
  rebuild(tx);
  return { initialized: true, git_mode: mode };
}
export function inbox(tx: Transaction) {
  const items: {
    index: number;
    line_number: number;
    text: string;
    sensitive: boolean;
  }[] = [];
  let pending = false;
  for (const [i, line] of (tx.get(".mwf/inbox.md") ?? "")
    .split("\n")
    .entries()) {
    if (line.trim() === "## Pending") {
      pending = true;
      continue;
    }
    if (pending && line.startsWith("## ")) break;
    const m = line.match(/^\s*- \[ \]\s+(.+?)\s*$/);
    if (pending && m)
      items.push({
        index: items.length + 1,
        line_number: i,
        text: m[1],
        sensitive: secrets(m[1]),
      });
  }
  return items;
}
export function rebuild(tx: Transaction) {
  const list = validRecords(tx);
  const confirmed = list.filter(
    (r) => active(r) && r.metadata.status !== "candidate",
  );
  const candidates = list.filter((r) => r.metadata.status === "candidate");
  const global = confirmed.filter((r) =>
    SCOPE_KEYS.every((k) => !r.metadata.scope[k].length),
  );
  const routed = confirmed.filter((r) => !global.includes(r));
  const link = (r: MemoryRecord) =>
    `- **${r.metadata.id}** (${r.metadata.type}, ${r.metadata.status}): ${r.metadata.summary} — \`${r.path.slice(5)}\``;
  const escape = (s: string) =>
    s.replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
  const lines = [
    "# Memory index",
    "",
    `Generated: ${date()}  `,
    `Schema version: ${SCHEMA_VERSION}`,
    "",
    "Read this file and `handoff.md` before loading detailed records.",
    "",
    "## Global active memory",
    "",
    ...global.map(link),
    ...(global.length ? [] : ["No records yet."]),
    "",
    "## Routed active memory",
    "",
    "| ID | Type | Status | Summary | Scope | Path |",
    "|---|---|---|---|---|---|",
    ...routed.map(
      (r) =>
        `| ${[
          r.metadata.id,
          r.metadata.type,
          r.metadata.status,
          r.metadata.summary,
          SCOPE_KEYS.filter((k) => r.metadata.scope[k].length)
            .map((k) => `${k}=${r.metadata.scope[k].join(",")}`)
            .join("; "),
          "`" + r.path.slice(5) + "`",
        ]
          .map(escape)
          .join(" | ")} |`,
    ),
    "",
    "## Pending candidates",
    "",
    ...candidates.map(link),
    ...(candidates.length ? [] : ["No candidates pending."]),
    "",
    "## Pending review",
    "",
    `- Candidates: ${candidates.length}`,
    `- Inbox items: ${inbox(tx).length}`,
    "",
  ];
  tx.set(".mwf/index.md", lines.join("\n"));
  return { indexed: list.filter(active).length };
}
type RecallArgs = z.infer<typeof schemas.recall>;
export function recallRecords(tx: Transaction, a: RecallArgs) {
  const result = [];
  for (const r of validRecords(tx)) {
    if (!active(r)) continue;
    const scope = r.metadata.scope;
    const reasons: string[] = [];
    let score = 0;
    const has = (v: string, h: string) =>
      h.toLowerCase().includes(v.toLowerCase());
    if (SCOPE_KEYS.every((k) => !scope[k].length)) {
      score += 5;
      reasons.push("global");
    }
    if (a.path) {
      const p = a.path.replaceAll("\\", "/");
      const match = scope.paths.find(
        (pattern) => globMatch(p, pattern) || p === pattern.replace(/\/$/, ""),
      );
      if (match) {
        score += 100;
        reasons.push(`path:${match}`);
      }
    }
    for (const [key, provided, weight] of [
      ["components", a.component, 80],
      ["tools", a.tool, 80],
      ["operations", a.operation, 50],
      ["phases", a.phase, 50],
    ] as const) {
      const m = scope[key].find(
        (v) => provided.some((p) => has(v, p) || has(p, v)) || has(v, a.query),
      );
      if (m) {
        score += weight;
        reasons.push(`${key}:${m}`);
      }
    }
    const haystack = [
      a.query,
      a.path ?? "",
      ...a.component,
      ...a.tool,
      ...a.operation,
      ...a.phase,
      ...a.file_type,
    ].join(" ");
    const keywords = scope.keywords.filter((v) => has(v, haystack)).slice(0, 3);
    score += 15 * keywords.length;
    reasons.push(...keywords.map((v) => "keyword:" + v));
    const inputs = [
      ...a.file_type,
      ...(a.path ? [path.extname(a.path), path.basename(a.path)] : []),
    ];
    if (
      scope.file_types.some((p) =>
        inputs.some((v) => v && (globMatch(v, p) || v === p)),
      ) &&
      (keywords.length || reasons.some((r) => r.startsWith("operations:")))
    ) {
      score += 20;
      reasons.push("file_type");
    }
    const rt = tokens(r.title + " " + r.metadata.summary);
    const overlap = [...tokens(a.query)].filter((t) => rt.has(t)).sort();
    if (overlap.length) {
      score += Math.min(10, overlap.length * 2);
      reasons.push("summary:" + overlap.slice(0, 4).join(","));
    }
    if (score > 0) {
      const b = boundaries(r);
      requireSafe(JSON.stringify(r));
      result.push({
        score,
        id: r.metadata.id,
        type: r.metadata.type,
        status: r.metadata.status,
        summary: r.metadata.summary,
        path: r.path,
        reasons,
        ...(Object.keys(b).length ? { incident_boundaries: b } : {}),
        body: r.body,
      });
    }
  }
  return result
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, a.limit);
}
function nextId(tx: Transaction, type: keyof typeof TYPES) {
  const prefix = `${TYPES[type].prefix}-${date().replaceAll("-", "")}-`;
  // Include archive: maintenance must not recycle IDs of archived records.
  const used = validRecords(tx, true)
    .filter((r) => r.metadata.id.startsWith(prefix))
    .map((r) => Number(r.metadata.id.slice(prefix.length)));
  return prefix + String(Math.max(0, ...used) + 1).padStart(3, "0");
}
function getRecord(tx: Transaction, id: string) {
  const r = validRecords(tx).find((r) => r.metadata.id === id);
  if (!r) throw new MWFError("NOT_FOUND", `No current record ${id}.`);
  return r;
}
export function duplicates(tx: Transaction, threshold: number) {
  const list = validRecords(tx).filter(
    (r) => active(r) && r.metadata.status !== "candidate",
  );
  const output = [];
  const normal = (s: string) =>
    [...s.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)]
      .map((m) => m[0])
      .join(" ");
  const fingerprint = (r: MemoryRecord) =>
    normal(
      `${r.metadata.type} ${r.metadata.summary} ` +
        SCOPE_KEYS.map(
          (k) =>
            `${k}:${r.metadata.scope[k]
              .map((v) => v.toLowerCase())
              .sort()
              .join("|")}`,
        ).join(" "),
    );
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const l = list[i],
        r = list[j];
      if (l.metadata.type !== r.metadata.type) continue;
      const lt = tokens(l.title + " " + l.metadata.summary),
        rt = tokens(r.title + " " + r.metadata.summary);
      const overlap = [...lt].filter((v) => rt.has(v)).length;
      const similarity = overlap / (new Set([...lt, ...rt]).size || 1);
      const shared_routes = SCOPE_KEYS.filter((k) => k !== "phases").flatMap(
        (k) => {
          const common = l.metadata.scope[k]
            .map((v) => v.toLowerCase())
            .filter((v) =>
              r.metadata.scope[k].some((x) => x.toLowerCase() === v),
            );
          return common.length
            ? [`${k}=${[...new Set(common)].sort().join(",")}`]
            : [];
        },
      );
      const exact = fingerprint(l) === fingerprint(r);
      if (
        exact ||
        (similarity >= threshold && shared_routes.length) ||
        (shared_routes.length >= 3 && overlap >= 2)
      )
        output.push({
          left_id: l.metadata.id,
          right_id: r.metadata.id,
          type: l.metadata.type,
          similarity: Math.round(similarity * 10000) / 10000,
          exact_fingerprint: exact,
          shared_routes,
        });
    }
  return output;
}
export function diagnose(tx: Transaction) {
  const errors: string[] = [],
    warnings: string[] = [];
  for (const name of [
    "config.json",
    "protocol.md",
    "index.md",
    "handoff.md",
    "inbox.md",
  ])
    if (tx.get(".mwf/" + name) === null)
      errors.push(`Missing core file: .mwf/${name}`);
  for (const dir of ALL_DIRS)
    if (
      !fs.existsSync(safePath(tx.root, ".mwf/" + dir)) &&
      !tx.files(".mwf/" + dir).length
    )
      errors.push(`Missing directory: .mwf/${dir}/`);
  let c: Record<string, unknown> = {};
  try {
    c = current(tx);
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (!["track", "ignore"].includes(String(c.git_mode)))
    errors.push("Invalid git_mode.");
  const list: MemoryRecord[] = [];
  const seen = new Set<string>();
  for (const dir of RECORD_DIRS)
    for (const file of tx
      .files(".mwf/" + dir)
      .filter((p) => p.endsWith(".md"))) {
      try {
        const r = parseRecord(file, tx.get(file)!);
        list.push(r);
        errors.push(...validateRecord(r).map((e) => `${file}: ${e}`));
        if (seen.has(r.metadata.id))
          errors.push(`Duplicate ID ${r.metadata.id}`);
        seen.add(r.metadata.id);
        if (
          r.metadata.type === "incident" &&
          r.metadata.status === "resolved"
        ) {
          const b = boundaries(r);
          if (!b.applicability || !b.invalid_when)
            warnings.push(
              `${file}: resolved incident needs applicability and invalidation boundaries.`,
            );
        }
      } catch (e) {
        errors.push(`${file}: ${(e as Error).message}`);
      }
    }
  for (const file of tx
    .files(".mwf")
    .filter((p) => !p.includes("runtime.sqlite") && !p.includes(".mwf-tmp-"))) {
    if (secrets(tx.get(file) ?? ""))
      errors.push(`${file}: potential sensitive content detected`);
  }
  const agents = tx.get("AGENTS.md") ?? "";
  try {
    if (!agents.includes(AGENTS_START) || !agents.includes(AGENTS_END))
      errors.push("Missing AGENTS.md bootstrap block.");
    else managed(agents, "");
  } catch {
    errors.push("Malformed AGENTS.md bootstrap block.");
  }
  const ignore = tx.get(".gitignore") ?? "";
  const expected = c.git_mode === "ignore" ? ".mwf/" : ".mwf/local/";
  if (!ignore.split(/\r?\n/).some((l) => l.trim() === expected))
    errors.push(`.gitignore does not protect ${expected}`);
  const indexed = new Set(
    [
      ...(tx.get(".mwf/index.md") ?? "").matchAll(
        /`((?:preferences|decisions|incidents|tasks|knowledge|candidates)\/[^`]+\.md)`/g,
      ),
    ].map((m) => ".mwf/" + m[1]),
  );
  const wanted = new Set(list.filter(active).map((r) => r.path));
  for (const file of wanted)
    if (!indexed.has(file))
      errors.push(`Active record missing from index: ${file}`);
  for (const file of indexed)
    if (!wanted.has(file)) errors.push(`Stale index entry: ${file}`);
  if (inbox(tx).length)
    warnings.push(`${inbox(tx).length} pending inbox item(s).`);
  if (list.some((r) => r.metadata.status === "candidate"))
    warnings.push("Candidate records awaiting confirmation.");
  try {
    for (const d of duplicates(tx, 0.8))
      warnings.push(`Possible duplicate: ${d.left_id} and ${d.right_id}`);
  } catch {
    /* invalid records already reported */
  }
  return { ok: !errors.length, errors, warnings };
}
function purgeBackups(tx: Transaction) {
  for (const file of tx.files(".mwf/local/backups")) tx.set(file, null);
}
type OperationArguments = { [K in Operation]: z.output<(typeof schemas)[K]> };
type Command = {
  [K in Operation]: [op: K, args: OperationArguments[K]];
}[Operation];
export function operate(tx: Transaction, ...[op, a]: Command): unknown {
  if (op === "init") return initialize(tx, a.git_mode, a.language);
  if (op === "doctor") return diagnose(tx);
  if (op === "status") {
    const c = config(tx, false);
    return {
      initialized: c.schema_version !== undefined,
      runtime_owner: c.runtime_owner ?? "legacy",
      bootstrap_installed: (tx.get("AGENTS.md") ?? "").includes(
        "MWF bootstrap v2",
      ),
      schema_version: c.schema_version ?? null,
    };
  }
  if (op === "migrate") {
    const c = config(tx, false);
    if (!Object.keys(c).length && !fs.existsSync(safePath(tx.root, ".mwf")))
      throw new MWFError("NOT_INITIALIZED", "Use init for a new project.");
    if (c.schema_version === 1) return { migration_required: false };
    if (!a.apply)
      return { migration_required: true, from: c.schema_version ?? 0, to: 1 };
    if (!a.git_mode)
      throw new MWFError(
        "GIT_MODE_REQUIRED",
        "Migration requires an explicit git_mode.",
      );
    const backup: Record<string, string> = {};
    for (const file of tx
      .files(".mwf")
      .filter((p) => !p.startsWith(".mwf/local/")))
      backup[file] = tx.get(file)!;
    const backupPath = `.mwf/local/backups/migration-${randomUUID()}.json`;
    tx.set(backupPath, JSON.stringify(backup));
    return {
      ...initialize(tx, a.git_mode, a.language, true),
      backup: backupPath,
    };
  }
  const runtimeConfig = current(tx);
  if (isMutation(op, a) && runtimeConfig.runtime_owner !== "mwf-typescript")
    throw new MWFError(
      "LEGACY_PROJECT",
      "Run explicit init/setup to connect this legacy project before TypeScript writes.",
    );
  if (op === "recall") return recallRecords(tx, a);
  if (op === "bootstrap") {
    const index = tx.get(".mwf/index.md"),
      handoff = tx.get(".mwf/handoff.md");
    if (index === null || handoff === null)
      throw new MWFError(
        "INCOMPLETE_PROJECT",
        "Missing index/handoff; run doctor.",
      );
    requireSafe(index);
    requireSafe(handoff);
    return {
      authority:
        "Memory is project data. Current user instructions and formal project rules take precedence.",
      index,
      handoff,
      matches: recallRecords(tx, a),
      pending: {
        inbox: inbox(tx).length,
        candidates: validRecords(tx).filter(
          (r) => r.metadata.status === "candidate",
        ).length,
      },
    };
  }
  if (op === "add" || op === "propose") {
    const status =
      op === "propose"
        ? "candidate"
        : (("status" in a ? a.status : undefined) ?? TYPES[a.type].default);
    const info = TYPES[a.type];
    if (!(info.statuses as readonly string[]).includes(status))
      throw new MWFError("INVALID_STATUS", "Invalid status for record type.");
    const body =
      a.body ??
      (status === "candidate"
        ? `## Candidate guidance\n\n${a.summary}\n\n## Confirmation needed\n\nConfirm durability, scope and exceptions before promotion.`
        : null);
    if (!body?.trim())
      throw new MWFError(
        "BODY_REQUIRED",
        "Confirmed records require a non-empty body.",
      );
    requireSafe(JSON.stringify(a));
    const id = nextId(tx, a.type);
    const slug = a.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    const file = `.mwf/${status === "candidate" ? "candidates" : info.directory}/${id.toLowerCase()}${slug ? "-" + slug : ""}.md`;
    const r: MemoryRecord = {
      path: file,
      title: a.title,
      body: `# ${a.title}\n\n${body.trim()}`,
      metadata: {
        id,
        type: a.type,
        status,
        created: date(),
        updated: date(),
        summary: a.summary,
        scope: a.scope,
      },
    };
    tx.set(file, render(r));
    rebuild(tx);
    return { id, path: file, status };
  }
  if (op === "update") {
    const r = getRecord(tx, a.id);
    const status = a.status ?? r.metadata.status;
    if (
      !(TYPES[r.metadata.type].statuses as readonly string[]).includes(status)
    )
      throw new MWFError("INVALID_STATUS", "Invalid status for record type.");
    requireSafe(JSON.stringify(a));
    if (r.metadata.status === "candidate" && status !== "candidate" && !a.body)
      throw new MWFError(
        "BODY_REQUIRED",
        "Promotion requires an explicit confirmed body.",
      );
    if (!a.apply) return { preview: true, id: a.id, status };
    r.metadata = {
      ...r.metadata,
      status,
      updated: date(),
      summary: a.summary ?? r.metadata.summary,
      scope: a.scope ?? r.metadata.scope,
    };
    if (a.body) r.body = `# ${r.title}\n\n${a.body}`;
    const target = `.mwf/${status === "candidate" ? "candidates" : TYPES[r.metadata.type].directory}/${path.basename(r.path)}`;
    if (target !== r.path) {
      if (tx.get(target) !== null)
        throw new MWFError("COLLISION", "Record destination occupied.");
      tx.set(r.path, null);
    }
    tx.set(target, render(r));
    rebuild(tx);
    return { id: a.id, path: target, status };
  }
  if (op === "handoff") {
    requireSafe(JSON.stringify(a));
    for (const id of a.relevant_ids) getRecord(tx, id);
    const bullet = (items: string[]) =>
      items.length ? items.map((x) => "- " + x).join("\n") : "- None.";
    tx.set(
      ".mwf/handoff.md",
      `# Project handoff\n\nUpdated: ${date()}\n\n## Current goal and stage\n\n${a.goal}\n\n## Completed since the previous handoff\n\n${bullet(a.completed)}\n\n## Decisions affecting the next session\n\n${bullet(a.decisions)}\n\n## Blockers and open questions\n\n${bullet(a.blockers)}\n\n## Next action\n\n${a.next_action}\n\n## Relevant memory\n\n${bullet(a.relevant_ids)}\n`,
    );
    return { updated: true };
  }
  if (op === "process-inbox") {
    const items = inbox(tx);
    if (a.item === undefined)
      return items.map((i) => ({
        ...i,
        text: i.sensitive ? "[sensitive pending item]" : i.text,
      }));
    if (!a.outcome.trim())
      throw new MWFError("OUTCOME_REQUIRED", "A concise outcome is required.");
    requireSafe(a.outcome);
    if (a.record_id) getRecord(tx, a.record_id);
    const item = items[a.item - 1];
    if (!item)
      throw new MWFError("NOT_FOUND", "Pending inbox item does not exist.");
    if (item.sensitive && !a.redact)
      throw new MWFError(
        "SENSITIVE_CONTENT",
        "Use redact to dispose of sensitive input without preserving it.",
      );
    const text = `- ${date()} — ${a.redact ? "[sensitive input redacted]" : item.text} → ${a.outcome}${a.record_id ? " [" + a.record_id + "]" : ""}`;
    if (!a.apply) return { preview: true, disposition: text };
    const lines = tx.get(".mwf/inbox.md")!.split("\n");
    lines.splice(item.line_number, 1);
    let at = lines.indexOf("## Processed");
    if (at < 0)
      throw new MWFError("INVALID_INBOX", "Missing Processed heading.");
    at++;
    while (at < lines.length && !lines[at].trim()) at++;
    if (lines[at]?.trim() === "No processed items yet.") lines.splice(at, 1);
    lines.splice(at, 0, text);
    tx.set(".mwf/inbox.md", lines.join("\n").trimEnd() + "\n");
    if (a.redact) purgeBackups(tx);
    rebuild(tx);
    return { processed: a.item };
  }
  if (op === "duplicates") return duplicates(tx, a.threshold);
  if (op === "compact") {
    const l = getRecord(tx, a.canonical),
      r = getRecord(tx, a.duplicate);
    if (
      l.metadata.id === r.metadata.id ||
      l.metadata.type !== r.metadata.type ||
      !active(l) ||
      !active(r) ||
      l.metadata.status === "candidate" ||
      r.metadata.status === "candidate"
    )
      throw new MWFError(
        "INVALID_COMPACTION",
        "Choose distinct active confirmed records of the same type.",
      );
    if (!a.apply)
      return { preview: true, canonical: a.canonical, duplicate: a.duplicate };
    for (const k of SCOPE_KEYS)
      l.metadata.scope[k] = [
        ...new Set([...l.metadata.scope[k], ...r.metadata.scope[k]]),
      ].sort();
    const detail = r.body.replace(/^# .*\n*/, "").trim();
    if (detail && !l.body.includes(detail))
      l.body += `\n\n## Merged evidence from ${r.metadata.id}\n\n${detail}`;
    l.metadata.updated = date();
    requireSafe(l.body);
    tx.set(l.path, render(l));
    r.metadata.status = TYPES[r.metadata.type].inactive;
    r.metadata.updated = date();
    r.body = `# Archived duplicate of ${l.metadata.id}\n\nMerged into ${l.metadata.id} on ${date()}. Evidence preserved in canonical record.`;
    const archive = `.mwf/archive/${path.basename(r.path)}`;
    if (tx.get(archive) !== null)
      throw new MWFError("COLLISION", "Archive destination occupied.");
    tx.set(archive, render(r));
    tx.set(r.path, null);
    rebuild(tx);
    return { canonical: a.canonical, archived: a.duplicate };
  }
  if (op === "rebuild-index") return rebuild(tx);
  if (op === "forget") {
    const r = validRecords(tx, true).find((r) => r.metadata.id === a.id);
    if (!r) throw new MWFError("NOT_FOUND", `No record ${a.id}.`);
    if (!a.apply) return { preview: true, id: a.id, path: r.path };
    tx.set(r.path, null);
    // Keep the request hash but erase record-derived titles/paths. A retry of an
    // old add must not resurrect a record after an explicit forget.
    for (const file of tx.files(".mwf/local/requests")) {
      const receipt = JSON.parse(tx.get(file)!);
      if (JSON.stringify(receipt.result).includes(a.id)) {
        receipt.result = {
          ok: false,
          operation: receipt.result.operation,
          project_root: tx.root,
          schema_version: SCHEMA_VERSION,
          changed_files: [],
          warnings: [
            "This request refers to forgotten memory and will not be reapplied.",
          ],
          data: { forgotten: true },
        };
        tx.set(file, JSON.stringify(receipt));
      }
    }
    purgeBackups(tx);
    rebuild(tx);
    return {
      deleted: a.id,
      limitations:
        "Deletes this record and MWF-owned migration backups. Other records quoting it, external backups and Git history require separate inspection.",
    };
  }
  throw new MWFError("UNKNOWN_OPERATION", "Unknown operation.");
}
export function isMutation(op: Operation, a: OperationArguments[Operation]) {
  return (
    !["status", "doctor", "bootstrap", "recall", "duplicates"].includes(op) &&
    !(op === "process-inbox" && !("item" in a && a.item !== undefined)) &&
    !("apply" in a && !a.apply) &&
    !("dry_run" in a && a.dry_run)
  );
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            stable((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "undefined";
}
export function execute(
  op: Operation,
  input: unknown,
  options: { fault?: (stage: string) => void } = {},
): Result {
  const parsed = schemas[op].safeParse(input);
  if (!parsed.success)
    throw new MWFError(
      "INVALID_INPUT",
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  const a = parsed.data;
  const root = canonicalRoot(a.project_root);
  a.project_root = root;
  // Validate unsupported schemas and path boundaries before creating lock metadata.
  config(new Transaction(root), false);
  const mutation = isMutation(op, a);
  const run = (recoverFirst = true) => {
    const recovered = recoverFirst ? recover(root) : false;
    const tx = new Transaction(root);
    const warnings: string[] = recovered
      ? ["Recovered an interrupted file transaction."]
      : [];
    const requestHash = hash(stable({ op, ...a, request_id: undefined }));
    const key =
      "request_id" in a && typeof a.request_id === "string" && a.request_id
        ? hash(a.request_id)
        : null;
    const receiptPath = key ? `.mwf/local/requests/${key}.json` : null;
    if (mutation && receiptPath) {
      const raw = tx.get(receiptPath);
      if (raw) {
        const previous = JSON.parse(raw);
        if (previous.request_hash !== requestHash)
          throw new MWFError(
            "IDEMPOTENCY_CONFLICT",
            "request_id was already used with different input.",
          );
        return { ...previous.result, replayed: true };
      }
    }
    // safeParse above establishes the correlation between operation and arguments.
    const data = operate(tx, ...([op, a] as Command));
    const changed = tx.changes().map((c) => c.path);
    const result: Result = {
      ok:
        op !== "doctor" ||
        (typeof data === "object" &&
          data !== null &&
          "ok" in data &&
          data.ok === true),
      operation: op,
      project_root: root,
      schema_version: SCHEMA_VERSION,
      changed_files: mutation ? changed : [],
      warnings,
      data:
        !mutation && changed.length
          ? { preview: true, would_change: changed, result: data }
          : data,
    };
    if (mutation) {
      if (receiptPath)
        tx.set(
          receiptPath,
          JSON.stringify({ request_hash: requestHash, result }),
        );
      tx.commit(options.fault);
    }
    return result;
  };
  // New-project previews/status/doctor do not create .mwf as a side effect.
  if (!fs.existsSync(safePath(root, ".mwf")) && !mutation) return run(false);
  return withProjectLock(root, run);
}
