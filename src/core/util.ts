import { createHash, randomUUID } from 'node:crypto';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with recursively sorted object keys, for stable hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Deterministic lowercase base32 token (length chars) derived from a seed string. */
export function token(seed: string, length: number): string {
  const digest = createHash('sha256').update(seed).digest();
  let out = '';
  for (let i = 0; i < length; i++) out += B32[(digest[i] ?? 0) % 32];
  return out;
}

export function newRequestId(): string {
  return randomUUID();
}

export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DAY_MS = 24 * 60 * 60 * 1000;
