import { beat } from './lock.ts';
import { requireInitialized, nowOf, type Ctx, type WriteInput } from './context.ts';
import { listTrash, type TrashRow } from './db.ts';
import { invalid, MwfError } from './errors.ts';
import { buildIndexMd } from './indexmd.ts';
import { INBOX_HEADER, parseInbox, serializeInbox } from './inbox.ts';
import { loadAll, type LoadedRecord, type LoadedTrash, type Loaded } from './load.ts';
import { newRecordId } from './ops.ts';
import {
  ID_RE,
  INBOX_ID_RE,
  TRASH_ID_RE,
  TRASH_RETENTION_DAYS,
  recordRelPath,
  type RecordType,
} from './paths.ts';
import {
  mergeScopes,
  normalizeScope,
  serializeRecord,
  validateBody,
  validateTitle,
  validateType,
  type RecordDoc,
  type Scope,
} from './records.ts';
import {
  readFileText,
  runWrite,
  withIndexRead,
  type Plan,
  type Target,
  type WriteEnv,
} from './write.ts';
import { canonicalJson, DAY_MS, isoTime, oneLine, sha256 } from './util.ts';

// ---- preview / confirm protocol -------------------------------------------------------------

export interface DestructiveInput extends WriteInput {
  /** Execute. Requires preview_token from a preview of the same operation. */
  confirm?: boolean;
  preview_token?: string;
}

export interface Preview<A> {
  preview: true;
  op: string;
  affected: A[];
  /** Hash of the affected objects' content; pass back with confirm: true to execute. */
  preview_token: string;
  note: string;
}

const PREVIEW_NOTE =
  '仅预览，未改动任何文件。向用户说明数量、标题、类型与原因并获得同意后，带 confirm: true 与 preview_token 重新调用。';

export function previewToken(op: string, objects: unknown): string {
  return sha256(canonicalJson({ op, objects })).slice(0, 32);
}

function executeToken(input: DestructiveInput): string | null {
  if (!input.confirm) return null;
  if (typeof input.preview_token !== 'string' || !input.preview_token) {
    throw new MwfError(
      'CONFIRM_REQUIRES_TOKEN',
      'confirm requires the preview_token returned by a preview',
      {},
    );
  }
  return input.preview_token;
}

function checkToken(supplied: string, current: string): void {
  if (supplied !== current) {
    throw new MwfError(
      'PREVIEW_MISMATCH',
      'preview_token does not match the current content of the affected objects; preview again',
      {},
    );
  }
}

function preview<A>(op: string, affected: A[], tokenObjects: unknown): Preview<A> {
  return {
    preview: true,
    op,
    affected,
    preview_token: previewToken(op, tokenObjects),
    note: PREVIEW_NOTE,
  };
}

type Done<R> = R & { preview: false; request_id: string; deduped: boolean };

async function destructive<A, R extends object>(
  ctx: Ctx,
  op: string,
  input: DestructiveInput,
  args: unknown,
  select: (env: { loaded: Loaded; now: number }) => { affected: A[]; tokenObjects: unknown },
  execute: (env: WriteEnv, loaded: Loaded, affected: A[]) => Plan<R>,
): Promise<Preview<A> | Done<R>> {
  const layout = requireInitialized(ctx);
  const supplied = executeToken(input);
  if (supplied === null) {
    const picked = select({ loaded: loadAll(layout), now: nowOf(ctx) });
    return preview(op, picked.affected, picked.tokenObjects);
  }
  const result = await runWrite<R & { preview: false }>(
    ctx,
    op,
    input,
    { ...(args as object), token: supplied },
    (env) => {
      const loaded = loadAll(env.layout);
      const picked = select({ loaded, now: env.now });
      checkToken(supplied, previewToken(op, picked.tokenObjects));
      const plan = execute(env, loaded, picked.affected);
      return { ...plan, result: { ...plan.result, preview: false as const } };
    },
  );
  return result as Done<R>;
}

// ---- forget ---------------------------------------------------------------------------------

export interface ForgetInput extends DestructiveInput {
  ids: string[];
  reason?: string;
}

export interface Affected {
  id: string;
  type: RecordType;
  title: string;
  path: string;
  status: string;
  hash: string;
}

function affectedOf(r: LoadedRecord): Affected {
  return {
    id: r.doc.id,
    type: r.doc.type,
    title: r.doc.title,
    path: `.mwf/${r.path}`,
    status: r.doc.status,
    hash: r.hash,
  };
}

