import { existsSync } from 'node:fs';
import TOML from '@iarna/toml';
import { requireInitialized, nowOf, type Ctx } from './context.ts';
import { bodyOf, listNodes, listTrash, searchNodes, type NodeRow, type TrashRow } from './db.ts';
import { invalid } from './errors.ts';
import { readTextIfExists } from './fsx.ts';
import { readHandoffFile, type HandoffListItem, type HandoffView } from './handoff.ts';
import { readConfig } from './init.ts';
import { parseInbox } from './inbox.ts';
import { inspectLock } from './lock.ts';
import { RECORD_TYPES, TRASH_NEAR_DAYS, TRASH_RETENTION_DAYS, type RecordType } from './paths.ts';
import {
  normalizeScope,
  SCOPE_KEYS,
  scopeMatch,
  validateType,
  type Scope,
  type Status,
} from './records.ts';
import { diffIndex, scanFiles } from './db.ts';
import { staleOf } from './context.ts';
import { withIndexRead } from './write.ts';
import { DAY_MS, oneLine } from './util.ts';

export interface TrashSummary {
  total: number;
  /** Entries at least 30 days old (eligible for purge). */
  expired: number;
  /** Entries at least 25 days old but not yet 30. */
  near: number;
  note: string | null;
}

export function trashSummary(rows: TrashRow[], now: number): TrashSummary {
  let expired = 0;
  let near = 0;
  for (const row of rows) {
    const age = (now - row.trashed_at) / DAY_MS;
    if (age >= TRASH_RETENTION_DAYS) expired++;
    else if (age >= TRASH_NEAR_DAYS) near++;
  }
  const parts: string[] = [];
  if (expired) parts.push(`${expired} 条已过期`);
  if (near) parts.push(`${near} 条临近过期（保留 ${TRASH_RETENTION_DAYS} 天）`);
  return {
    total: rows.length,
    expired,
    near,
    note: parts.length ? `回收区有 ${parts.join('、')}，可运行 /mwf tidy 清理` : null,
  };
}

// ---- bootstrap ------------------------------------------------------------------------------

export interface BootstrapInput {
  /** Max memory index entries listed (default 40). */
  max_entries?: number;
}

export interface BootstrapResult {
  version: string;
  git_mode: string;
  memory: {
    counts: Record<RecordType, number>;
    entries: Array<{ id: string; type: RecordType; title: string }>;
    truncated: boolean;
  };
  handoffs: {
    open: HandoffListItem[];
    /** Full text, only when exactly one handoff is open. */
    full: HandoffView | null;
  };
  trash: TrashSummary;
  inbox_pending: number;
  warnings: string[];
}

export async function bootstrap(ctx: Ctx, input: BootstrapInput = {}): Promise<BootstrapResult> {
  const max = clampInt(input.max_entries, 40, 1, 200, 'max_entries');
  const now = nowOf(ctx);
  const data = await withIndexRead(ctx, ({ db, layout, warnings }) => {
    const nodes = listNodes(db, { kind: 'record', status: 'active' });
    const handoffs = listNodes(db, { kind: 'handoff', status: 'active' });
    const trash = listTrash(db);
    const config = readConfig(readTextIfExists(layout.config));
    const inbox = parseInbox(readTextIfExists(layout.inbox));
    return { nodes, handoffs, trash, config, inbox: inbox.entries.length, warnings };
  });
  const counts = Object.fromEntries(RECORD_TYPES.map((t) => [t, 0])) as Record<RecordType, number>;
  for (const n of data.nodes) if (n.type) counts[n.type]++;
  const open = data.handoffs.map(toItem);
  const only = open.length === 1 ? (open[0] as HandoffListItem) : null;
  return {
    version: data.config?.mwf_version ?? '',
    git_mode: data.config?.git_mode ?? 'track',
    memory: {
      counts,
      entries: data.nodes
        .slice(0, max)
        .map((n) => ({ id: n.id, type: n.type as RecordType, title: n.title })),
      truncated: data.nodes.length > max,
    },
    handoffs: { open, full: only ? readHandoffFile(ctx, only.task) : null },
    trash: trashSummary(data.trash, now),
    inbox_pending: data.inbox,
    warnings: data.warnings,
  };
}

function toItem(n: NodeRow): HandoffListItem {
  return {
    task: n.id,
    status: n.status,
    version: n.version,
    updated: n.updated,
    summary: n.summary,
  };
}

