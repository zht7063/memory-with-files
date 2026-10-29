import { MwfError } from './errors.ts';

/**
 * Secret scanning for memory writes. Deliberately conservative (high precision): it recognises
 * well-known credential formats plus `name = value` assignments whose value looks random. It is a
 * safety net against pasting credentials into long-term memory, not a full DLP engine.
 */

interface Rule {
  id: string;
  re: RegExp;
  /** Optional extra check on the matched text (e.g. entropy / placeholder filters). */
  accept?: (match: string, groups: string[]) => boolean;
}

export interface SecretFinding {
  rule: string;
  line: number;
  /** Redacted sample: first 4 characters + length. Never the secret itself. */
  sample: string;
  /** Internal identity for before/after comparison; never surfaced. */
  key: string;
}

const PLACEHOLDER =
  /^(?:x{4,}|\*{4,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Z_]+%|your[-_ ]?.*|example.*|changeme.*|change[-_]me.*|placeholder.*|redacted.*|dummy.*|sample.*|todo.*|none|null|secret|password|passwd|token|api[-_]?key)$/i;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksRandom(value: string): boolean {
  if (value.length < 16 || PLACEHOLDER.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
  return entropy(value) >= 3.3;
}

const RULES: Rule[] = [
  {
    id: 'private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g },
  {
    id: 'aws-secret-access-key',
    re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
  },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    id: 'slack-webhook',
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
  },
  { id: 'stripe-key', re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', re: /\bsk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{34,}\b/g },
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    id: 'authorization-header',
    re: /authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{16,})/gi,
    accept: (_m, g) => looksRandom(g[0] ?? ''),
  },
  {
    id: 'url-credentials',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s:/@'"]{4,})@[^\s/'"]+/gi,
    accept: (_m, g) => !PLACEHOLDER.test(g[0] ?? '') && !/^[<{$*]/.test(g[0] ?? ''),
  },
  {
    id: 'secret-assignment',
    re: /\b[\w.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|private[_-]?key|access[_-]?key|credential)[\w.-]*["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.=!@#$%^&*-]{16,})/gi,
    accept: (_m, g) => looksRandom(g[0] ?? ''),
  },
];

/** All likely secrets in `text`, with 1-based line numbers. Order: by position. */
export function scanSecrets(text: string): SecretFinding[] {
  const found: Array<SecretFinding & { at: number }> = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.accept && !rule.accept(m[0], m.slice(1))) continue;
      const at = m.index ?? 0;
      found.push({
        rule: rule.id,
        line: text.slice(0, at).split('\n').length,
        sample: `${m[0].slice(0, 4)}… (${m[0].length} chars)`,
        key: `${rule.id}\u0000${m[0]}`,
        at,
      });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ at: _at, ...f }) => f);
}

/** Paths (relative to .mwf/) whose content is user/agent-authored memory and is scanned. */
export function isScannedPath(path: string): boolean {
  return path.startsWith('memory/') || path.startsWith('handoff/') || path === 'inbox.md';
}

export interface PlannedText {
  path: string;
  before: string | null;
  after: string;
}

/**
 * Reject a write that INTRODUCES a likely secret. Only matches not already present in the file's
 * previous content count, so forgetting / compacting / re-saving a record that already contained
 * something secret-looking stays possible (the way to get rid of it). Trash copies are not scanned.
 */
export function assertNoSecrets(items: PlannedText[]): void {
  const findings: Array<{ path: string; line: number; rule: string; sample: string }> = [];
  for (const item of items) {
    if (!isScannedPath(item.path)) continue;
    const old = new Set(item.before === null ? [] : scanSecrets(item.before).map((f) => f.key));
    for (const f of scanSecrets(item.after)) {
      if (old.has(f.key)) continue;
      findings.push({ path: `.mwf/${item.path}`, line: f.line, rule: f.rule, sample: f.sample });
    }
  }
  if (!findings.length) return;
  const list = findings
    .slice(0, 5)
    .map((f) => `${f.rule} at ${f.path}:${f.line} (${f.sample})`)
    .join('; ');
  throw new MwfError(
    'SECRET_DETECTED',
    `refusing to write: ${findings.length} likely secret(s) found (${list}). Memory must not contain ` +
      'credentials: remove the value or replace it with a placeholder / a reference to where it is stored, then retry.',
    { findings: findings.slice(0, 20) },
  );
}
