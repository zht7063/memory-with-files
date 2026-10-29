import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  RECORD_TYPES,
  TRASH_ID_RE,
  TYPE_DIR,
  ID_RE,
  TASK_RE,
  type Layout,
  type RecordType,
} from './paths.ts';
import {
  parseHandoff,
  parseRecord,
  parseTrash,
  scopeText,
  type Scope,
  type Status,
} from './records.ts';
import { sha256 } from './util.ts';

export const SCHEMA_VERSION = 1;

export type Row = Record<string, string | number | bigint | null>;

export interface NodeRow {
  kind: 'record' | 'handoff';
  id: string;
  type: RecordType | null;
  title: string;
  status: Status;
  path: string;
  scope: Scope;
  summary: string;
  version: number;
  created: string;
  updated: string;
  hash: string;
}

export interface TrashRow {
  trash_id: string;
  id: string;
  type: RecordType;
  title: string;
  origin: string;
  trashed_at: number;
  reason: string;
  path: string;
  hash: string;
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (
  n INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  summary TEXT NOT NULL,
  version INTEGER NOT NULL,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  hash TEXT NOT NULL,
  mtime_ns TEXT NOT NULL,
  size INTEGER NOT NULL,
  UNIQUE (kind, id)
);
CREATE INDEX IF NOT EXISTS nodes_status ON nodes (kind, status, type);
CREATE TABLE IF NOT EXISTS trash (
  trash_id TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  origin TEXT NOT NULL,
  trashed_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  mtime_ns TEXT NOT NULL,
  size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invalid (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  mtime_ns TEXT NOT NULL,
  size INTEGER NOT NULL,
  error TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  kind UNINDEXED, id UNINDEXED, title, body, scope, tokenize = 'trigram'
);
`;

export interface OpenOptions {
  readOnly?: boolean;
}

export function dbExists(layout: Layout): boolean {
  return existsSync(layout.db);
}

function applySchema(db: DatabaseSync): void {
  db.exec(DDL);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
  } else if (row.value !== String(SCHEMA_VERSION)) {
    throw new Error(`index schema ${row.value} != ${SCHEMA_VERSION}`);
  }
}

function openRaw(layout: Layout, opts: OpenOptions): DatabaseSync {
  const db = new DatabaseSync(layout.db, { readOnly: opts.readOnly === true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (!opts.readOnly) {
      db.exec('PRAGMA journal_mode = WAL');
      applySchema(db);
    } else {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as
        | { value: string }
        | undefined;
      if (row?.value !== String(SCHEMA_VERSION)) throw new Error('index schema mismatch');
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Move an unusable index.db (corrupt, merge-conflicted, old schema) aside. Caller holds the lock. */
function quarantine(layout: Layout, now: number): void {
  const aside = `${layout.db}-corrupt-${now}`;
  try {
    renameSync(layout.db, aside);
  } catch {
    // ignore: will be overwritten below
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${layout.db}${suffix}`, { force: true });
}

/** Open (creating or rebuilding when unusable) the index for writing. Caller holds the lock. */
export function openIndex(layout: Layout, now: number): { db: DatabaseSync; recreated: boolean } {
  try {
    return { db: openRaw(layout, {}), recreated: !existsSync(layout.db) };
  } catch {
    quarantine(layout, now);
    return { db: openRaw(layout, {}), recreated: true };
  }
}

/** Open the index read-only; returns null when it is missing or unusable. */
export function openIndexReadOnly(layout: Layout): DatabaseSync | null {
  if (!existsSync(layout.db)) return null;
  try {
    return openRaw(layout, { readOnly: true });
  } catch {
    return null;
  }
}

export function checkpoint(db: DatabaseSync): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

// ---- file scanning --------------------------------------------------------------------------

export interface FileInfo {
  path: string; // relative to .mwf, posix
  abs: string;
  mtimeNs: string;
  size: number;
}

export function scanFiles(layout: Layout): FileInfo[] {
  const out: FileInfo[] = [];
  const add = (relDir: string): void => {
    const dir = join(layout.mwf, relDir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      const abs = join(dir, name);
      try {
        const st = statSync(abs, { bigint: true });
        if (!st.isFile()) continue;
        out.push({
          path: `${relDir}/${name}`,
          abs,
          mtimeNs: st.mtimeNs.toString(),
          size: Number(st.size),
        });
      } catch {
        // vanished between readdir and stat
      }
    }
  };
  for (const type of RECORD_TYPES) add(`memory/${TYPE_DIR[type]}`);
  add('handoff');
  add('trash');
  return out;
}

