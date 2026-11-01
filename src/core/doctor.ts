import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { requireInitialized, nowOf, staleOf, heldWarnOf, type Ctx } from './context.ts';
import { openIndexReadOnly } from './db.ts';
import { findTempFiles, readTextIfExists } from './fsx.ts';
import { buildIndexMd } from './indexmd.ts';
import { GITIGNORE_LOCAL, GITIGNORE_TRACK, readConfig } from './init.ts';
import { DEFAULT_RECALL_MIN_SCORE, MAX_RECALL_MIN_SCORE } from './relevance.ts';
import { loadAll } from './load.ts';
import { inspectLock } from './lock.ts';
import { TRASH_NEAR_DAYS, TRASH_RETENTION_DAYS } from './paths.ts';
import { parseInbox } from './inbox.ts';
import { readHost, trashSummary, type TrashSummary } from './read.ts';
import { readSkipped } from './recovery.ts';
import { parseDedup, parseState } from './state.ts';
import { DAY_MS, isoTime } from './util.ts';

export type IssueLevel = 'error' | 'warn' | 'info';

export interface Issue {
  level: IssueLevel;
  code: string;
  message: string;
  path?: string;
}

export interface DoctorResult {
  ok: boolean;
  issues: Issue[];
  temp_files: string[];
  trash: TrashSummary & {
    items: Array<{
      trash_id: string;
      id: string;
      title: string;
      trashed_at: string;
      age_days: number;
      state: 'near' | 'expired';
    }>;
  };
  index: { present: boolean; usable: boolean; mismatches: number };
}

