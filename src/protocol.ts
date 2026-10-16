import path from "node:path";
import { z } from "zod";
import { MWFError, Transaction } from "./storage.js";
export const SCHEMA_VERSION = 1;
export const SCOPE_KEYS = [
  "paths",
  "file_types",
  "components",
  "tools",
  "operations",
  "phases",
  "keywords",
] as const;
export const RECORD_DIRS = [
  "preferences",
  "decisions",
  "incidents",
  "tasks",
  "knowledge",
  "candidates",
];
export const ALL_DIRS = [...RECORD_DIRS, "archive", "local"];
export const TYPES = {
  preference: {
    prefix: "PREF",
    directory: "preferences",
    default: "stable",
    statuses: ["candidate", "stable", "deprecated"],
    inactive: "deprecated",
  },
  decision: {
    prefix: "DEC",
    directory: "decisions",
    default: "accepted",
    statuses: ["candidate", "proposed", "accepted", "superseded"],
    inactive: "superseded",
  },
  incident: {
    prefix: "INC",
    directory: "incidents",
    default: "open",
    statuses: ["candidate", "open", "resolved", "obsolete"],
    inactive: "obsolete",
  },
  task: {
    prefix: "TASK",
    directory: "tasks",
    default: "active",
    statuses: ["candidate", "planned", "active", "blocked", "completed"],
    inactive: "completed",
  },
  knowledge: {
    prefix: "KNOW",
    directory: "knowledge",
    default: "stable",
    statuses: ["candidate", "stable", "deprecated"],
    inactive: "deprecated",
  },
} as const;
export type RecordType = keyof typeof TYPES;
export const typeSchema = z.enum([
  "preference",
  "decision",
  "incident",
  "task",
  "knowledge",
]);
export const scopeSchema = z
  .object(
    Object.fromEntries(
      SCOPE_KEYS.map((k) => [
        k,
        z.array(z.string().min(1).max(500)).max(100).default([]),
      ]),
    ) as Record<
      (typeof SCOPE_KEYS)[number],
      z.ZodDefault<z.ZodArray<z.ZodString>>
    >,
  )
  .strict();
export type Scope = z.infer<typeof scopeSchema>;
export const emptyScope = () => scopeSchema.parse({});
export const date = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const active = (r: MemoryRecord) =>
  !["deprecated", "superseded", "obsolete", "completed"].includes(
    r.metadata.status,
  );
