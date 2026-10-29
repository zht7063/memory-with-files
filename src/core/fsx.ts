import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { failpoint } from './failpoint.ts';

export const TMP_PREFIX = '.tmp-';

export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Directory fsync is unsupported on some platforms/filesystems.
    if (!['EISDIR', 'EPERM', 'EINVAL', 'EACCES', 'ENOTSUP'].includes(code ?? '')) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Atomic durable write: temp file in the same directory -> write -> fsync file -> rename ->
 * fsync directory. Readers see either the old or the new content, never a partial file.
 */
export function atomicWrite(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `${TMP_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}-${basename(path)}`,
  );
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let offset = 0;
    while (offset < buf.length) offset += writeSync(fd, buf, offset, buf.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  failpoint('atomic:temp-synced');
  renameSync(tmp, path);
  failpoint('atomic:renamed');
  fsyncDir(dir);
}

/** Durable unlink (no-op if already absent). */
export function removeDurable(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return;
  }
  fsyncDir(dirname(path));
}

export function readBytesIfExists(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readTextIfExists(path: string): string | null {
  const bytes = readBytesIfExists(path);
  return bytes === null ? null : bytes.toString('utf8');
}

export function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** All leftover `.tmp-*` files below dir (recursive; skips SQLite files). */
export function findTempFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith(TMP_PREFIX)) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

export function removeTempFiles(dir: string): string[] {
  const removed: string[] = [];
  for (const file of findTempFiles(dir)) {
    try {
      unlinkSync(file);
      removed.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return removed;
}