interface Known {
  table: 'nodes' | 'trash' | 'invalid';
  hash: string;
  mtime_ns: string;
  size: number;
}

function knownRows(db: DatabaseSync): Map<string, Known> {
  const map = new Map<string, Known>();
  for (const table of ['nodes', 'trash', 'invalid'] as const) {
    const rows = db
      .prepare(`SELECT path, hash, mtime_ns, size FROM ${table}`)
      .all() as unknown as Array<{
      path: string;
      hash: string;
      mtime_ns: string;
      size: number;
    }>;
    for (const row of rows) {
      map.set(row.path, { table, hash: row.hash, mtime_ns: row.mtime_ns, size: row.size });
    }
  }
  return map;
}

export interface IndexDiff {
  changed: FileInfo[];
  removed: string[];
}

export function diffIndex(db: DatabaseSync, files: FileInfo[]): IndexDiff {
  const known = knownRows(db);
  const changed: FileInfo[] = [];
  for (const file of files) {
    const row = known.get(file.path);
    if (!row || row.mtime_ns !== file.mtimeNs || row.size !== file.size) changed.push(file);
    known.delete(file.path);
  }
  return { changed, removed: [...known.keys()].sort() };
}

function removePath(db: DatabaseSync, path: string): void {
  const node = db.prepare('SELECT n FROM nodes WHERE path = ?').get(path) as
    | { n: number }
    | undefined;
  if (node) {
    db.prepare('DELETE FROM fts WHERE rowid = ?').run(node.n);
    db.prepare('DELETE FROM nodes WHERE n = ?').run(node.n);
  }
  db.prepare('DELETE FROM trash WHERE path = ?').run(path);
  db.prepare('DELETE FROM invalid WHERE path = ?').run(path);
}