/** doctor: read-only consistency report (never repairs; run reindex / write ops to repair). */
export async function doctor(ctx: Ctx): Promise<DoctorResult> {
  const layout = requireInitialized(ctx);
  const now = nowOf(ctx);
  const issues: Issue[] = [];
  const add = (level: IssueLevel, code: string, message: string, path?: string): void => {
    issues.push(path ? { level, code, message, path } : { level, code, message });
  };

  const config = readConfig(readTextIfExists(layout.config));
  if (!config)
    add(
      'error',
      'config_invalid',
      'config.toml is missing git_mode or unreadable',
      '.mwf/config.toml',
    );
  if (config?.recall_min_score_invalid)
    add(
      'warn',
      'config_recall_min_score_invalid',
      `[hooks] recall_min_score must be an integer from 0 to ${MAX_RECALL_MIN_SCORE}; using the default ${DEFAULT_RECALL_MIN_SCORE}`,
      '.mwf/config.toml',
    );
  for (const [file, path] of [
    ['protocol.md', layout.protocol],
    ['inbox.md', layout.inbox],
    ['state.toml', layout.state],
    ['index.md', layout.indexMd],
  ] as const) {
    if (!existsSync(path)) add('warn', 'file_missing', `${file} is missing`, `.mwf/${file}`);
  }
  try {
    parseState(readTextIfExists(layout.state));
  } catch (error) {
    add(
      'error',
      'state_invalid',
      `state.toml cannot be parsed: ${(error as Error).message}`,
      '.mwf/state.toml',
    );
  }

  try {
    parseDedup(readTextIfExists(layout.dedup));
  } catch (error) {
    add(
      'warn',
      'dedup_invalid',
      `dedup.local.toml cannot be parsed (treated as empty; the next write replaces it): ${(error as Error).message}`,
      '.mwf/dedup.local.toml',
    );
  }

  const temp = findTempFiles(layout.mwf);
  for (const file of temp) {
    add(
      'warn',
      'temp_leftover',
      'leftover temp file from an interrupted write (removed by the next lock holder)',
      file.slice(layout.root.length + 1),
    );
  }
  const lock = inspectLock(layout, { staleMs: staleOf(ctx), now: ctx.now ?? Date.now });
  if (lock.held && lock.foreign) {
    // Another hostname (or pid namespace): we cannot check its pid, so only the stale timeout
    // protects/reclaims it.
    const sameName = lock.holder?.host === hostname();
    add(
      'warn',
      'foreign_host_lock',
      `lock is held by host "${lock.holder?.host ?? '?'}" (pid ${lock.holder?.pid ?? '?'}), ` +
        (sameName ? 'in another pid namespace' : 'not this host') +
        '; ' +
        (lock.stale
          ? 'its heartbeat is older than the stale age, so the next writer will reclaim it'
          : 'it is respected until its heartbeat goes stale'),
      '.mwf/mwf.local.lock',
    );
  } else if (lock.held && lock.stale) {
    add(
      'warn',
      'stale_lock',
      `lock held by pid ${lock.holder?.pid ?? '?'} is stale (${lock.reason}) and will be reclaimed`,
      '.mwf/mwf.local.lock',
    );
  }
  const heldFor =
    lock.held && !lock.stale && lock.holder?.acquired !== undefined
      ? now - lock.holder.acquired
      : null;
  if (heldFor !== null && heldFor > heldWarnOf(ctx)) {
    add(
      'warn',
      'lock_held_long',
      `lock has been held for ${Math.round(heldFor / 1000)}s by pid ${lock.holder?.pid ?? '?'} on "${lock.holder?.host ?? '?'}" ` +
        `(warn after ${Math.round(heldWarnOf(ctx) / 1000)}s); a stuck or paused writer blocks every other writer`,
      '.mwf/mwf.local.lock',
    );
  }
  if (existsSync(layout.intent)) {
    add(
      'warn',
      'pending_intent',
      'a write intent was left by an interrupted writer (recovered by the next lock holder)',
      '.mwf/mwf.local.intent.json',
    );
  }

  // L1: roll-forwards that left a changed file in place instead of removing it. Entries whose file
  // is gone by now are resolved and not reported; the rest age out after 30 days.
  for (const skip of readSkipped(layout)) {
    if (!existsSync(join(layout.mwf, ...skip.path.split('/')))) continue;
    add(
      'warn',
      'rollforward_skipped',
      `recovery of an interrupted ${skip.op} (request ${skip.request_id}) did not remove ${skip.path}: it changed after the removal was planned, so it was kept; review it and delete it by hand if it is no longer wanted`,
      `.mwf/${skip.path}`,
    );
  }

  const loaded = loadAll(layout);
  for (const bad of loaded.invalid) add('error', 'invalid_record', bad.error, `.mwf/${bad.path}`);

  // index.db vs record files
  const db = openIndexReadOnly(layout);
  let mismatches = 0;
  const present = existsSync(layout.db);
  if (!db) {
    add(
      present ? 'error' : 'warn',
      present ? 'index_unusable' : 'index_missing',
      present ? 'index.db cannot be opened; run reindex' : 'index.db is missing; run reindex',
      '.mwf/index.db',
    );
  } else {
    try {
      const rows = new Map<string, string>();
      for (const table of ['nodes', 'trash', 'invalid']) {
        for (const r of db.prepare(`SELECT path, hash FROM ${table}`).all() as unknown as Array<{
          path: string;
          hash: string;
        }>) {
          rows.set(r.path, r.hash);
        }
      }
      const files = new Map<string, string>();
      for (const r of loaded.records) files.set(r.path, r.hash);
      for (const h of loaded.handoffs) files.set(h.path, h.hash);
      for (const t of loaded.trash) files.set(t.path, t.hash);
      for (const bad of loaded.invalid) files.set(bad.path, rows.get(bad.path) ?? '');
      for (const [path, hash] of files) {
        const indexed = rows.get(path);
        if (indexed === undefined) {
          mismatches++;
          add('warn', 'index_missing_record', 'record file is not in index.db', `.mwf/${path}`);
        } else if (indexed !== hash && hash !== '') {
          mismatches++;
          add(
            'warn',
            'index_hash_mismatch',
            'record file differs from index.db (hand-edited?); files win on next sync',
            `.mwf/${path}`,
          );
        }
      }
      for (const path of rows.keys()) {
        if (!files.has(path)) {
          mismatches++;
          add(
            'warn',
            'index_orphan',
            'index.db has a row for a file that no longer exists',
            `.mwf/${path}`,
          );
        }
      }
    } finally {
      db.close();
    }
  }

  const existingIndexMd = readTextIfExists(layout.indexMd);
  if (existingIndexMd !== null && existingIndexMd !== buildIndexMd(loaded)) {
    add(
      'info',
      'index_md_stale',
      'index.md is out of date (it is refreshed by every write that changes records or handoffs); run reindex to regenerate it',
      '.mwf/index.md',
    );
  }

  // forgotten records that are also still present
  for (const t of loaded.trash) {
    if (loaded.records.some((r) => r.doc.id === t.doc.record.id)) {
      add(
        'info',
        'in_trash_and_live',
        `record ${t.doc.record.id} exists both live and in trash (${t.trashId})`,
        `.mwf/${t.path}`,
      );
    }
  }

  // trash retention
  const items: DoctorResult['trash']['items'] = [];
  for (const t of loaded.trash) {
    const age = (now - t.doc.trashedAt) / DAY_MS;
    if (age >= TRASH_NEAR_DAYS) {
      const state = age >= TRASH_RETENTION_DAYS ? 'expired' : 'near';
      items.push({
        trash_id: t.trashId,
        id: t.doc.record.id,
        title: t.doc.record.title,
        trashed_at: isoTime(t.doc.trashedAt),
        age_days: Math.floor(age),
        state,
      });
      add(
        'warn',
        state === 'expired' ? 'trash_expired' : 'trash_near_expiry',
        `${t.doc.record.id} in trash for ${Math.floor(age)} days (retention ${TRASH_RETENTION_DAYS})`,
        `.mwf/${t.path}`,
      );
    }
  }
  const trash = trashSummary(
    loaded.trash.map((t) => ({
      trash_id: t.trashId,
      id: t.doc.record.id,
      type: t.doc.record.type,
      title: t.doc.record.title,
      origin: t.doc.origin,
      trashed_at: t.doc.trashedAt,
      reason: t.doc.reason,
      path: t.path,
      hash: t.hash,
    })),
    now,
  );

  // .gitignore expectation
  if (config) {
    const wanted = config.git_mode === 'track' ? GITIGNORE_TRACK : GITIGNORE_LOCAL;
    const present = new Set(
      (readTextIfExists(layout.gitignore) ?? '').split(/\r?\n/).map((l) => l.trim()),
    );
    for (const line of wanted) {
      if (!present.has(line))
        add(
          'warn',
          'gitignore_missing',
          `.gitignore lacks "${line}" (git_mode=${config.git_mode})`,
          '.gitignore',
        );
    }
  }

  const inbox = parseInbox(readTextIfExists(layout.inbox)).entries.length;
  if (inbox)
    add(
      'info',
      'inbox_pending',
      `${inbox} inbox entries are waiting to be tidied`,
      '.mwf/inbox.md',
    );
  if (!Object.keys(readHost(layout.hostLocal)).length)
    add(
      'info',
      'host_unconfirmed',
      'no host has confirmed loading mwf yet',
      '.mwf/host.local.toml',
    );

  return {
    ok: !issues.some((i) => i.level === 'error'),
    issues,
    temp_files: temp.map((f) => f.slice(layout.root.length + 1)),
    trash: { ...trash, items },
    index: { present, usable: db !== null, mismatches },
  };
}
