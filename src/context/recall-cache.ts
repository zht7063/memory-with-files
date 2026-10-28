import fs from "node:fs";
import path from "node:path";
import { RECORD_DIRS } from "../contracts/records.js";
// Short-window cache for repeated identical recalls in one long-lived MCP
// process (issue #30). Entries are keyed by the full tool input plus a cheap
// stat fingerprint of the memory files, so a write by this or any other process
// changes the key instead of serving stale recall; the TTL bounds the rest.
export const RECALL_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 32;
type Entry = { at: number; text: string };
export class RecallCache {
  private entries = new Map<string, Entry>();
  constructor(
    private root: string,
    private ttl = RECALL_CACHE_TTL_MS,
    private now: () => number = Date.now,
  ) {}
  fingerprint() {
    const parts: string[] = [];
    const stat = (file: string) => {
      try {
        const s = fs.statSync(file);
        parts.push(`${file}:${s.mtimeMs}:${s.size}:${s.ino}`);
      } catch {
        parts.push(`${file}:-`);
      }
    };
    const base = path.join(this.root, ".mwf");
    stat(path.join(base, "config.json"));
    for (const dir of [...RECORD_DIRS, "archive"]) {
      const directory = path.join(base, dir);
      stat(directory);
      let names: string[] = [];
      try {
        names = fs.readdirSync(directory).sort();
      } catch {}
      for (const name of names) stat(path.join(directory, name));
    }
    return parts.join("|");
  }
  key(input: unknown) {
    return JSON.stringify([stable(input), this.fingerprint()]);
  }
  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttl) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.text;
  }
  set(key: string, text: string) {
    this.entries.set(key, { at: this.now(), text });
    for (const k of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES) break;
      this.entries.delete(k);
    }
  }
  clear() {
    this.entries.clear();
  }
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  return value;
}