export const secrets = (text: string) =>
  [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b/,
    /\b(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S{8,}/i,
  ].some((p) => p.test(text));
export function requireSafe(text: string) {
  if (secrets(text))
    throw new MWFError(
      "SENSITIVE_CONTENT",
      "Potential credential-like content; redact it before storing.",
    );
}
export const AGENTS_START = "<!-- memory-with-files:start -->";
export const AGENTS_END = "<!-- memory-with-files:end -->";
export function managed(
  old: string,
  block: string,
  start = AGENTS_START,
  end = AGENTS_END,
) {
  const starts = old.split(start).length - 1,
    ends = old.split(end).length - 1;
  if (
    starts !== ends ||
    starts > 1 ||
    (starts && old.indexOf(end) < old.indexOf(start))
  )
    throw new MWFError(
      "MANAGED_BLOCK_CONFLICT",
      "Malformed or duplicate managed markers; preserve and repair the existing file.",
    );
  if (!starts)
    return (old.trimEnd() ? old.trimEnd() + "\n\n" : "") + block.trim() + "\n";
  return (
    old.slice(0, old.indexOf(start)) +
    block.trim() +
    old.slice(old.indexOf(end) + end.length)
  );
}
export type Metadata = {
  id: string;
  type: RecordType;
  status: string;
  created: string;
  updated: string;
  summary: string;
  scope: Scope;
  [key: string]: unknown;
};
export type MemoryRecord = {
  path: string;
  metadata: Metadata;
  title: string;
  body: string;
};
const scalar = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
export function parseRecord(file: string, text: string): MemoryRecord {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---")
    throw new MWFError("INVALID_RECORD", `Missing frontmatter: ${file}`);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0)
    throw new MWFError("INVALID_RECORD", `Unclosed frontmatter: ${file}`);
  const metadata: Record<string, unknown> = {};
  const scope: Record<string, unknown> = {};
  let inScope = false;
  for (const raw of lines.slice(1, end)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (raw === "scope:") {
      inScope = true;
      continue;
    }
    const entry = raw.match(/^\s*([^:]+):\s*(.*)$/);
    if (!entry)
      throw new MWFError("INVALID_RECORD", `Malformed frontmatter: ${file}`);
    const [, key, value] = entry;
    if (inScope && raw.startsWith("  ")) scope[key.trim()] = scalar(value);
    else {
      inScope = false;
      metadata[key.trim()] = scalar(value);
    }
  }
  metadata.scope = scope;
  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  return {
    path: file,
    metadata: metadata as Metadata,
    title:
      body
        .split("\n")
        .find((l) => l.startsWith("# "))
        ?.slice(2)
        .trim() ?? path.basename(file, ".md"),
    body,
  };
}
export function validateRecord(r: MemoryRecord): string[] {
  const m = r.metadata;
  const errors: string[] = [];
  for (const k of [
    "id",
    "type",
    "status",
    "created",
    "updated",
    "summary",
    "scope",
  ])
    if (m[k] === undefined) errors.push(`missing ${k}`);
  if (!Object.hasOwn(TYPES, m.type)) return [...errors, "unknown record type"];
  const info = TYPES[m.type];
  if (!new RegExp(`^${info.prefix}-\\d{8}-\\d{3,}$`).test(m.id))
    errors.push("invalid record ID");
  if (!(info.statuses as readonly string[]).includes(m.status))
    errors.push("invalid status");
  for (const k of ["created", "updated"]) {
    const v = String(m[k]);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
      Number.isNaN(Date.parse(v)) ||
      new Date(v).toISOString().slice(0, 10) !== v
    )
      errors.push(`invalid ${k} date`);
  }
  if (typeof m.summary !== "string" || !m.summary.trim())
    errors.push("empty summary");
  if (
    !scopeSchema.safeParse(m.scope).success ||
    SCOPE_KEYS.some((k) => !Array.isArray(m.scope?.[k]))
  )
    errors.push("invalid scope");
  if (r.path.startsWith(".mwf/candidates/") && m.status !== "candidate")
    errors.push("candidate directory requires candidate status");
  return errors;
}
export function records(tx: Transaction, archive = false): MemoryRecord[] {
  return (archive ? [...RECORD_DIRS, "archive"] : RECORD_DIRS).flatMap((dir) =>
    tx
      .files(`.mwf/${dir}`)
      .filter((p) => p.endsWith(".md"))
      .map((p) => parseRecord(p, tx.get(p)!)),
  );
}
export function validRecords(tx: Transaction, archive = false) {
  const result = records(tx, archive);
  const ids = new Set<string>();
  for (const r of result) {
    const errors = validateRecord(r);
    if (errors.length)
      throw new MWFError("INVALID_RECORD", `${r.path}: ${errors.join(", ")}`);
    if (ids.has(r.metadata.id))
      throw new MWFError(
        "DUPLICATE_ID",
        `Duplicate ID ${r.metadata.id}; run doctor.`,
      );
    ids.add(r.metadata.id);
  }
  return result;
}
export function render(r: MemoryRecord) {
  const m = r.metadata;
  const head = [
    "---",
    `id: ${m.id}`,
    `type: ${m.type}`,
    `status: ${m.status}`,
    `created: ${m.created}`,
    `updated: ${m.updated}`,
    `summary: ${JSON.stringify(m.summary)}`,
    "scope:",
    ...SCOPE_KEYS.map((k) => `  ${k}: ${JSON.stringify(m.scope[k])}`),
  ];
  for (const k of Object.keys(m).sort())
    if (
      ![
        "id",
        "type",
        "status",
        "created",
        "updated",
        "summary",
        "scope",
      ].includes(k)
    )
      head.push(`${k}: ${JSON.stringify(m[k])}`);
  return [...head, "---", "", r.body.trim(), ""].join("\n");
}
export function boundaries(r: MemoryRecord) {
  const result: Record<string, string> = {};
  if (r.metadata.type !== "incident") return result;
  let heading = "body";
  const sections: Record<string, string[]> = { body: [] };
  for (const line of r.body.split("\n")) {
    const match = line.match(/^##+\s+(.+?)\s*$/);
    if (match) {
      heading = match[1].toLowerCase();
      sections[heading] ??= [];
    } else sections[heading].push(line);
  }
  for (const [h, lines] of Object.entries(sections)) {
    const text = lines.join("\n").trim();
    if (!text) continue;
    if (/applicability|applies|limits|valid when/.test(h))
      result.applicability ??= text;
    if (/invalid|does not apply|failure condition|obsolete when/.test(h))
      result.invalid_when ??= text;
  }
  return result;
}
export const tokens = (s: string) =>
  new Set(
    (s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
      (x) => x.length > 1,
    ),
  );
// Python fnmatch's '*' also matches '/'. Preserve the legacy routing semantics.
export function globMatch(value: string, pattern: string) {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") regex += ".*";
    else if (c === "?") regex += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end > i) {
        let cls = pattern.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        regex += "[" + cls + "]";
        i = end;
      } else regex += "\\[";
    } else regex += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(regex + "$").test(value);
  } catch {
    return value === pattern;
  }
}
