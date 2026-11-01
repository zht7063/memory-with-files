// mwf's skills as files in the user's skills directory, each ending in a managed marker:
//   <!-- mwf-managed:<package version>:<sha256 of everything above the marker> -->
// The hash is how install and uninstall tell "still exactly what mwf wrote" (A4) from a file the
// user edited, or a skill of the same name that mwf never wrote.
import { lstatSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderSkillMd, SKILLS } from '../skills/index.ts';
import {
  SafeWriteError,
  backupSnapshot,
  checkAncestors,
  commitFile,
  currentOwner,
  mkdirSafe,
  readSnapshot,
  readSnapshotOrAbsent,
  removeFile,
  sha256Hex,
  type Owner,
  type WriteOptions,
} from './safe-write.ts';

const MARKER = /\n<!-- mwf-managed:([^:\s]+):([0-9a-f]{64}) -->\n?$/;

export function withMarker(content: string, version: string): string {
  const body = content.endsWith('\n') ? content : `${content}\n`;
  return `${body}<!-- mwf-managed:${version}:${sha256Hex(body)} -->\n`;
}

export type Managed = { kind: 'none' } | { kind: 'intact' | 'modified'; version: string };

/** Classify existing SKILL.md text. */
export function classify(text: string): Managed {
  const m = MARKER.exec(text);
  if (!m) return { kind: 'none' };
  const body = text.slice(0, m.index + 1);
  return { kind: sha256Hex(body) === m[2] ? 'intact' : 'modified', version: m[1]! };
}

export interface SkillStep {
  name: string;
  path: string;
  status: 'created' | 'updated' | 'unchanged' | 'removed' | 'kept' | 'refused';
  detail?: string;
  backup?: string;
  /** Set when the step failed with a safe-write code (UNSAFE_TARGET, ...): the same code as in JSON. */
  code?: string;
}

export interface SkillsOptions {
  skillsRoot: string;
  version: string;
  host: string;
  dryRun: boolean;
  force: boolean;
  owner?: Owner;
  now?: Date;
}

function lstat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Create the directory chain if absent (0755); refuse a symlinked skill directory. Every directory
 * above it, up to the trust root, is checked first (a symlinked skills root into /tmp is refused,
 * UNSAFE_TARGET), the chain is created below the RESOLVED path (never through a link), and checked
 * again once it exists. Throws SafeWriteError(UNSAFE_TARGET).
 */
function ensureSkillDir(dir: string, dryRun: boolean, owner: Owner): string | undefined {
  checkAncestors(dirname(dir), owner);
  const st = lstat(dir);
  if (st?.isSymbolicLink())
    return 'the skill directory is a symbolic link (an arrangement of yours); mwf will not write into it';
  if (st && !st.isDirectory()) return 'a file is in the way of the skill directory';
  if (!st && !dryRun) {
    mkdirSafe(dir, owner, 0o755);
  }
  return undefined;
}

const codeOf = (error: unknown): string | undefined =>
  error instanceof SafeWriteError && error.code === 'UNSAFE_TARGET' ? error.code : undefined;

