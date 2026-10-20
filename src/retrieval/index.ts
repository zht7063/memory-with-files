import path from "node:path";
import { hash, Transaction } from "../storage/index.js";
import { validRecords } from "../storage/records.js";
import {
  active,
  boundaries,
  requireSafe,
  SCOPE_KEYS,
  type MemoryRecord,
} from "../contracts/records.js";
export const normalize = (s: string) => s.normalize("NFKC").toLowerCase();
export function tokens(s: string) {
  const text = normalize(s);
  const result = new Set(text.match(/[a-z0-9_]+/g) ?? []);
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i < chars.length - 1; i++)
      result.add(chars[i] + chars[i + 1]);
    if (chars.length === 1 && text.trim() === run) result.add(run);
  }
  return result;
}
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

type RecallArgs = {
  project_root: string;
  mode: "default" | "review" | "history";
  query: string;
  path?: string;
  file_type: string[];
  component: string[];
  tool: string[];
  operation: string[];
  phase: string[];
  limit: number;
  max_reference_tokens?: number;
  max_output_bytes?: number;
};
export function recallRecords(tx: Transaction, a: RecallArgs) {
  const result = [];
  for (const r of validRecords(tx)) {
    if (!eligible(r, a.mode)) continue;
    const scope = r.metadata.scope;
    const reasons: string[] = [];
    let score = 0;
    const has = (v: string, h: string) => normalize(h).includes(normalize(v));
    if (SCOPE_KEYS.every((k) => !scope[k].length)) {
      score += 5;
      reasons.push("global");
    }
    if (a.path) {
      const p = a.path.replaceAll("\\", "/");
      const match = scope.paths.find(
        (pattern) => globMatch(p, pattern) || p === pattern.replace(/\/$/, ""),
      );
      if (!match && scope.paths.length && a.mode === "default") continue;
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
        (v) =>
          provided.some((p) => normalize(v) === normalize(p)) ||
          new RegExp(
            "(^|[^a-z0-9_])" +
              normalize(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
              "($|[^a-z0-9_])",
            "u",
          ).test(normalize(a.query)),
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
        content_hash: hash(tx.get(r.path)),
        ...(r.metadata.type === "incident"
          ? { boundaries: b, complete: !!b.applicability && !!b.invalid_when }
          : {}),
      });
    }
  }
  return result
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, a.limit);
}

export function eligible(
  r: MemoryRecord,
  mode: "default" | "review" | "history",
) {
  if (mode === "history") return true;
  if (mode === "review") return active(r);
  return active(r) && !["candidate", "proposed"].includes(r.metadata.status);
}