function trashEntry(
  rec: LoadedRecord,
  loaded: Loaded,
  now: number,
  reason: string,
): { target: Target | null; trashId: string } {
  const reuse = loaded.trash.find(
    (t) => t.doc.record.id === rec.doc.id && serializeRecord(t.doc.record) === rec.text,
  );
  if (reuse) return { target: null, trashId: reuse.trashId };
  const trashId = `${rec.doc.id}.${now}`;
  return {
    target: {
      path: `trash/${trashId}.md`,
      content: serializeRecord(rec.doc, { trashedAt: now, origin: rec.path, reason }),
    },
    trashId,
  };
}

/** forget: move records to trash (30-day retention). Preview by default. */
export async function forget(ctx: Ctx, input: ForgetInput) {
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 200) {
    throw invalid('ids must be a non-empty array (max 200)');
  }
  const ids = [...new Set(input.ids.map(String))].sort();
  if (!ids.every((id) => ID_RE.test(id))) throw invalid('invalid record id in ids');
  const reason = oneLine(input.reason ?? 'forget', 200);
  return destructive<Affected, { forgotten: Array<{ id: string; trash_id: string }> }>(
    ctx,
    'forget',
    input,
    { ids, reason },
    ({ loaded }) => {
      const recs = loaded.records.filter((r) => ids.includes(r.doc.id));
      const missing = ids.filter((id) => !recs.some((r) => r.doc.id === id));
      if (missing.length)
        throw new MwfError('NOT_FOUND', `records not found: ${missing.join(', ')}`, { missing });
      return {
        affected: recs.map(affectedOf),
        tokenObjects: recs.map((r) => ({ id: r.doc.id, hash: r.hash })),
      };
    },
    (env, loaded, affected) => {
      const targets: Target[] = [];
      const forgotten: Array<{ id: string; trash_id: string }> = [];
      for (const a of affected) {
        beat();
        const rec = loaded.records.find((r) => r.doc.id === a.id) as LoadedRecord;
        const { target, trashId } = trashEntry(rec, loaded, env.now, reason);
        if (target) targets.push(target);
        forgotten.push({ id: a.id, trash_id: trashId });
      }
      for (const a of affected)
        targets.push({
          path: (loaded.records.find((r) => r.doc.id === a.id) as LoadedRecord).path,
          content: null,
        });
      return { targets, result: { forgotten } };
    },
  );
}

// ---- restore --------------------------------------------------------------------------------

export interface TrashListItem {
  trash_id: string;
  id: string;
  type: RecordType;
  title: string;
  trashed_at: string;
  expires_at: string;
  age_days: number;
  expired: boolean;
  reason: string;
}

function trashItem(row: TrashRow, now: number): TrashListItem {
  return {
    trash_id: row.trash_id,
    id: row.id,
    type: row.type,
    title: row.title,
    trashed_at: isoTime(row.trashed_at),
    expires_at: isoTime(row.trashed_at + TRASH_RETENTION_DAYS * DAY_MS),
    age_days: Math.floor((now - row.trashed_at) / DAY_MS),
    expired: now - row.trashed_at >= TRASH_RETENTION_DAYS * DAY_MS,
    reason: row.reason,
  };
}

export interface RestoreInput extends WriteInput {
  /** Record id or trash_id. Omit to list the trash. */
  id?: string;
}

export interface RestoreResult {
  restored: boolean;
  id: string;
  trash_id: string;
  path: string;
  /** Present when the original path is occupied: nothing is overwritten. */
  conflict?: { path: string; existing_hash: string };
}

/** restore: list trash, or put a record back at its original path (never overwrites). */
export async function restore(
  ctx: Ctx,
  input: RestoreInput = {},
): Promise<
  | { entries: TrashListItem[]; warnings: string[] }
  | (RestoreResult & { request_id: string; deduped: boolean })