export function installSkills(options: SkillsOptions): SkillStep[] {
  const owner = options.owner ?? currentOwner();
  const steps: SkillStep[] = [];
  for (const skill of SKILLS) {
    const dir = join(options.skillsRoot, skill.name);
    const path = join(dir, 'SKILL.md');
    const want = withMarker(renderSkillMd(skill, options.host), options.version);
    let refused: string | undefined;
    try {
      refused = ensureSkillDir(dir, options.dryRun, owner);
    } catch (error) {
      if (!(error instanceof SafeWriteError)) throw error;
      steps.push({
        name: skill.name,
        path,
        status: 'refused',
        detail: error.message,
        code: error.code,
      });
      continue;
    }
    if (refused) {
      steps.push({ name: skill.name, path, status: 'refused', detail: refused });
      continue;
    }
    const write: WriteOptions = {
      owner,
      mode: 0o644,
      ...(options.now ? { now: options.now } : {}),
    };
    try {
      const snap = readSnapshotOrAbsent(path, owner);
      if (!snap.exists) {
        if (!options.dryRun) commitFile(path, want, snap, write);
        steps.push({ name: skill.name, path, status: 'created' });
        continue;
      }
      const state = classify(snap.content.toString('utf8'));
      if (state.kind === 'none' && !options.force) {
        steps.push({
          name: skill.name,
          path,
          status: 'refused',
          detail:
            'a SKILL.md that mwf did not write is already there; kept (--force-skills overwrites it, after a backup)',
        });
        continue;
      }
      if (state.kind === 'modified' && !options.force) {
        steps.push({
          name: skill.name,
          path,
          status: 'refused',
          detail:
            'you have edited this skill since mwf wrote it; kept (--force-skills overwrites it, after a backup)',
        });
        continue;
      }
      if (snap.content.toString('utf8') === want) {
        steps.push({ name: skill.name, path, status: 'unchanged' });
        continue;
      }
      // An intact file is mwf's own older version: replace it without a backup. Anything else
      // (only with --force-skills) is the user's text and is backed up first, outside the skill
      // directory so the directory still holds just SKILL.md.
      const ours = state.kind === 'intact';
      let backup: string | undefined;
      if (!options.dryRun) {
        if (!ours)
          backup = backupSnapshot(path, snap, {
            dir: dirname(dir),
            name: `${skill.name}.SKILL.md`,
            ...(options.now ? { now: options.now } : {}),
          });
        commitFile(path, want, snap, { ...write, backup: false });
      }
      steps.push({ name: skill.name, path, status: 'updated', ...(backup ? { backup } : {}) });
    } catch (error) {
      const code = codeOf(error);
      steps.push({
        name: skill.name,
        path,
        status: 'refused',
        detail: (error as Error).message,
        ...(code ? { code } : {}),
      });
    }
  }
  return steps;
}

export function uninstallSkills(options: SkillsOptions): SkillStep[] {
  const owner = options.owner ?? currentOwner();
  const steps: SkillStep[] = [];
  for (const skill of SKILLS) {
    const dir = join(options.skillsRoot, skill.name);
    const path = join(dir, 'SKILL.md');
    try {
      checkAncestors(dirname(dir), owner); // never remove through an unsafe or dangling link
    } catch (error) {
      if (!(error instanceof SafeWriteError)) throw error;
      steps.push({
        name: skill.name,
        path,
        status: 'refused',
        detail: error.message,
        code: error.code,
      });
      continue;
    }
    const st = lstat(dir);
    if (!st) {
      steps.push({ name: skill.name, path, status: 'unchanged', detail: 'not installed' });
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      steps.push({
        name: skill.name,
        path,
        status: 'kept',
        detail: 'not a plain directory; left alone',
      });
      continue;
    }
    try {
      const snap = readSnapshot(path, owner);
      if (!snap.exists) {
        steps.push({ name: skill.name, path, status: 'unchanged', detail: 'no SKILL.md' });
        continue;
      }
      const state = classify(snap.content.toString('utf8'));
      if (state.kind !== 'intact' && !options.force) {
        steps.push({
          name: skill.name,
          path,
          status: 'kept',
          detail:
            state.kind === 'none'
              ? 'not written by mwf; kept'
              : 'edited since mwf wrote it (its hash no longer matches); kept (--force-skills removes it, after a backup)',
        });
        continue;
      }
      let backup: string | undefined;
      if (!options.dryRun) {
        const result = removeFile(path, snap, {
          owner,
          backup: state.kind !== 'intact',
          dir: dirname(dir),
          name: `${skill.name}.SKILL.md`,
          ...(options.now ? { now: options.now } : {}),
        });
        backup = result.backup;
        try {
          rmdirSync(dir); // only when nothing else is in it
        } catch {
          /* the user keeps other files here */
        }
      }
      steps.push({ name: skill.name, path, status: 'removed', ...(backup ? { backup } : {}) });
    } catch (error) {
      const code = codeOf(error);
      steps.push({
        name: skill.name,
        path,
        status: code ? 'refused' : 'kept',
        detail: (error as Error).message,
        ...(code ? { code } : {}),
      });
    }
  }
  return steps;
}
