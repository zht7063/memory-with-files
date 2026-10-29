import { invalid } from './errors.ts';
import { RECORD_TYPES, TASK_RE, type RecordType } from './paths.ts';

export const SCOPE_KEYS = [
  'paths',
  'file_types',
  'components',
  'tools',
  'operations',
  'phases',
  'keywords',
] as const;
export type ScopeKey = (typeof SCOPE_KEYS)[number];
export type Scope = Partial<Record<ScopeKey, string[]>>;

export const STATUSES = ['active', 'done'] as const;
export type Status = (typeof STATUSES)[number];

export const MAX_TITLE = 200;
export const MAX_BODY = 50_000;
const MAX_SCOPE_ITEMS = 30;
const MAX_SCOPE_ITEM_LEN = 200;

export interface RecordDoc {
  id: string;
  type: RecordType;
  title: string;
  status: Status;
  scope: Scope;
  created: string;
  updated: string;
  /** Unknown / extension frontmatter lines (raw `key: value`), preserved on rewrite. */
  extra: Array<[string, string]>;
  body: string;
}

export interface HandoffDoc {
  task: string;
  status: Status;
  version: number;
  updated: string;
  summary: string;
  extra: Array<[string, string]>;
  body: string;
}

/** Entry moved to trash: the original record plus trash metadata (all in one atomic file). */
export interface TrashDoc {
  record: RecordDoc;
  trashedAt: number;
  origin: string;
  reason: string;
}

// ---- frontmatter ----------------------------------------------------------------------------

export function splitFrontmatter(text: string): { fm: Array<[string, string]>; body: string } {
  const norm = text.replace(/\r\n/g, '\n');
  if (!norm.startsWith('---\n')) throw new Error('missing frontmatter');
  const end = norm.indexOf('\n---\n', 3);
  const endAtEof = norm.endsWith('\n---') ? norm.length - 4 : -1;
  const close = end >= 0 ? end : endAtEof;
  if (close < 0) throw new Error('unterminated frontmatter');
  const head = norm.slice(4, close + 1);
  const body = end >= 0 ? norm.slice(end + 5) : '';
  const fm: Array<[string, string]> = [];
  for (const line of head.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]?(.*)$/.exec(line);
    if (!match) throw new Error(`bad frontmatter line: ${line.slice(0, 60)}`);
    fm.push([match[1] as string, match[2] as string]);
  }
  return { fm, body: body.replace(/^\n/, '') };
}

function parseValue(raw: string): unknown {
  const value = raw.trim();
  if (value === '') return '';
  if (/^["[{]/.test(value)) return JSON.parse(value) as unknown;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function emit(pairs: Array<[string, string]>, body: string): string {
  const head = pairs.map(([key, value]) => `${key}: ${value}`).join('\n');
  const trimmed = body.replace(/^\n+/, '').replace(/\s+$/, '');
  return `---\n${head}\n---\n\n${trimmed}\n`;
}

// ---- scope ----------------------------------------------------------------------------------

export function normalizeScope(input: unknown): Scope {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw invalid('scope must be an object');
  const out: Scope = {};
  for (const key of Object.keys(input)) {
    if (!(SCOPE_KEYS as readonly string[]).includes(key))
      throw invalid(`unknown scope key: ${key}`);
    const raw = (input as Record<string, unknown>)[key];
    const list = typeof raw === 'string' ? [raw] : raw;
    if (!Array.isArray(list)) throw invalid(`scope.${key} must be a string array`);
    const items: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string') throw invalid(`scope.${key} must contain strings`);
      const trimmed = item.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_SCOPE_ITEM_LEN || /[\r\n]/.test(trimmed)) {
        throw invalid(`scope.${key} item is too long or multi-line`);
      }
      if (!items.includes(trimmed)) items.push(trimmed);
    }
    if (items.length > MAX_SCOPE_ITEMS)
      throw invalid(`scope.${key} has more than ${MAX_SCOPE_ITEMS} items`);
    if (items.length) out[key as ScopeKey] = items;
  }
  return out;
}

