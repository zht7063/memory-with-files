import { requireInitialized, type Ctx, type WriteInput } from './context.ts';
import { invalid, MwfError } from './errors.ts';
import { ID_RE, TYPE_PREFIX, recordRelPath, typeOfId, type RecordType } from './paths.ts';
import { parseInbox, serializeInbox } from './inbox.ts';
import {
  normalizeScope,
  parseRecord,
  serializeRecord,
  validateBody,
  validateStatus,
  validateTitle,
  validateType,
  type RecordDoc,
  type Scope,
  type Status,
} from './records.ts';
import { readFileText, runWrite } from './write.ts';
import { isoTime, sha256, token } from './util.ts';
import { listNodes } from './db.ts';

export function newRecordId(type: RecordType, requestId: string, attempt = 0): string {
  return `${TYPE_PREFIX[type]}_${token(`${requestId}:${type}:${attempt}`, 10)}`;
}

export interface RecordView {
  id: string;
  type: RecordType;
  title: string;
  status: Status;
  scope: Scope;
  created: string;
  updated: string;
  body: string;
  /** Content hash of the whole file; pass as expected_hash to edit. */
  hash: string;
  path: string;
}

function view(doc: RecordDoc, hash: string, path: string): RecordView {
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    status: doc.status,
    scope: doc.scope,
    created: doc.created,
    updated: doc.updated,
    body: doc.body,
    hash,
    path: `.mwf/${path}`,
  };
}

function checkId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw invalid('invalid record id');
  return id;
}

/** get: full record by id (reads the record file itself, never the index). */
export function get(ctx: Ctx, input: { id: string }): RecordView {
  const layout = requireInitialized(ctx);
  const id = checkId(input.id);
  const type = typeOfId(id) as RecordType;
  const rel = recordRelPath(type, id);
  const text = readFileText(layout, rel);
  if (text === null) throw new MwfError('NOT_FOUND', `record ${id} not found`, { id });
  let doc: RecordDoc;
  try {
    doc = parseRecord(text, id);
  } catch (error) {
    throw invalid(`record ${id} is malformed: ${(error as Error).message}`);
  }
  return view(doc, sha256(Buffer.from(text, 'utf8')), rel);
}

export interface AddInput extends WriteInput {
  type: RecordType;
  title: string;
  body: string;
  scope?: Scope;
  status?: Status;
}

