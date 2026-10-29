import { INBOX_ID_RE } from './paths.ts';

export interface InboxEntry {
  id: string;
  at: string;
  source: string;
  text: string;
}

export const INBOX_HEADER =
  '# Inbox\n\n待整理内容（用户提交与 `propose` 追加）。用 `inbox` 转为正式记录或丢弃。\n';

const HEADER_RE = /^## (ib_[a-z2-7]{10}) \| (\S+) \| (.*)$/;

export function parseInbox(text: string | null): { preface: string; entries: InboxEntry[] } {
  if (!text) return { preface: INBOX_HEADER, entries: [] };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const preface: string[] = [];
  const entries: InboxEntry[] = [];
  let current: (InboxEntry & { lines: string[] }) | null = null;
  const flush = (): void => {
    if (current) {
      entries.push({
        id: current.id,
        at: current.at,
        source: current.source,
        text: current.lines.join('\n').replace(/\s+$/, '').replace(/^\n+/, ''),
      });
    }
  };
  for (const line of lines) {
    const match = HEADER_RE.exec(line);
    if (match && INBOX_ID_RE.test(match[1] as string)) {
      flush();
      current = {
        id: match[1] as string,
        at: match[2] as string,
        source: match[3] as string,
        text: '',
        lines: [],
      };
    } else if (current) {
      current.lines.push(line.startsWith('\\## ib_') ? line.slice(1) : line);
    } else {
      preface.push(line);
    }
  }
  flush();
  const pre = preface.join('\n').replace(/\s+$/, '');
  return { preface: pre ? `${pre}\n` : INBOX_HEADER, entries };
}

export function serializeInbox(preface: string, entries: InboxEntry[]): string {
  let out = preface.replace(/\s+$/, '') + '\n';
  for (const entry of entries) {
    const body = entry.text
      .split('\n')
      .map((line) => (/^## ib_/.test(line) ? `\\${line}` : line))
      .join('\n');
    out += `\n## ${entry.id} | ${entry.at} | ${entry.source}\n\n${body}\n`;
  }
  return out;
}