export function mergeScopes(a: Scope, b: Scope): Scope {
  const out: Scope = {};
  for (const key of SCOPE_KEYS) {
    const merged = [...(a[key] ?? [])];
    for (const item of b[key] ?? []) if (!merged.includes(item)) merged.push(item);
    if (merged.length) out[key] = merged.slice(0, MAX_SCOPE_ITEMS);
  }
  return out;
}

function canonicalScope(scope: Scope): Scope {
  const out: Scope = {};
  for (const key of SCOPE_KEYS) if (scope[key]?.length) out[key] = scope[key];
  return out;
}

export function scopeText(scope: Scope): string {
  return SCOPE_KEYS.flatMap((key) => scope[key] ?? []).join(' ');
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function pathMatches(pattern: string, query: string): boolean {
  const p = pattern.replace(/^\.\//, '');
  const q = query.replace(/^\.\//, '');
  if (p === q) return true;
  if (/[*?]/.test(p) && globToRegExp(p).test(q)) return true;
  if (/[*?]/.test(q) && globToRegExp(q).test(p)) return true;
  const dir = p.endsWith('/') ? p : `${p}/`;
  return q.startsWith(dir) || p.startsWith(q.endsWith('/') ? q : `${q}/`);
}

/**
 * Scope filtering rule: for every dimension present in the query, a record matches when it has no
 * entries for that dimension (general) or at least one entry matches. `hits` counts explicit
 * matches and is used to rank scoped records above general ones.
 */
export function scopeMatch(record: Scope, query: Scope): { ok: boolean; hits: number } {
  let hits = 0;
  for (const key of SCOPE_KEYS) {
    const wanted = query[key];
    if (!wanted?.length) continue;
    const have = record[key];
    if (!have?.length) continue;
    const matched = have.some((item) =>
      wanted.some((w) =>
        key === 'paths' ? pathMatches(item, w) : item.toLowerCase() === w.toLowerCase(),
      ),
    );
    if (!matched) return { ok: false, hits: 0 };
    hits++;
  }
  return { ok: true, hits };
}

// ---- records --------------------------------------------------------------------------------

export function validateTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim()) throw invalid('title is required');
  const t = title.trim();
  if (t.length > MAX_TITLE || /[\r\n]/.test(t))
    throw invalid('title must be a single line ≤ 200 chars');
  return t;
}

export function validateBody(body: unknown): string {
  if (typeof body !== 'string') throw invalid('body must be a string');
  if (body.length > MAX_BODY) throw invalid(`body exceeds ${MAX_BODY} characters`);
  return body;
}

export function validateStatus(status: unknown): Status {
  if (status !== 'active' && status !== 'done') throw invalid("status must be 'active' or 'done'");
  return status;
}

export function validateType(type: unknown): RecordType {
  if (typeof type !== 'string' || !(RECORD_TYPES as readonly string[]).includes(type)) {
    throw invalid(`type must be one of ${RECORD_TYPES.join(', ')}`);
  }
  return type as RecordType;
}

export function validateTask(task: unknown): string {
  if (typeof task !== 'string' || !TASK_RE.test(task) || task.endsWith('.')) {
    throw invalid('task must be 1-80 chars of letters, digits, ".", "_" or "-" (no slashes)');
  }
  return task;
}

const RECORD_KEYS = ['id', 'type', 'title', 'status', 'scope', 'created', 'updated'];
const TRASH_KEYS = ['trashed_at', 'trash_origin', 'trash_reason'];

function fmMap(fm: Array<[string, string]>): Map<string, string> {
  return new Map(fm);
}

export function serializeRecord(doc: RecordDoc, trash?: Omit<TrashDoc, 'record'>): string {
  const pairs: Array<[string, string]> = [
    ['id', doc.id],
    ['type', doc.type],
    ['title', JSON.stringify(doc.title)],
    ['status', doc.status],
    ['scope', JSON.stringify(canonicalScope(doc.scope))],
    ['created', doc.created],
    ['updated', doc.updated],
  ];
  for (const [key, value] of doc.extra) pairs.push([key, value]);
  if (trash) {
    pairs.push(['trashed_at', String(trash.trashedAt)]);
    pairs.push(['trash_origin', JSON.stringify(trash.origin)]);
    pairs.push(['trash_reason', JSON.stringify(trash.reason)]);
  }
  return emit(pairs, doc.body);
}

export function parseRecord(text: string, fallbackId?: string): RecordDoc {
  const { fm, body } = splitFrontmatter(text);
  const map = fmMap(fm);
  const get = (key: string): unknown =>
    map.has(key) ? parseValue(map.get(key) as string) : undefined;
  const id = (get('id') as string | undefined) ?? fallbackId;
  if (typeof id !== 'string' || !id) throw new Error('missing id');
  const type = validateTypeSoft(get('type'));
  const titleRaw = get('title');
  const title =
    typeof titleRaw === 'string' && titleRaw.trim()
      ? (titleRaw.trim().split('\n')[0] as string)
      : firstLine(body) || id;
  const statusRaw = get('status') ?? 'active';
  if (statusRaw !== 'active' && statusRaw !== 'done')
    throw new Error(`bad status: ${String(statusRaw)}`);
  const scopeRaw = get('scope');
  let scope: Scope;
  try {
    scope = normalizeScope(scopeRaw === '' ? undefined : scopeRaw);
  } catch (error) {
    throw new Error(`bad scope: ${(error as Error).message}`);
  }
  const created = String(get('created') ?? '');
  const updated = String(get('updated') ?? created);
  const extra = fm.filter(([key]) => !RECORD_KEYS.includes(key) && !TRASH_KEYS.includes(key));
  return {
    id,
    type,
    title,
    status: statusRaw,
    scope,
    created,
    updated,
    extra,
    body: body.replace(/\s+$/, ''),
  };
}

function validateTypeSoft(type: unknown): RecordType {
  if (typeof type !== 'string' || !(RECORD_TYPES as readonly string[]).includes(type)) {
    throw new Error(`bad type: ${String(type)}`);
  }
  return type as RecordType;
}

function firstLine(body: string): string {
  return (body.split('\n').find((line) => line.trim()) ?? '')
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, MAX_TITLE);
}