// ---- recall ---------------------------------------------------------------------------------

export interface RecallInput {
  query?: string;
  scope?: Scope;
  types?: RecordType[];
  /** 'active' (default), 'done' or 'all'. */
  status?: Status | 'all';
  /** Read one handoff in full instead of searching. */
  task?: string;
  include_handoffs?: boolean;
  /** Max hits (default 8, max 50). */
  limit?: number;
  /** Output budget in characters across all hits (default 4000, max 20000). */
  max_chars?: number;
}

export interface RecallHit {
  kind: 'record' | 'handoff';
  id: string;
  type: RecordType | null;
  title: string;
  status: Status;
  snippet: string;
  scope: Scope;
  hash: string;
  updated: string;
}

export interface RecallResult {
  handoff?: HandoffView;
  hits: RecallHit[];
  total_matched: number;
  truncated: boolean;
  warnings: string[];
}

const MAX_TERMS = 40;

export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (t: string): void => {
    const key = t.toLowerCase();
    if (key && !seen.has(key) && terms.length < MAX_TERMS) {
      seen.add(key);
      terms.push(key);
    }
  };
  for (const run of query.match(/[\p{L}\p{N}_.-]+/gu) ?? []) {
    const chars = [...run];
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(run) && chars.length > 3) {
      for (let i = 0; i + 3 <= chars.length; i++) push(chars.slice(i, i + 3).join(''));
    } else push(run);
  }
  return terms;
}

function clampInt(
  v: number | undefined,
  def: number,
  min: number,
  max: number,
  name: string,
): number {
  if (v === undefined) return def;
  if (!Number.isInteger(v) || v < min || v > max)
    throw invalid(`${name} must be an integer in ${min}..${max}`);
  return v;
}

/** Candidates ranked per kind before the limit / max_chars budget is applied. */
const MAX_CANDIDATES = 200;
/** Effectively unbounded: used when a scope filter has to see every candidate first. */
const ALL_CANDIDATES = 1_000_000;

export async function recall(ctx: Ctx, input: RecallInput = {}): Promise<RecallResult> {
  if (input.task !== undefined) {
    return {
      handoff: readHandoffFile(ctx, input.task),
      hits: [],
      total_matched: 0,
      truncated: false,
      warnings: [],
    };
  }
  const limit = clampInt(input.limit, 8, 1, 50, 'limit');
  const maxChars = clampInt(input.max_chars, 4000, 200, 20000, 'max_chars');
  const scope = normalizeScope(input.scope);
  const types = input.types?.map(validateType);
  const status = input.status === undefined || input.status === 'active' ? 'active' : input.status;
  if (status !== 'active' && status !== 'done' && status !== 'all')
    throw invalid("status must be 'active', 'done' or 'all'");
  const statusFilter: Status | undefined = status === 'all' ? undefined : status;
  const terms = input.query ? queryTerms(input.query) : [];
  if (input.query !== undefined && typeof input.query !== 'string')
    throw invalid('query must be a string');

  return withIndexRead(ctx, ({ db, warnings }) => {
    const kinds: Array<'record' | 'handoff'> = input.include_handoffs
      ? ['record', 'handoff']
      : ['record'];
    type Scored = { node: NodeRow; rank: number; hits: number };
    const scored: Scored[] = [];
    // A scope query filters before anything is cut: fetch every candidate, keep the matching ones
    // and only then cap at MAX_CANDIDATES, so a match is never lost behind 200 non-matching hits.
    const scoped = SCOPE_KEYS.some((key) => scope[key]?.length);
    for (const kind of kinds) {
      const filter = { kind, status: statusFilter, types: kind === 'record' ? types : undefined };
      const fetchLimit = scoped ? ALL_CANDIDATES : MAX_CANDIDATES;
      const found = terms.length
        ? searchNodes(db, terms, filter, fetchLimit)
        : listNodes(db, filter)
            .slice(0, fetchLimit)
            .map((node, i) => ({ node, rank: i }));
      let kept = 0;
      for (const { node, rank } of found) {
        const m = scopeMatch(node.scope, scope);
        if (!m.ok) continue;
        if (kept++ >= MAX_CANDIDATES) break;
        scored.push({ node, rank, hits: m.hits });
      }
    }
    scored.sort(
      (a, b) => b.hits - a.hits || a.rank - b.rank || b.node.updated.localeCompare(a.node.updated),
    );
    const out: RecallHit[] = [];
    let used = 0;
    let truncated = false;
    for (const s of scored) {
      if (out.length >= limit) {
        truncated = true;
        break;
      }
      const snippet = oneLine(bodyOf(db, s.node.kind, s.node.id) || s.node.summary, 160);
      const cost = s.node.title.length + snippet.length + 80;
      if (out.length > 0 && used + cost > maxChars) {
        truncated = true;
        break;
      }
      used += cost;
      out.push({
        kind: s.node.kind,
        id: s.node.id,
        type: s.node.type,
        title: s.node.title,
        status: s.node.status,
        snippet,
        scope: s.node.scope,
        hash: s.node.hash,
        updated: s.node.updated,
      });
    }
    return { hits: out, total_matched: scored.length, truncated, warnings };
  });
}