function upsertNode(db: DatabaseSync, row: NodeRow, body: string, file: FileInfo): void {
  const existing = db
    .prepare('SELECT n FROM nodes WHERE kind = ? AND id = ?')
    .get(row.kind, row.id) as { n: number } | undefined;
  const scope = JSON.stringify(row.scope);
  let n: number;
  if (existing) {
    n = existing.n;
    db.prepare('DELETE FROM fts WHERE rowid = ?').run(n);
    db.prepare(
      `UPDATE nodes SET type=?, title=?, status=?, path=?, scope=?, summary=?, version=?, created=?,
       updated=?, hash=?, mtime_ns=?, size=? WHERE n=?`,
    ).run(
      row.type,
      row.title,
      row.status,
      row.path,
      scope,
      row.summary,
      row.version,
      row.created,
      row.updated,
      row.hash,
      file.mtimeNs,
      file.size,
      n,
    );
  } else {
    const res = db
      .prepare(
        `INSERT INTO nodes (kind, id, type, title, status, path, scope, summary, version, created,
         updated, hash, mtime_ns, size) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.kind,
        row.id,
        row.type,
        row.title,
        row.status,
        row.path,
        scope,
        row.summary,
        row.version,
        row.created,
        row.updated,
        row.hash,
        file.mtimeNs,
        file.size,
      );
    n = Number(res.lastInsertRowid);
  }
  db.prepare('INSERT INTO fts (rowid, kind, id, title, body, scope) VALUES (?,?,?,?,?,?)').run(
    n,
    row.kind,
    row.id,
    row.title,
    body,
    scopeText(row.scope),
  );
}

function markInvalid(db: DatabaseSync, file: FileInfo, hash: string, error: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO invalid (path, hash, mtime_ns, size, error) VALUES (?,?,?,?,?)',
  ).run(file.path, hash, file.mtimeNs, file.size, error.slice(0, 300));
}

/** (Re)index one file from its bytes; the file always wins over whatever the index held. */
export function indexFile(db: DatabaseSync, file: FileInfo): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file.abs);
  } catch {
    removePath(db, file.path);
    return;
  }
  const hash = sha256(bytes);
  const known = (['nodes', 'trash', 'invalid'] as const)
    .map(
      (table) =>
        db.prepare(`SELECT hash FROM ${table} WHERE path = ?`).get(file.path) as
          | { hash: string }
          | undefined,
    )
    .find(Boolean);
  if (known?.hash === hash) {
    for (const table of ['nodes', 'trash', 'invalid'] as const) {
      db.prepare(`UPDATE ${table} SET mtime_ns = ?, size = ? WHERE path = ?`).run(
        file.mtimeNs,
        file.size,
        file.path,
      );
    }
    return;
  }
  removePath(db, file.path);
  const text = bytes.toString('utf8');
  const stem = file.path.slice(file.path.lastIndexOf('/') + 1, -3);
  try {
    if (file.path.startsWith('memory/')) {
      const doc = parseRecord(text, stem);
      if (!ID_RE.test(doc.id) || doc.id !== stem)
        throw new Error(`id ${doc.id} does not match file name`);
      if (file.path !== `memory/${TYPE_DIR[doc.type]}/${doc.id}.md`)
        throw new Error('type does not match directory');
      upsertNode(
        db,
        {
          kind: 'record',
          id: doc.id,
          type: doc.type,
          title: doc.title,
          status: doc.status,
          path: file.path,
          scope: doc.scope,
          summary: '',
          version: 0,
          created: doc.created,
          updated: doc.updated,
          hash,
        },
        doc.body,
        file,
      );
    } else if (file.path.startsWith('handoff/')) {
      if (!TASK_RE.test(stem)) throw new Error('invalid task name');
      const doc = parseHandoff(text, stem);
      upsertNode(
        db,
        {
          kind: 'handoff',
          id: stem,
          type: null,
          title: stem,
          status: doc.status,
          path: file.path,
          scope: {},
          summary: doc.summary,
          version: doc.version,
          created: doc.updated,
          updated: doc.updated,
          hash,
        },
        doc.body,
        file,
      );
    } else if (file.path.startsWith('trash/')) {
      if (!TRASH_ID_RE.test(stem)) throw new Error('invalid trash entry name');
      const doc = parseTrash(text);
      db.prepare(
        `INSERT INTO trash (trash_id, id, type, title, origin, trashed_at, reason, path, hash, mtime_ns, size)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        stem,
        doc.record.id,
        doc.record.type,
        doc.record.title,
        doc.origin,
        doc.trashedAt,
        doc.reason,
        file.path,
        hash,
        file.mtimeNs,
        file.size,
      );
    }
  } catch (error) {
    removePath(db, file.path);
    markInvalid(db, file, hash, (error as Error).message);
  }
}

export interface SyncResult {
  updated: number;
  removed: number;
}

/** Bring the index in line with the files on disk (files win). Caller holds the write lock. */
export function syncIndex(db: DatabaseSync, layout: Layout, diff?: IndexDiff): SyncResult {
  const d = diff ?? diffIndex(db, scanFiles(layout));
  if (!d.changed.length && !d.removed.length) return { updated: 0, removed: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const path of d.removed) removePath(db, path);
    for (const file of d.changed) indexFile(db, file);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { updated: d.changed.length, removed: d.removed.length };
}

/** Drop every derived row and rebuild from the files. Caller holds the write lock. */
export function rebuildIndex(db: DatabaseSync, layout: Layout): SyncResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM nodes; DELETE FROM trash; DELETE FROM invalid; DELETE FROM fts;');
    const files = scanFiles(layout);
    for (const file of files) indexFile(db, file);
    db.exec('COMMIT');
    return { updated: files.length, removed: 0 };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ---- queries --------------------------------------------------------------------------------

function toNode(row: Row): NodeRow {
  return {
    kind: row['kind'] as 'record' | 'handoff',
    id: row['id'] as string,
    type: row['type'] as RecordType | null,
    title: row['title'] as string,
    status: row['status'] as Status,
    path: row['path'] as string,
    scope: JSON.parse(row['scope'] as string) as Scope,
    summary: row['summary'] as string,
    version: Number(row['version']),
    created: row['created'] as string,
    updated: row['updated'] as string,
    hash: row['hash'] as string,
  };
}

export function listNodes(
  db: DatabaseSync,
  filter: {
    kind: 'record' | 'handoff';
    status?: Status | undefined;
    types?: RecordType[] | undefined;
  },
): NodeRow[] {
  const where = ['kind = ?'];
  const params: Array<string> = [filter.kind];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.types?.length) {
    where.push(`type IN (${filter.types.map(() => '?').join(',')})`);
    params.push(...filter.types);
  }
  const rows = db
    .prepare(`SELECT * FROM nodes WHERE ${where.join(' AND ')} ORDER BY updated DESC, id ASC`)
    .all(...params) as unknown as Row[];
  return rows.map(toNode);
}