export function parseTrash(text: string, fallbackId?: string): TrashDoc {
  const record = parseRecord(text, fallbackId);
  const { fm } = splitFrontmatter(text);
  const map = fmMap(fm);
  const trashedAt = Number(map.get('trashed_at'));
  if (!Number.isFinite(trashedAt)) throw new Error('missing trashed_at');
  const origin = parseValue(map.get('trash_origin') ?? '""');
  const reason = parseValue(map.get('trash_reason') ?? '""');
  return { record, trashedAt, origin: String(origin), reason: String(reason) };
}

// ---- handoff --------------------------------------------------------------------------------

export function serializeHandoff(doc: HandoffDoc): string {
  const pairs: Array<[string, string]> = [
    ['task', JSON.stringify(doc.task)],
    ['status', doc.status],
    ['version', String(doc.version)],
    ['updated', doc.updated],
    ['summary', JSON.stringify(doc.summary)],
    ...doc.extra,
  ];
  return emit(pairs, doc.body);
}

export function parseHandoff(text: string, task: string): HandoffDoc {
  const { fm, body } = splitFrontmatter(text);
  const map = fmMap(fm);
  const get = (key: string): unknown =>
    map.has(key) ? parseValue(map.get(key) as string) : undefined;
  const status = get('status') ?? 'active';
  if (status !== 'active' && status !== 'done') throw new Error(`bad status: ${String(status)}`);
  const version = Number(get('version') ?? 1);
  if (!Number.isInteger(version) || version < 1) throw new Error('bad version');
  const extra = fm.filter(
    ([key]) => !['task', 'status', 'version', 'updated', 'summary'].includes(key),
  );
  return {
    task,
    status,
    version,
    updated: String(get('updated') ?? ''),
    summary: String(get('summary') ?? ''),
    extra,
    body: body.replace(/\s+$/, ''),
  };
}
