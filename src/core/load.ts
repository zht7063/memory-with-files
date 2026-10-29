import { beat } from './lock.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanFiles } from './db.ts';
import { ID_RE, TASK_RE, TRASH_ID_RE, TYPE_DIR, type Layout } from './paths.ts';
import {
  parseHandoff,
  parseRecord,
  parseTrash,
  scopeText,
  SCOPE_KEYS,
  type HandoffDoc,
  type RecordDoc,
  type TrashDoc,
} from './records.ts';
import { sha256 } from './util.ts';

export interface LoadedRecord {
  path: string;
  hash: string;
  text: string;
  doc: RecordDoc;
}
export interface LoadedHandoff {
  path: string;
  hash: string;
  doc: HandoffDoc;
}
export interface LoadedTrash {
  path: string;
  trashId: string;
  hash: string;
  doc: TrashDoc;
}

export interface Loaded {
  records: LoadedRecord[];
  handoffs: LoadedHandoff[];
  trash: LoadedTrash[];
  invalid: Array<{ path: string; error: string }>;
}

/**
 * Parse every record file from disk (the source of truth), independent of index.db.
 *
 * `overlay` (path relative to .mwf/ -> new text, or null = removed) loads the state AS IF a planned
 * set of target writes had already been applied; used to derive index.md before the writes happen.
 */
export function loadAll(layout: Layout, overlay?: ReadonlyMap<string, string | null>): Loaded {
  const out: Loaded = { records: [], handoffs: [], trash: [], invalid: [] };
  const seenIds = new Map<string, string>();
  const files: Array<{ path: string; abs: string }> = scanFiles(layout);
  if (overlay) {
    const known = new Set(files.map((f) => f.path));
    for (const [path, text] of overlay) {
      if (text !== null && !known.has(path) && /^(memory|handoff|trash)\/.+\.md$/.test(path))
        files.push({ path, abs: join(layout.mwf, ...path.split('/')) });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  for (const file of files) {
    beat();
    let text: string;
    const over = overlay?.get(file.path);
    if (over === null) continue;
    if (over !== undefined) text = over;
    else {
      try {
        text = readFileSync(file.abs, 'utf8');
      } catch {
        continue;
      }
    }
    const hash = sha256(Buffer.from(text, 'utf8'));
    const stem = file.path.slice(file.path.lastIndexOf('/') + 1, -3);
    try {
      if (file.path.startsWith('memory/')) {
        const doc = parseRecord(text, stem);
        if (!ID_RE.test(doc.id) || doc.id !== stem)
          throw new Error(`id ${doc.id} does not match file name`);
        if (file.path !== `memory/${TYPE_DIR[doc.type]}/${doc.id}.md`)
          throw new Error('type does not match directory');
        const dup = seenIds.get(doc.id);
        if (dup) throw new Error(`duplicate id (also ${dup})`);
        seenIds.set(doc.id, file.path);
        out.records.push({ path: file.path, hash, text, doc });
      } else if (file.path.startsWith('handoff/')) {
        if (!TASK_RE.test(stem)) throw new Error('invalid task name');
        out.handoffs.push({ path: file.path, hash, doc: parseHandoff(text, stem) });
      } else if (file.path.startsWith('trash/')) {
        if (!TRASH_ID_RE.test(stem)) throw new Error('invalid trash entry name');
        out.trash.push({ path: file.path, trashId: stem, hash, doc: parseTrash(text) });
      }
    } catch (error) {
      out.invalid.push({ path: file.path, error: (error as Error).message });
    }
  }
  return out;
}

export function scopeSummary(doc: RecordDoc): string {
  const parts: string[] = [];
  for (const key of SCOPE_KEYS) {
    const items = doc.scope[key];
    if (items?.length) parts.push(`${key}: ${items.join(', ')}`);
  }
  return parts.join('; ') || scopeText(doc.scope);
}