export function getNode(db: DatabaseSync, kind: 'record' | 'handoff', id: string): NodeRow | null {
  const row = db.prepare('SELECT * FROM nodes WHERE kind = ? AND id = ?').get(kind, id) as
    | Row
    | undefined;
  return row ? toNode(row) : null;
}

export function bodyOf(db: DatabaseSync, kind: string, id: string): string {
  const row = db
    .prepare(
      'SELECT f.body AS body FROM nodes n JOIN fts f ON f.rowid = n.n WHERE n.kind = ? AND n.id = ?',
    )
    .get(kind, id) as { body: string } | undefined;
  return row?.body ?? '';
}

export interface Hit {
  node: NodeRow;
  rank: number;
}

/** FTS5 (trigram) search for terms of >= 3 chars, plus substring match for shorter terms. */
export function searchNodes(
  db: DatabaseSync,
  terms: string[],
  filter: {
    kind: 'record' | 'handoff';
    status?: Status | undefined;
    types?: RecordType[] | undefined;
  },
  limit: number,
): Hit[] {
  const long = terms.filter((t) => [...t].length >= 3);
  const short = terms.filter((t) => [...t].length < 3);
  const where = ['n.kind = ?'];
  const params: Array<string | number> = [filter.kind];
  if (filter.status) {
    where.push('n.status = ?');
    params.push(filter.status);
  }
  if (filter.types?.length) {
    where.push(`n.type IN (${filter.types.map(() => '?').join(',')})`);
    params.push(...filter.types);
  }
  const hits = new Map<string, Hit>();
  if (long.length) {
    const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    const rows = db
      .prepare(
        `SELECT n.*, bm25(fts, 0, 0, 3.0, 1.0, 2.0) AS rank FROM fts JOIN nodes n ON n.n = fts.rowid
         WHERE fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank ASC, n.id ASC LIMIT ?`,
      )
      .all(match, ...params, limit) as unknown as Row[];
    for (const row of rows)
      hits.set(row['id'] as string, { node: toNode(row), rank: Number(row['rank']) });
  }
  if (short.length) {
    const likes = short
      .map(() => "instr(lower(f.title || ' ' || f.body || ' ' || f.scope), ?) > 0")
      .join(' OR ');
    const rows = db
      .prepare(
        `SELECT n.* FROM fts f JOIN nodes n ON n.n = f.rowid WHERE (${likes}) AND ${where.join(' AND ')}
         ORDER BY n.updated DESC, n.id ASC LIMIT ?`,
      )
      .all(...short.map((t) => t.toLowerCase()), ...params, limit) as unknown as Row[];
    for (const row of rows) {
      if (!hits.has(row['id'] as string))
        hits.set(row['id'] as string, { node: toNode(row), rank: 0 });
    }
  }
  return [...hits.values()];
}

export function listTrash(db: DatabaseSync): TrashRow[] {
  return db
    .prepare('SELECT * FROM trash ORDER BY trashed_at ASC, trash_id ASC')
    .all() as unknown as TrashRow[];
}

export function listInvalid(db: DatabaseSync): Array<{ path: string; error: string }> {
  return db.prepare('SELECT path, error FROM invalid ORDER BY path').all() as unknown as Array<{
    path: string;
    error: string;
  }>;
}

/** Canonical dump of every derived row (for equivalence tests / doctor). */
export function dumpIndex(db: DatabaseSync): unknown {
  const q = (sql: string): unknown => db.prepare(sql).all();
  return {
    nodes: q(
      'SELECT kind, id, type, title, status, path, scope, summary, version, created, updated, hash, mtime_ns, size FROM nodes ORDER BY kind, id',
    ),
    trash: q('SELECT * FROM trash ORDER BY trash_id'),
    invalid: q('SELECT * FROM invalid ORDER BY path'),
    fts: q(
      'SELECT n.kind, n.id, f.title, f.body, f.scope FROM nodes n JOIN fts f ON f.rowid = n.n ORDER BY n.kind, n.id',
    ),
  };
}
