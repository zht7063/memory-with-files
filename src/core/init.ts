import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
import { DEFAULT_RECALL_MIN_SCORE, MAX_RECALL_MIN_SCORE } from './relevance.ts';
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

export interface Config {
  git_mode: GitMode;
  mwf_version: string;
  /** `[hooks] stop = false` turns the end-of-turn (Stop) hook off for this project; default on. */
  hooks_stop: boolean;
  /**
   * `[hooks] recall_min_score = N` (integer 0..20, default 2): the relevance a stored record needs
   * to be injected for a user prompt; 0 turns the filter off. Anything else falls back to the
   * default and is reported by doctor (`recall_min_score_invalid`).
   */
  hooks_recall_min_score: number;
  recall_min_score_invalid: boolean;
}

export function readConfig(text: string | null): Config | null {
  if (text === null) return null;
  const raw = TOML.parse(text) as Record<string, unknown>;
  const mode = raw['git_mode'];
  if (mode !== 'track' && mode !== 'local') return null;
  const hooks = raw['hooks'];
  const hooksTable =
    typeof hooks === 'object' && hooks !== null ? (hooks as Record<string, unknown>) : {};
  const stop = hooksTable['stop'];
  const minScore = hooksTable['recall_min_score'];
  const minScoreOk =
    typeof minScore === 'number' &&
    Number.isInteger(minScore) &&
    minScore >= 0 &&
    minScore <= MAX_RECALL_MIN_SCORE;
  return {
    git_mode: mode,
    mwf_version: String(raw['mwf_version'] ?? ''),
    hooks_stop: stop !== false,
    hooks_recall_min_score: minScoreOk ? minScore : DEFAULT_RECALL_MIN_SCORE,
    recall_min_score_invalid: minScore !== undefined && !minScoreOk,
  };
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
 * The project root is the directory init runs in, and that directory must be the git repository
 * root: it holds `.git` (a directory, or the file a worktree / submodule has). Refuse otherwise
 * and write nothing, so a stray init never plants a .mwf/ in a subdirectory, in $HOME or in /tmp.
 */
export function requireGitRoot(root: string): void {
  const dir = resolve(root);
  if (existsSync(join(dir, '.git'))) return;
  for (let up = dirname(dir); ; up = dirname(up)) {
    if (existsSync(join(up, '.git'))) {
      throw new MwfError(
        'NOT_GIT_ROOT',
        `${dir} is inside the git repository at ${up} but is not its root (.git is not here); ` +
          `run init from ${up}. Nothing was written.`,
        { root: dir, git_root: up },
      );
    }
    if (dirname(up) === up) break;
  }
  throw new MwfError(
    'NOT_GIT_ROOT',
    `no .git in ${dir} or any parent: init only works at the root of a git repository ` +
      '(run `git init` first, or start from the repository root). Nothing was written.',
    { root: dir },
  );
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
  requireGitRoot(layout.root);
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
