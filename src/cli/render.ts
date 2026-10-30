import type {
  AddResult,
  DoctorResult,
  HandoffListItem,
  HandoffSaveResult,
  HandoffView,
  RecallResult,
  StatusResult,
} from '../core/index.ts';

import { shellCommandFor } from './shellcmd.ts';

/** Plain-text renderings for the shell commands (`--json` prints the structured result instead). */

export function renderStatus(s: StatusResult): string {
  const lines = [`mwf ${s.version || '?'} · git_mode=${s.git_mode}`];
  const records = Object.entries(s.records).map(
    ([type, n]) => `${type} ${n.active}${n.done ? ` (+${n.done} done)` : ''}`,
  );
  lines.push(`records: ${records.join(', ')}`);
  lines.push(`handoffs: ${s.handoffs.open} open, ${s.handoffs.done} done`);
  lines.push(`inbox: ${s.inbox_pending} pending`);
  lines.push(
    `trash: ${s.trash.total}` +
      (s.trash.expired ? `, ${s.trash.expired} expired` : '') +
      (s.trash.near ? `, ${s.trash.near} near expiry` : ''),
  );
  lines.push(
    `index: ${s.index.in_sync ? 'in sync' : 'out of sync'}` +
      (s.index.invalid_files ? `, ${s.index.invalid_files} invalid file(s)` : ''),
  );
  lines.push(
    s.lock.held
      ? `lock: held by pid ${s.lock.holder_pid ?? '?'}` +
          (s.lock.foreign_host ? ' (other host / pid namespace)' : '') +
          (s.lock.stale ? ', stale' : '')
      : 'lock: free',
  );
  const hosts = Object.keys(s.host);
  lines.push(`host: ${hosts.length ? hosts.join(', ') : 'none confirmed'}`);
  for (const hint of s.hints) lines.push(`hint: ${hint}`);
  for (const warning of s.warnings) lines.push(`warning: ${warning}`);
  return lines.join('\n');
}

export function renderRecall(r: RecallResult): string {
  const lines: string[] = [];
  if (r.handoff) {
    const h = r.handoff;
    lines.push(
      `# handoff ${h.task} [${h.status}] v${h.version} · ${h.updated}`,
      '',
      h.body.trimEnd(),
    );
    if (r.hits.length) lines.push('');
  }
  for (const hit of r.hits) {
    const tag = hit.kind === 'handoff' ? 'handoff' : (hit.type ?? 'record');
    lines.push(`${hit.id} [${tag}/${hit.status}] ${hit.title}`);
    if (hit.snippet) lines.push(`  ${hit.snippet}`);
  }
  if (!r.handoff && !r.hits.length) lines.push('no matches');
  if (r.truncated) lines.push(`(truncated: ${r.total_matched} matched)`);
  for (const warning of r.warnings) lines.push(`warning: ${warning}`);
  return lines.join('\n');
}

export function renderDoctor(d: DoctorResult): string {
  const lines: string[] = [];
  for (const issue of d.issues) {
    lines.push(
      `${issue.level.toUpperCase().padEnd(5)} ${issue.code}: ${issue.message}` +
        (issue.path ? ` (${issue.path})` : ''),
    );
  }
  const errors = d.issues.filter((i) => i.level === 'error').length;
  const warns = d.issues.filter((i) => i.level === 'warn').length;
  lines.push(
    d.issues.length
      ? `${errors} error(s), ${warns} warning(s), ${d.issues.length - errors - warns} note(s)`
      : 'no issues',
  );
  return lines.join('\n');
}

export function renderAdd(r: AddResult & { request_id: string; deduped: boolean }): string {
  const lines = [
    `${r.deduped ? 'already added' : 'added'} ${r.id} [${r.type}] ${r.title}`,
    `  ${r.path}`,
  ];
  if (r.similar.length) lines.push(`similar active records: ${r.similar.join(', ')}`);
  lines.push(`request_id: ${r.request_id}`);
  return lines.join('\n');
}

export function renderHandoff(
  r:
    | HandoffView
    | { items: HandoffListItem[]; warnings: string[] }
    | (HandoffSaveResult & { request_id: string; deduped: boolean }),
): string {
  if ('items' in r) {
    const lines = r.items.map(
      (i) =>
        `${i.task} [${i.status}] v${i.version} · ${i.updated}${i.summary ? ` · ${i.summary}` : ''}`,
    );
    if (!lines.length) lines.push('no handoffs');
    for (const warning of r.warnings) lines.push(`warning: ${warning}`);
    return lines.join('\n');
  }
  if ('body' in r) {
    return [
      `# handoff ${r.task} [${r.status}] v${r.version} · ${r.updated}`,
      '',
      r.body.trimEnd(),
    ].join('\n');
  }
  const lines = [
    `${r.deduped ? 'already saved' : 'saved'} handoff ${r.task} v${r.version} [${r.status}]`,
    `  ${r.path}`,
  ];
  if (r.conflict) {
    lines.push(
      'conflict: --base-version was not the current version; the content was appended as a 「并行更新」 section, nothing was overwritten',
    );
  }
  lines.push(`request_id: ${r.request_id}`);
  return lines.join('\n');
}

/** forget / purge / compact / inbox: a preview (nothing changed), or what the execution did. */
export function renderMaintenance(
  name: string,
  input: Record<string, unknown>,
  data: unknown,
): string {
  const d = (data ?? {}) as Record<string, unknown>;
  if (d['preview'] === true) {
    const affected = Array.isArray(d['affected'])
      ? (d['affected'] as Array<Record<string, unknown>>)
      : [];
    const lines = [
      `preview of ${String(d['op'] ?? name)}: nothing was changed; ${affected.length} affected`,
    ];
    for (const item of affected) {
      const { hash: _hash, ...rest } = item;
      lines.push(`  - ${JSON.stringify(rest)}`);
    }
    const token = String(d['preview_token'] ?? '');
    lines.push(`preview_token: ${token}`);
    const command = shellCommandFor(name, input, token);
    if (command) lines.push(`to execute, run this yourself in a terminal: ${command}`);
    return lines.join('\n');
  }
  return JSON.stringify(d, null, 2);
}