> {
  if (input.id === undefined) {
    const now = nowOf(ctx);
    return withIndexRead(ctx, ({ db, warnings }) => ({
      entries: listTrash(db).map((r) => trashItem(r, now)),
      warnings,
    }));
  }
  const id = input.id;
  if (!ID_RE.test(id) && !TRASH_ID_RE.test(id))
    throw invalid('id must be a record id or a trash_id');
  return runWrite<RestoreResult>(ctx, 'restore', input, { id }, (env) => {
    const loaded = loadAll(env.layout);
    const matches = loaded.trash
      .filter((t) => t.trashId === id || t.doc.record.id === id)
      .sort((a, b) => b.doc.trashedAt - a.doc.trashedAt);
    const entry = matches[0];
    if (!entry) throw new MwfError('NOT_FOUND', `nothing in trash matches ${id}`, { id });
    const rec = entry.doc.record;
    const rel = recordRelPath(rec.type, rec.id);
    const existing = loaded.records.find((r) => r.path === rel);
    const onDisk = readFileText(env.layout, rel);
    if (existing || onDisk !== null) {
      return {
        targets: [],
        result: {
          restored: false,
          id: rec.id,
          trash_id: entry.trashId,
          path: `.mwf/${rel}`,
          conflict: {
            path: `.mwf/${rel}`,
            existing_hash: existing?.hash ?? sha256(Buffer.from(onDisk ?? '', 'utf8')),
          },
        },
      };
    }
    return {
      targets: [
        { path: rel, content: serializeRecord(rec) },
        { path: entry.path, content: null },
      ],
      result: { restored: true, id: rec.id, trash_id: entry.trashId, path: `.mwf/${rel}` },
    };
  });
}

// ---- purge ----------------------------------------------------------------------------------

export interface PurgeInput extends DestructiveInput {
  /** Record ids or trash_ids. Omit to purge every expired (>= 30 days) entry. */
  ids?: string[];
}

export interface PurgeAffected {
  trash_id: string;
  id: string;
  type: RecordType;
  title: string;
  trashed_at: string;
  expired: boolean;
  hash: string;
}

/** purge: permanently delete trash entries. Preview by default; irreversible once confirmed. */
export async function purge(ctx: Ctx, input: PurgeInput = {}) {
  const ids = input.ids === undefined ? null : [...new Set(input.ids.map(String))].sort();
  if (ids && (!ids.length || !ids.every((id) => ID_RE.test(id) || TRASH_ID_RE.test(id)))) {
    throw invalid('ids must be record ids or trash_ids');
  }
  return destructive<PurgeAffected, { purged: string[] }>(
    ctx,
    'purge',
    input,
    { ids },
    ({ loaded, now }) => {
      const pick = (t: LoadedTrash): boolean =>
        ids
          ? ids.includes(t.trashId) || ids.includes(t.doc.record.id)
          : now - t.doc.trashedAt >= TRASH_RETENTION_DAYS * DAY_MS;
      const picked = loaded.trash.filter(pick);
      const affected = picked.map((t) => ({
        trash_id: t.trashId,
        id: t.doc.record.id,
        type: t.doc.record.type,
        title: t.doc.record.title,
        trashed_at: isoTime(t.doc.trashedAt),
        expired: now - t.doc.trashedAt >= TRASH_RETENTION_DAYS * DAY_MS,
        hash: t.hash,
      }));
      return {
        affected,
        tokenObjects: affected.map((a) => ({ trash_id: a.trash_id, hash: a.hash })),
      };
    },
    (_env, loaded, affected) => ({
      targets: affected.map((a) => ({
        path: (loaded.trash.find((t) => t.trashId === a.trash_id) as LoadedTrash).path,
        content: null,
      })),
      result: { purged: affected.map((a) => a.trash_id) },
    }),
  );
}

// ---- compact --------------------------------------------------------------------------------

export interface CompactInput extends DestructiveInput {
  types?: RecordType[];
}

export interface CompactGroup {
  keep: string;
  merge: string[];
  type: RecordType;
  title: string;
  titles?: string[];
  hashes: Record<string, string>;
}

const normText = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * compact: find exact duplicates (same type, title and body, active) and merge each group into its
 * oldest record (scopes are unioned); the others go to trash. Same-title records with different
 * bodies are only reported (`similar`), never merged automatically.
 */
