import { mkdirSync } from 'node:fs';
import TOML from '@iarna/toml';
import {
  requireInitialized,
  layoutFor,
  nowOf,
  staleOf,
  waitOf,
  type Ctx,
  type WriteInput,
} from './context.ts';
import { checkpoint, openIndex, syncIndex } from './db.ts';
import { invalid, MwfError } from './errors.ts';
import { atomicWrite, exists, readTextIfExists, removeTempFiles } from './fsx.ts';
import { buildIndexMd } from './indexmd.ts';
import { INBOX_HEADER } from './inbox.ts';
import { loadAll } from './load.ts';
import { acquireLock } from './lock.ts';
import { RECORD_TYPES, TYPE_DIR } from './paths.ts';
import { emptyState, stringifyState } from './state.ts';
import { PROTOCOL_MD } from './templates.ts';
import { isoTime } from './util.ts';
import { MWF_VERSION, SCHEMA } from './version.ts';

export type GitMode = 'track' | 'local';

export const GITIGNORE_TRACK = ['.mwf/trash/', '.mwf/index.db-*', '.mwf/*.local.*'] as const;
export const GITIGNORE_LOCAL = ['.mwf/'] as const;

export interface InitInput extends WriteInput {
  /** 'track': .mwf/ goes into git (three machine-local patterns ignored). 'local': .mwf/ ignored. */
  git_mode: GitMode;
}

export interface InitResult {
  root: string;
  mwf_dir: string;
  git_mode: GitMode;
  created: boolean;
  gitignore_added: string[];
}

export function readConfig(text: string | null): { git_mode: GitMode; mwf_version: string } | null {
  if (text === null) return null;
  const raw = TOML.parse(text) as Record<string, unknown>;
  const mode = raw['git_mode'];
  if (mode !== 'track' && mode !== 'local') return null;
  return { git_mode: mode, mwf_version: String(raw['mwf_version'] ?? '') };
}

function addGitignoreLines(path: string, lines: readonly string[]): string[] {
  const current = readTextIfExists(path) ?? '';
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !present.has(l));
  if (!missing.length) return [];
  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
  atomicWrite(path, `${prefix}${missing.join('\n')}\n`);
  return [...missing];
}

/**
 * Create .mwf/ (idempotent). The only file written outside .mwf/ is the project's .gitignore.
 * config.toml is written last, so an interrupted init is simply re-run.
 */
export async function init(ctx: Ctx, input: InitInput): Promise<InitResult> {
  if (input.git_mode !== 'track' && input.git_mode !== 'local') {
    throw invalid("git_mode must be 'track' or 'local'");
  }
  const layout = layoutFor(ctx);
  const existing = readConfig(readTextIfExists(layout.config));
  if (existing && existing.git_mode !== input.git_mode) {
    throw new MwfError(
      'GIT_MODE_CONFLICT',
      `already initialised with git_mode=${existing.git_mode}`,
      {
        git_mode: existing.git_mode,
      },
    );
  }
  mkdirSync(layout.mwf, { recursive: true });
  const lock = await acquireLock(layout, {
    waitMs: waitOf(ctx, input.wait_ms),
    staleMs: staleOf(ctx),
    now: ctx.now ?? Date.now,
  });
  try {
    removeTempFiles(layout.mwf);
    const now = nowOf(ctx);
    mkdirSync(layout.handoffDir, { recursive: true });
    for (const type of RECORD_TYPES)
      mkdirSync(`${layout.memoryDir}/${TYPE_DIR[type]}`, { recursive: true });
    if (!exists(layout.protocol)) atomicWrite(layout.protocol, PROTOCOL_MD);
    if (!exists(layout.inbox)) atomicWrite(layout.inbox, `${INBOX_HEADER}`);
    if (!exists(layout.state)) atomicWrite(layout.state, stringifyState(emptyState()));
    const { db } = openIndex(layout, now);
    try {
      syncIndex(db, layout);
      checkpoint(db);
    } finally {
      db.close();
    }
    if (!exists(layout.indexMd)) atomicWrite(layout.indexMd, buildIndexMd(loadAll(layout)));
    const gitignore_added = addGitignoreLines(
      layout.gitignore,
      input.git_mode === 'track' ? GITIGNORE_TRACK : GITIGNORE_LOCAL,
    );
    let created = false;
    if (!existing) {
      created = true;
      atomicWrite(
        layout.config,
        TOML.stringify({
          mwf_version: MWF_VERSION,
          schema: SCHEMA,
          git_mode: input.git_mode,
          created: isoTime(now),
        }),
      );
    }
    return {
      root: layout.root,
      mwf_dir: layout.mwf,
      git_mode: input.git_mode,
      created,
      gitignore_added,
    };
  } finally {
    lock.release();
  }
}

export function getGitMode(ctx: Ctx): GitMode {
  const layout = requireInitialized(ctx);
  return readConfig(readTextIfExists(layout.config))?.git_mode ?? 'track';
}
