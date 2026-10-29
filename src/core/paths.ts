import { join } from 'node:path';

export const RECORD_TYPES = ['preference', 'decision', 'incident', 'task', 'knowledge'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const TYPE_DIR: Record<RecordType, string> = {
  preference: 'preferences',
  decision: 'decisions',
  incident: 'incidents',
  task: 'tasks',
  knowledge: 'knowledge',
};

export const TYPE_PREFIX: Record<RecordType, string> = {
  preference: 'pref',
  decision: 'dec',
  incident: 'inc',
  task: 'task',
  knowledge: 'kn',
};

export const PREFIX_TYPE: Record<string, RecordType> = Object.fromEntries(
  RECORD_TYPES.map((type) => [TYPE_PREFIX[type], type]),
);

export const TRASH_RETENTION_DAYS = 30;
export const TRASH_NEAR_DAYS = 25;

export interface Layout {
  root: string;
  mwf: string;
  config: string;
  protocol: string;
  indexMd: string;
  inbox: string;
  handoffDir: string;
  memoryDir: string;
  db: string;
  state: string;
  /** request_id dedup table; machine-local (gitignored by `.mwf/*.local.*`). */
  dedup: string;
  hostLocal: string;
  trash: string;
  lock: string;
  lockGuard: string;
  intent: string;
  gitignore: string;
}

export function layoutOf(root: string): Layout {
  const mwf = join(root, '.mwf');
  return {
    root,
    mwf,
    config: join(mwf, 'config.toml'),
    protocol: join(mwf, 'protocol.md'),
    indexMd: join(mwf, 'index.md'),
    inbox: join(mwf, 'inbox.md'),
    handoffDir: join(mwf, 'handoff'),
    memoryDir: join(mwf, 'memory'),
    db: join(mwf, 'index.db'),
    state: join(mwf, 'state.toml'),
    dedup: join(mwf, 'dedup.local.toml'),
    hostLocal: join(mwf, 'host.local.toml'),
    trash: join(mwf, 'trash'),
    lock: join(mwf, 'mwf.local.lock'),
    lockGuard: join(mwf, 'mwf.local.lock.reclaim'),
    intent: join(mwf, 'mwf.local.intent.json'),
    gitignore: join(root, '.gitignore'),
  };
}

export const ID_RE = /^(pref|dec|inc|task|kn)_[a-z2-7]{10}$/;
export const TRASH_ID_RE = /^(pref|dec|inc|task|kn)_[a-z2-7]{10}\.\d{10,16}$/;
export const INBOX_ID_RE = /^ib_[a-z2-7]{10}$/;
export const TASK_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u;
export const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function typeOfId(id: string): RecordType | null {
  const match = /^([a-z]+)_/.exec(id);
  return (match?.[1] && PREFIX_TYPE[match[1]]) || null;
}

/** Path of a record relative to .mwf/ (posix separators). */
export function recordRelPath(type: RecordType, id: string): string {
  return `memory/${TYPE_DIR[type]}/${id}.md`;
}

export function handoffRelPath(task: string): string {
  return `handoff/${task}.md`;
}