// ---- status ---------------------------------------------------------------------------------

export interface StatusResult {
  initialized: true;
  version: string;
  git_mode: string;
  records: Record<RecordType, { active: number; done: number }>;
  handoffs: { open: number; done: number };
  inbox_pending: number;
  trash: TrashSummary;
  index: { in_sync: boolean; invalid_files: number };
  lock: {
    held: boolean;
    stale: boolean;
    foreign_host: boolean;
    holder_pid: number | null;
  };
  host: Record<string, Record<string, string>>;
  hints: string[];
  warnings: string[];
}

export function readHost(path: string): Record<string, Record<string, string>> {
  const text = readTextIfExists(path);
  if (!text) return {};
  try {
    const raw = TOML.parse(text) as { hosts?: Record<string, Record<string, unknown>> };
    const out: Record<string, Record<string, string>> = {};
    for (const [host, channels] of Object.entries(raw.hosts ?? {})) {
      out[host] = Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, String(v)]));
    }
    return out;
  } catch {
    return {};
  }
}

export async function status(ctx: Ctx): Promise<StatusResult> {
  const now = nowOf(ctx);
  const layout = requireInitialized(ctx);
  return withIndexRead(ctx, ({ db, warnings }) => {
    const records = Object.fromEntries(
      RECORD_TYPES.map((t) => [t, { active: 0, done: 0 }]),
    ) as StatusResult['records'];
    for (const n of listNodes(db, { kind: 'record' })) if (n.type) records[n.type][n.status]++;
    const handoffs = listNodes(db, { kind: 'handoff' });
    const trash = trashSummary(listTrash(db), now);
    const config = readConfig(readTextIfExists(layout.config));
    const inbox = parseInbox(readTextIfExists(layout.inbox)).entries.length;
    const diff = diffIndex(db, scanFiles(layout));
    const invalidFiles = (db.prepare('SELECT count(*) AS c FROM invalid').get() as { c: number }).c;
    const lock = inspectLock(layout, { staleMs: staleOf(ctx), now: ctx.now ?? Date.now });
    const hints: string[] = [];
    if (invalidFiles) hints.push(`${invalidFiles} 个记录文件无法解析，运行 doctor 查看`);
    if (inbox) hints.push(`inbox 有 ${inbox} 条待整理`);
    if (trash.note) hints.push(trash.note);
    if (lock.held && lock.foreign)
      hints.push('锁由其他主机（或其他 pid 命名空间）持有，仅按心跳超时回收，运行 doctor 查看');
    else if (lock.held && lock.stale) hints.push('锁持有者已不存在，下次写入会自动回收');
    if (!existsSync(layout.hostLocal)) hints.push('尚未确认宿主加载（host.local.toml 不存在）');
    return {
      initialized: true as const,
      version: config?.mwf_version ?? '',
      git_mode: config?.git_mode ?? 'track',
      records,
      handoffs: {
        open: handoffs.filter((h) => h.status === 'active').length,
        done: handoffs.filter((h) => h.status === 'done').length,
      },
      inbox_pending: inbox,
      trash,
      index: {
        in_sync: diff.changed.length === 0 && diff.removed.length === 0,
        invalid_files: invalidFiles,
      },
      lock: {
        held: lock.held,
        stale: lock.stale,
        foreign_host: lock.foreign,
        holder_pid: lock.holder?.pid ?? null,
      },
      host: readHost(layout.hostLocal),
      hints,
      warnings,
    };
  });
}
