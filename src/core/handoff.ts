import { requireInitialized, type Ctx, type WriteInput } from './context.ts';
import { listNodes } from './db.ts';
import { invalid, MwfError } from './errors.ts';
import { handoffRelPath } from './paths.ts';
import {
  parseHandoff,
  serializeHandoff,
  validateBody,
  validateStatus,
  validateTask,
  type HandoffDoc,
  type Status,
} from './records.ts';
import { runWrite, readFileText, withIndexRead } from './write.ts';
import { isoTime, oneLine, sha256 } from './util.ts';

export interface HandoffView {
  task: string;
  status: Status;
  version: number;
  updated: string;
  summary: string;
  body: string;
  hash: string;
  path: string;
}

export interface HandoffListItem {
  task: string;
  status: Status;
  version: number;
  updated: string;
  summary: string;
}

function view(doc: HandoffDoc, text: string, rel: string): HandoffView {
  return {
    task: doc.task,
    status: doc.status,
    version: doc.version,
    updated: doc.updated,
    summary: doc.summary,
    body: doc.body,
    hash: sha256(Buffer.from(text, 'utf8')),
    path: `.mwf/${rel}`,
  };
}

/** Read one handoff's full text from its file. */
export function readHandoffFile(ctx: Ctx, taskInput: string): HandoffView {
  const layout = requireInitialized(ctx);
  const task = validateTask(taskInput);
  const rel = handoffRelPath(task);
  const text = readFileText(layout, rel);
  if (text === null) throw new MwfError('NOT_FOUND', `no handoff for task ${task}`, { task });
  try {
    return view(parseHandoff(text, task), text, rel);
  } catch (error) {
    throw invalid(`handoff ${task} is malformed: ${(error as Error).message}`);
  }
}

/** Handoff index (task, last update, one-line status), open ones by default. */
export async function listHandoffs(
  ctx: Ctx,
  opts: { status?: Status | 'all' } = {},
): Promise<{ items: HandoffListItem[]; warnings: string[] }> {
  return withIndexRead(ctx, ({ db, warnings }) => {
    const status = opts.status === 'all' ? undefined : (opts.status ?? 'active');
    const items = listNodes(db, { kind: 'handoff', status }).map((n) => ({
      task: n.id,
      status: n.status,
      version: n.version,
      updated: n.updated,
      summary: n.summary,
    }));
    return { items, warnings };
  });
}

export type HandoffInput =
  | { action: 'read'; task?: string; status?: Status | 'all' }
  | ({
      action: 'save';
      task: string;
      content: string;
      summary?: string;
      base_version?: number;
      status?: Status;
    } & WriteInput);

export interface HandoffSaveResult {
  task: string;
  version: number;
  status: Status;
  /** True when the version check failed and the content was appended as a 「并行更新」 section. */
  conflict: boolean;
  hash: string;
  path: string;
}

/** handoff read|save. Save = lock + version check; conflicts append a section, never overwrite. */
export async function handoff(
  ctx: Ctx,
  input: HandoffInput,
): Promise<
  | HandoffView
  | { items: HandoffListItem[]; warnings: string[] }
  | (HandoffSaveResult & { request_id: string; deduped: boolean })
> {
  if (input.action === 'read') {
    if (input.task !== undefined) return readHandoffFile(ctx, input.task);
    return listHandoffs(ctx, input.status === undefined ? {} : { status: input.status });
  }
  if (input.action !== 'save') throw invalid("action must be 'read' or 'save'");
  const task = validateTask(input.task);
  const content = validateBody(input.content);
  if (!content.trim()) throw invalid('content is required');
  const summary = input.summary === undefined ? undefined : oneLine(String(input.summary), 200);
  const status = input.status === undefined ? undefined : validateStatus(input.status);
  const base = input.base_version;
  if (base !== undefined && (!Number.isInteger(base) || base < 0))
    throw invalid('base_version must be a non-negative integer');
  const rel = handoffRelPath(task);
  return runWrite<HandoffSaveResult>(
    ctx,
    'handoff.save',
    input,
    { task, content, summary, base, status },
    (env) => {
      const text = readFileText(env.layout, rel);
      const stamp = isoTime(env.now);
      let doc: HandoffDoc;
      let conflict = false;
      if (text === null) {
        doc = {
          task,
          status: status ?? 'active',
          version: 1,
          updated: stamp,
          summary: summary ?? '',
          extra: [],
          body: content,
        };
      } else {
        const cur = parseHandoff(text, task);
        if (base === cur.version) {
          doc = {
            ...cur,
            status: status ?? 'active',
            version: cur.version + 1,
            updated: stamp,
            summary: summary ?? cur.summary,
            body: content,
          };
        } else {
          conflict = true;
          const heading = `## 并行更新（${stamp}，基于 v${base ?? '未提供'}，当前 v${cur.version}）`;
          doc = {
            ...cur,
            status: status ?? cur.status,
            version: cur.version + 1,
            updated: stamp,
            summary: summary ?? cur.summary,
            body: `${cur.body}\n\n${heading}\n\n${content.trim()}`,
          };
        }
      }
      const out = serializeHandoff(doc);
      return {
        targets: [{ path: rel, content: out }],
        result: {
          task,
          version: doc.version,
          status: doc.status,
          conflict,
          hash: sha256(out),
          path: `.mwf/${rel}`,
        },
      };
    },
  );
}