export interface AddResult {
  id: string;
  type: RecordType;
  title: string;
  path: string;
  hash: string;
  /** Active records of the same type with the same normalised title (possible duplicates). */
  similar: string[];
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** add: write a confirmed long-term memory record. The id is derived from the request_id. */
export async function add(
  ctx: Ctx,
  input: AddInput,
): Promise<AddResult & { request_id: string; deduped: boolean }> {
  const type = validateType(input.type);
  const title = validateTitle(input.title);
  const body = validateBody(input.body);
  const scope = normalizeScope(input.scope);
  const status = input.status === undefined ? 'active' : validateStatus(input.status);
  return runWrite<AddResult>(ctx, 'add', input, { type, title, body, scope, status }, (env) => {
    const id = newRecordId(type, env.requestId);
    const rel = recordRelPath(type, id);
    const existingText = readFileText(env.layout, rel);
    const similar = listNodes(env.db, { kind: 'record', status: 'active', types: [type] })
      .filter((n) => norm(n.title) === norm(title) && n.id !== id)
      .map((n) => n.id);
    if (existingText !== null) {
      // Re-execution after an interrupted attempt: accept only if it is the same record.
      const prior = parseRecord(existingText, id);
      if (prior.title === title && prior.body === body.replace(/\s+$/, '') && prior.type === type) {
        return {
          targets: [],
          result: {
            id,
            type,
            title,
            path: `.mwf/${rel}`,
            hash: sha256(Buffer.from(existingText, 'utf8')),
            similar,
          },
        };
      }
      throw new MwfError(
        'ID_COLLISION',
        `record file ${rel} already exists with different content`,
        { id },
      );
    }
    const stamp = isoTime(env.now);
    const doc: RecordDoc = {
      id,
      type,
      title,
      status,
      scope,
      created: stamp,
      updated: stamp,
      extra: [],
      body,
    };
    const content = serializeRecord(doc);
    return {
      targets: [{ path: rel, content }],
      result: { id, type, title, path: `.mwf/${rel}`, hash: sha256(content), similar },
    };
  });
}

export interface EditInput extends WriteInput {
  id: string;
  /** Hash from get/recall. The edit is rejected if the file has changed since. */
  expected_hash: string;
  title?: string;
  body?: string;
  status?: Status;
  scope?: Scope;
}

export interface EditResult {
  id: string;
  changed: boolean;
  hash: string;
  previous_hash: string;
}

/**
 * edit: change title / body / status / scope. Not destructive by decision (pending yubai): guarded
 * only by the content-hash precondition, checked again inside the lock.
 */
export async function edit(
  ctx: Ctx,
  input: EditInput,
): Promise<EditResult & { request_id: string; deduped: boolean }> {
  const id = checkId(input.id);
  if (typeof input.expected_hash !== 'string' || !/^[0-9a-f]{64}$/.test(input.expected_hash)) {
    throw invalid('expected_hash is required (hash from get/recall)');
  }
  const patch = {
    title: input.title === undefined ? undefined : validateTitle(input.title),
    body: input.body === undefined ? undefined : validateBody(input.body),
    status: input.status === undefined ? undefined : validateStatus(input.status),
    scope: input.scope === undefined ? undefined : normalizeScope(input.scope),
  };
  const type = typeOfId(id) as RecordType;
  const rel = recordRelPath(type, id);
  return runWrite<EditResult>(
    ctx,
    'edit',
    input,
    { id, expected: input.expected_hash, patch },
    (env) => {
      const text = readFileText(env.layout, rel);
      if (text === null) throw new MwfError('NOT_FOUND', `record ${id} not found`, { id });
      const current = sha256(Buffer.from(text, 'utf8'));
      if (current !== input.expected_hash) {
        throw new MwfError('HASH_MISMATCH', `record ${id} changed since it was read`, {
          id,
          expected_hash: input.expected_hash,
          current_hash: current,
        });
      }
      const doc = parseRecord(text, id);
      const next: RecordDoc = {
        ...doc,
        title: patch.title ?? doc.title,
        body: patch.body ?? doc.body,
        status: patch.status ?? doc.status,
        scope: patch.scope ?? doc.scope,
      };
      const unchanged =
        next.title === doc.title &&
        next.body === doc.body &&
        next.status === doc.status &&
        JSON.stringify(next.scope) === JSON.stringify(doc.scope);
      if (unchanged)
        return {
          targets: [],
          result: { id, changed: false, hash: current, previous_hash: current },
        };
      next.updated = isoTime(env.now);
      const content = serializeRecord(next);
      return {
        targets: [{ path: rel, content }],
        result: { id, changed: true, hash: sha256(content), previous_hash: current },
      };
    },
  );
}

export interface ProposeInput extends WriteInput {
  text: string;
  /** Free-form origin label, e.g. "agent", "user". */
  source?: string;
}

export interface ProposeResult {
  entry_id: string;
  inbox_entries: number;
}

/** propose: append an uncertain item to inbox.md (with user-submitted items, awaiting tidy). */
export async function propose(
  ctx: Ctx,
  input: ProposeInput,
): Promise<ProposeResult & { request_id: string; deduped: boolean }> {
  if (typeof input.text !== 'string' || !input.text.trim()) throw invalid('text is required');
  if (input.text.length > 10_000) throw invalid('text exceeds 10000 characters');
  const source = (input.source ?? 'agent').trim();
  if (!/^[\w .:@/-]{1,40}$/.test(source)) throw invalid('invalid source label');
  const text = input.text.replace(/\r\n/g, '\n').trim();
  return runWrite<ProposeResult>(ctx, 'propose', input, { text, source }, (env) => {
    const entryId = `ib_${token(`${env.requestId}:inbox`, 10)}`;
    const parsed = parseInbox(readFileText(env.layout, 'inbox.md'));
    if (parsed.entries.some((e) => e.id === entryId)) {
      return { targets: [], result: { entry_id: entryId, inbox_entries: parsed.entries.length } };
    }
    parsed.entries.push({ id: entryId, at: isoTime(env.now), source, text });
    return {
      targets: [{ path: 'inbox.md', content: serializeInbox(parsed.preface, parsed.entries) }],
      result: { entry_id: entryId, inbox_entries: parsed.entries.length },
    };
  });
}
