import type { Loaded } from './load.ts';
import { scopeSummary } from './load.ts';
import { RECORD_TYPES } from './paths.ts';

const HEADINGS: Record<string, string> = {
  preference: 'Preferences 偏好',
  decision: 'Decisions 决策',
  incident: 'Incidents 事件',
  task: 'Tasks 任务',
  knowledge: 'Knowledge 知识',
};

/** Deterministic human-readable directory built purely from the record files. */
export function buildIndexMd(loaded: Loaded): string {
  const lines = [
    '# MWF index',
    '',
    '> 由 `reindex` 从记录文件生成，请勿手工编辑；记录文件才是事实来源。',
    '',
  ];
  for (const type of RECORD_TYPES) {
    const docs = loaded.records
      .filter((r) => r.doc.type === type)
      .sort((a, b) => a.doc.id.localeCompare(b.doc.id));
    lines.push(`## ${HEADINGS[type]} (${docs.length})`, '');
    for (const r of docs) {
      const scope = scopeSummary(r.doc);
      const flag = r.doc.status === 'done' ? ' [done]' : '';
      lines.push(
        `- [${r.doc.title.replace(/[\[\]]/g, '')}](${r.path}) \`${r.doc.id}\`${flag}${scope ? ` — ${scope}` : ''}`,
      );
    }
    lines.push('');
  }
  const handoffs = [...loaded.handoffs].sort((a, b) => a.doc.task.localeCompare(b.doc.task));
  lines.push(`## Handoff 交接 (${handoffs.length})`, '');
  for (const h of handoffs) {
    const flag = h.doc.status === 'done' ? ' [done]' : '';
    lines.push(
      `- [${h.doc.task}](${h.path})${flag}${h.doc.summary ? ` — ${h.doc.summary.replace(/\n/g, ' ')}` : ''}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