export async function compact(ctx: Ctx, input: CompactInput = {}) {
  const types = input.types?.map(validateType);
  const select = ({
    loaded,
  }: {
    loaded: Loaded;
  }): { affected: CompactGroup[]; tokenObjects: unknown } => {
    const groups = new Map<string, LoadedRecord[]>();
    for (const r of loaded.records) {
      if (r.doc.status !== 'active' || (types && !types.includes(r.doc.type))) continue;
      const key = `${r.doc.type}\u0000${normText(r.doc.title)}\u0000${normText(r.doc.body)}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const affected: CompactGroup[] = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      members.sort(
        (a, b) => a.doc.created.localeCompare(b.doc.created) || a.doc.id.localeCompare(b.doc.id),
      );
      const [keep, ...rest] = members as [LoadedRecord, ...LoadedRecord[]];
      affected.push({
        keep: keep.doc.id,
        merge: rest.map((r) => r.doc.id),
        type: keep.doc.type,
        title: keep.doc.title,
        hashes: Object.fromEntries(members.map((m) => [m.doc.id, m.hash])),
      });
    }
    affected.sort((a, b) => a.keep.localeCompare(b.keep));
    // The token covers everything compact can destroy: the duplicates' full content, and the kept
    // record's identity/title/body/status. The kept record's *scope* is deliberately excluded: compact
    // only ever widens it (union), idempotently, so a retry after a crash that already merged some
    // scopes still matches the token that was previewed.
    const byId = new Map(loaded.records.map((r) => [r.doc.id, r]));
    const tokenObjects = affected.map((g) => {
      const keep = (byId.get(g.keep) as LoadedRecord).doc;
      return {
        keep: g.keep,
        keepContent: sha256(canonicalJson([keep.type, keep.title, keep.status, keep.body])),
        merge: g.merge.map((id) => ({ id, hash: g.hashes[id] })),
      };
    });
    return { affected, tokenObjects };
  };
  return destructive<CompactGroup, { merged_groups: number; trashed: string[] }>(
    ctx,
    'compact',
    input,
    { types },
    select,
    (env, loaded, groups) => {
      const targets: Target[] = [];
      const removals: Target[] = [];
      const keepWrites: Target[] = [];
      const trashed: string[] = [];
      for (const g of groups) {
        const keep = loaded.records.find((r) => r.doc.id === g.keep) as LoadedRecord;
        let scope: Scope = keep.doc.scope;
        for (const id of g.merge) {
          beat();
          const dup = loaded.records.find((r) => r.doc.id === id) as LoadedRecord;
          scope = mergeScopes(scope, dup.doc.scope);
          const { target } = trashEntry(dup, loaded, env.now, `compact: merged into ${g.keep}`);
          if (target) targets.push(target);
          removals.push({ path: dup.path, content: null });
          trashed.push(id);
        }
        if (JSON.stringify(scope) !== JSON.stringify(keep.doc.scope)) {
          const next: RecordDoc = { ...keep.doc, scope, updated: isoTime(env.now) };
          keepWrites.push({ path: keep.path, content: serializeRecord(next) });
        }
      }
      return {
        targets: [...targets, ...removals, ...keepWrites],
        result: { merged_groups: groups.length, trashed },
      };
    },
  );
}

/** Same-title, different-body candidates for manual review (read-only). */
export async function findSimilar(
  ctx: Ctx,
): Promise<Array<{ type: RecordType; title: string; ids: string[] }>> {
  const layout = requireInitialized(ctx);
  const loaded = loadAll(layout);
  const groups = new Map<string, LoadedRecord[]>();
  for (const r of loaded.records) {
    if (r.doc.status !== 'active') continue;
    const key = `${r.doc.type}\u0000${normText(r.doc.title)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1 && new Set(g.map((r) => normText(r.doc.body))).size > 1)
    .map((g) => ({
      type: g[0]!.doc.type,
      title: g[0]!.doc.title,
      ids: g.map((r) => r.doc.id).sort(),
    }));
}

// ---- inbox ----------------------------------------------------------------------------------

export type InboxInput =
  | { action?: 'list'; limit?: number }
  | ({
      action: 'accept';
      entry_id: string;
      type: RecordType;
      title: string;
      body?: string;
      scope?: Scope;
    } & WriteInput)
  | ({ action: 'discard'; entry_ids: string[] } & DestructiveInput);

export interface InboxView {
  entries: Array<{ id: string; at: string; source: string; text: string; truncated: boolean }>;
  total: number;
}

/** inbox: list pending entries, accept one as a record, or discard entries (preview/confirm). */
export async function inbox(ctx: Ctx, input: InboxInput = {}) {
  const layout = requireInitialized(ctx);
  if (input.action === undefined || input.action === 'list') {
    const limit = input.action === undefined && 'limit' in input && input.limit ? input.limit : 50;
    const parsed = parseInbox(readFileText(layout, 'inbox.md'));
    const view: InboxView = {
      total: parsed.entries.length,
      entries: parsed.entries.slice(0, limit).map((e) => ({
        id: e.id,
        at: e.at,
        source: e.source,
        text: oneLine(e.text, 2000),
        truncated: e.text.length > 2000,
      })),
    };
    return view;
  }
  if (input.action === 'accept') {
    if (!INBOX_ID_RE.test(input.entry_id)) throw invalid('invalid entry_id');
    const type = validateType(input.type);
    const title = validateTitle(input.title);
    const body = input.body === undefined ? undefined : validateBody(input.body);
    const scope = normalizeScope(input.scope);
    return runWrite<{ entry_id: string; id: string; path: string }>(
      ctx,
      'inbox.accept',
      input,
      { entry_id: input.entry_id, type, title, body, scope },
      (env) => {
        const parsed = parseInbox(readFileText(env.layout, 'inbox.md'));
        const entry = parsed.entries.find((e) => e.id === input.entry_id);
        const id = newRecordId(type, env.requestId);
        const rel = recordRelPath(type, id);
        if (!entry) {
          // already accepted by an earlier attempt of the same request
          if (readFileText(env.layout, rel) !== null) {
            return { targets: [], result: { entry_id: input.entry_id, id, path: `.mwf/${rel}` } };
          }
          throw new MwfError('NOT_FOUND', `inbox entry ${input.entry_id} not found`, {
            entry_id: input.entry_id,
          });
        }
        const stamp = isoTime(env.now);
        const doc: RecordDoc = {
          id,
          type,
          title,
          status: 'active',
          scope,
          created: stamp,
          updated: stamp,
          extra: [],
          body: body ?? entry.text,
        };
        const rest = parsed.entries.filter((e) => e.id !== entry.id);
        return {
          targets: [
            { path: rel, content: serializeRecord(doc) },
            { path: 'inbox.md', content: serializeInbox(parsed.preface || INBOX_HEADER, rest) },
          ],
          result: { entry_id: entry.id, id, path: `.mwf/${rel}` },
        };
      },
    );
  }
  if (input.action === 'discard') {
    const ids = [...new Set((input.entry_ids ?? []).map(String))].sort();
    if (!ids.length || !ids.every((id) => INBOX_ID_RE.test(id)))
      throw invalid('entry_ids must be inbox entry ids');
    return destructive<
      { id: string; at: string; source: string; text: string },
      { discarded: string[] }
    >(
      ctx,
      'inbox.discard',
      input,
      { ids },
      () => {
        const parsed = parseInbox(readFileText(layout, 'inbox.md'));
        const picked = parsed.entries.filter((e) => ids.includes(e.id));
        const missing = ids.filter((id) => !picked.some((e) => e.id === id));
        if (missing.length)
          throw new MwfError('NOT_FOUND', `inbox entries not found: ${missing.join(', ')}`, {
            missing,
          });
        return {
          affected: picked.map((e) => ({
            id: e.id,
            at: e.at,
            source: e.source,
            text: oneLine(e.text, 300),
          })),
          tokenObjects: picked.map((e) => ({ id: e.id, hash: sha256(e.text) })),
        };
      },
      (env) => {
        const parsed = parseInbox(readFileText(env.layout, 'inbox.md'));
        const rest = parsed.entries.filter((e) => !ids.includes(e.id));
        return {
          targets: [{ path: 'inbox.md', content: serializeInbox(parsed.preface, rest) }],
          result: { discarded: ids },
        };
      },
    );
  }
  throw invalid("action must be 'list', 'accept' or 'discard'");
}

// ---- reindex --------------------------------------------------------------------------------

export interface ReindexResult {
  records: number;
  handoffs: number;
  trash: number;
  invalid: Array<{ path: string; error: string }>;
}

/** reindex: rebuild index.md and index.db from the record files (the files win). */
export async function reindex(ctx: Ctx, input: WriteInput = {}) {
  return runWrite<ReindexResult>(ctx, 'reindex', input, {}, (env) => {
    const loaded = loadAll(env.layout);
    return {
      rebuild: true,
      targets: [{ path: 'index.md', content: buildIndexMd(loaded) }],
      result: {
        records: loaded.records.length,
        handoffs: loaded.handoffs.length,
        trash: loaded.trash.length,
        invalid: loaded.invalid,
      },
    };
  });
}
