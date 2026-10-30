import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ENTRY, renderForHost, skillByName } from '../skills/index.ts';
import {
  callTool,
  confirmHost,
  getSession,
  setSession,
  type CliEnv,
  type CliResult,
} from '../mcp/index.ts';
import { HOOK_LOCK_WAIT_MS, HOOK_SOFT_MS, PROMPT_CHARS, SESSION_START_CHARS } from './budget.ts';
import { clean, fence, newNonce, oneLine } from './fence.ts';
import { FAILURE_NOTICE, UNINITIALIZED_NOTICE } from './messages.ts';

/**
 * The host-independent hook logic: what to inject at session start, on each user message and at the
 * end of a turn. Host adapters (./codex.ts, the Pi extension of a later PR) parse the host's input
 * and format what comes back.
 *
 * Rules every handler follows:
 *  - it never throws: any failure becomes the one-line FAILURE_NOTICE (session start / prompt) or
 *    nothing at all (stop), so a hook can never block the host;
 *  - it needs no terminal and never calls anything that executes a destructive operation;
 *  - locks are waited for only HOOK_LOCK_WAIT_MS: a busy lock means "read the existing index" for a
 *    read and "give up" for a write;
 *  - optional bookkeeping writes are returned as `after`, to run once the answer has been sent.
 */

export interface HookContext {
  /** The session's working directory; the project is looked up from here. */
  cwd: string;
  /** Host session id (absent or invalid: no session bookkeeping). */
  session_id?: string;
  /** Host name for registration (`codex`, `claude`, `pi`); `claude` also renders tool names as `mcp__mwf__…`. */
  host: string;
  /** Test seams. */
  nonce?: () => string;
  now?: () => number;
  /** Epoch ms the run started; `after` skips its writes once HOOK_SOFT_MS has passed. */
  started?: number;
}

export interface HookResult {
  /** Text for the model (session start / prompt). */
  inject?: string;
  /** One line for the user. */
  notice?: string;
  /** Stop only: continue the turn with this as the next prompt. */
  block?: string;
  /** Optional bookkeeping, run after the result has been delivered; failures are ignored. */
  after?: () => Promise<void>;
}

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TASK_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u;

function hookEnv(hc: HookContext): CliEnv {
  return { cwd: hc.cwd, ctx: { waitMs: HOOK_LOCK_WAIT_MS } };
}

function validSession(hc: HookContext): string | null {
  return hc.session_id !== undefined && SESSION_RE.test(hc.session_id) ? hc.session_id : null;
}

type Called = { ok: true; data: Record<string, any> } | { ok: false; code: string };

/** A tool called in-process; the answer is its structured envelope. Never throws. */
async function tool(name: string, args: Record<string, unknown>, env: CliEnv): Promise<Called> {
  try {
    const result = await callTool(name, args, env);
    const envelope = result.structuredContent;
    return envelope.ok
      ? { ok: true, data: (envelope.data ?? {}) as Record<string, any> }
      : { ok: false, code: envelope.error.code };
  } catch {
    return { ok: false, code: 'INTERNAL' };
  }
}

function resultOf(result: CliResult): Called {
  return result.ok
    ? { ok: true, data: (result.data ?? {}) as Record<string, any> }
    : { ok: false, code: result.error.code };
}

/** Inside a git work tree (a `.git` entry in cwd or any parent). */
export function inGitRepo(cwd: string): boolean {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function withinSoftBudget(hc: HookContext): boolean {
  if (hc.started === undefined) return true;
  return (hc.now ?? Date.now)() - hc.started < HOOK_SOFT_MS;
}

const keyOf = (hit: { id: string; hash: string }): string => `${hit.id}:${hit.hash.slice(0, 8)}`;

// ---- session start ---------------------------------------------------------------------------

export async function sessionStart(
  input: { source?: string },
  hc: HookContext,
): Promise<HookResult> {
  try {
    // The host's own compaction is trusted; nothing is re-injected after it.
    if (input.source === 'compact') return {};
    const env = hookEnv(hc);
    const r = (ours: string): string => renderForHost(ours, hc.host);
    const boot = await tool('mwf_bootstrap', { max_entries: 40 }, env);
    if (!boot.ok) {
      if (boot.code === 'NOT_INITIALIZED') {
        return inGitRepo(hc.cwd) ? { notice: UNINITIALIZED_NOTICE } : {};
      }
      return { notice: FAILURE_NOTICE };
    }
    const data = boot.data;
    const entries: Array<{ id: string; type: string; title: string }> =
      data['memory']?.entries ?? [];
    const counts: Record<string, number> = data['memory']?.counts ?? {};
    const open: Array<{ task: string; updated: string; summary: string }> =
      data['handoffs']?.open ?? [];
    const full: { task: string; body: string } | null = data['handoffs']?.full ?? null;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    const lines: string[] = [];
    lines.push(
      `Memory: ${total} active records` +
        (total
          ? ` (${Object.entries(counts)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')})`
          : ''),
    );
    for (const e of entries) lines.push(`- [${e.type}] ${e.id}: ${e.title}`);
    if (data['memory']?.truncated)
      lines.push(r('- … more records exist; use mwf_recall to search them.'));
    if (open.length) {
      lines.push('', `Open handoffs (${open.length}):`);
      for (const h of open) lines.push(`- ${h.task} (updated ${h.updated}): ${h.summary}`);
    }
    if (full) lines.push('', `Handoff "${full.task}" in full:`, full.body);
    const block = fence(
      'Overview of this project’s stored memory.',
      lines,
      SESSION_START_CHARS,
      (hc.nonce ?? newNonce)(),
      r,
    );
    const parts = [r(ENTRY), '', block.text];
    const trashNote = data['trash']?.note;
    if (typeof trashNote === 'string' && trashNote) parts.push('', r(oneLine(trashNote, 200)));
    const warnings: unknown[] = Array.isArray(data['warnings']) ? data['warnings'] : [];
    for (const w of warnings.slice(0, 3))
      parts.push('', r(`mwf warning: ${oneLine(String(w), 200)}`));

    const session = validSession(hc);
    const startsFresh = input.source !== 'resume';
    const handoffTask = open.length === 1 ? open[0]!.task : undefined;
    return {
      inject: parts.join('\n'),
      after: async () => {
        if (!withinSoftBudget(hc)) return;
        await confirmHost({ host: hc.host, channel: 'hook' }, env).catch(() => undefined);
        if (session === null || !withinSoftBudget(hc)) return;
        await setSession(
          {
            session_id: session,
            ...(startsFresh ? { injected: [] } : {}),
            ...(handoffTask !== undefined && TASK_NAME_RE.test(handoffTask)
              ? { handoff: handoffTask }
              : {}),
            wait_ms: HOOK_LOCK_WAIT_MS,
          },
          env,
        ).catch(() => undefined);
      },
    };
  } catch {
    return { notice: FAILURE_NOTICE };
  }
}

// ---- user prompt -----------------------------------------------------------------------------

const MIN_PROMPT_CHARS = 4;
const MAX_QUERY_CHARS = 1_000;

export async function userPrompt(input: { prompt?: string }, hc: HookContext): Promise<HookResult> {
  try {
    const prompt = typeof input.prompt === 'string' ? clean(input.prompt).trim() : '';
    if (Array.from(prompt).length < MIN_PROMPT_CHARS) return {};
    const env = hookEnv(hc);
    const found = await tool(
      'mwf_recall',
      {
        query: Array.from(prompt).slice(0, MAX_QUERY_CHARS).join(''),
        limit: 5,
        max_chars: 2_500,
      },
      env,
    );
    if (!found.ok) return found.code === 'NOT_INITIALIZED' ? {} : { notice: FAILURE_NOTICE };
    const hits: Array<{
      id: string;
      hash: string;
      type: string | null;
      title: string;
      snippet: string;
      updated: string;
    }> = found.data['hits'] ?? [];

    const session = validSession(hc);
    let already: string[] = [];
    if (session !== null) {
      const entry = resultOf(await getSession(session, env));
      if (entry.ok) already = entry.data['session']?.injected ?? [];
    }
    const seen = new Set(already);
    const fresh = hits.filter((h) => !seen.has(keyOf(h)));
    if (!fresh.length) return {};
    const block = fence(
      'Stored memory that matches this message (for your information).',
      fresh.map((h) => `- [${h.type ?? 'record'}] ${h.id}: ${h.title}: ${h.snippet}`),
      PROMPT_CHARS,
      (hc.nonce ?? newNonce)(),
      (ours) => renderForHost(ours, hc.host),
    );
    return {
      inject: block.text,
      after: async () => {
        if (session === null || !withinSoftBudget(hc)) return;
        await setSession(
          {
            session_id: session,
            injected: [...already, ...fresh.map(keyOf)],
            wait_ms: HOOK_LOCK_WAIT_MS,
          },
          env,
        ).catch(() => undefined);
      },
    };
  } catch {
    return { notice: FAILURE_NOTICE };
  }
}

// ---- stop ------------------------------------------------------------------------------------

/**
 * Turn key: derived from the host's turn id (Codex `turn_id`), else the prompt id (Claude Code
 * `prompt_id`, which Claude Code's Stop input has instead of a turn id), else the last message.
 */
export function turnKey(
  sessionId: string,
  input: { turn_id?: unknown; prompt_id?: unknown; last_assistant_message?: unknown },
): string | null {
  const source =
    typeof input.turn_id === 'string' && input.turn_id
      ? ['t', input.turn_id]
      : typeof input.prompt_id === 'string' && input.prompt_id
        ? ['p', input.prompt_id]
        : typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()
          ? ['m', input.last_assistant_message]
          : null;
  if (source === null) return null;
  return createHash('sha256')
    .update(JSON.stringify([sessionId, ...source]))
    .digest('hex')
    .slice(0, 24);
}

function stopReason(handoffTask: string | undefined, host: string): string {
  const handoff = skillByName('mwf-handoff')!;
  const save = skillByName('mwf-save')!;
  const text = [
    'mwf end-of-turn check (once per turn, then you may finish).',
    '1. If this turn changed files or moved a task forward, follow the mwf-handoff skill below' +
      (handoffTask ? ` (this session continues the task "${handoffTask}")` : '') +
      '.',
    '2. If this turn produced something reusable (a preference, decision, pitfall, task or piece of knowledge), follow the mwf-save skill below.',
    '3. If neither applies, reply with only "mwf: nothing to save" and stop. Do not mention this check otherwise.',
    '',
    `## Skill: ${handoff.name}`,
    handoff.body,
    `## Skill: ${save.name}`,
    save.body,
  ].join('\n');
  return renderForHost(text, host);
}

/**
 * End of turn: ask the agent, once per turn, to save a handoff / memory. Anti-loop: BOTH the host's
 * `stop_hook_active` must be explicitly false AND the turn must be claimed in state.toml (an
 * atomic check-and-set under the project lock). If either cannot be established (flag absent, no
 * session id, state.toml unreadable or malformed, lock busy) the stop is allowed, with no
 * continuation. Nothing is shown to the user on failure.
 */
export async function stop(
  input: {
    stop_hook_active?: unknown;
    turn_id?: unknown;
    prompt_id?: unknown;
    last_assistant_message?: unknown;
  },
  hc: HookContext,
): Promise<HookResult> {
  try {
    if (input.stop_hook_active !== false) return {};
    const session = validSession(hc);
    if (session === null) return {};
    const key = turnKey(session, input);
    if (key === null) return {};
    const env = hookEnv(hc);
    const status = await tool('mwf_status', {}, env);
    if (!status.ok || status.data['hooks']?.stop === false) return {};
    const entry = resultOf(await getSession(session, env));
    if (!entry.ok) return {};
    const known = entry.data['session'] as { handoff?: string; stop_turn?: string } | null;
    if (known?.stop_turn === key) return {};
    const claim = resultOf(
      await setSession(
        { session_id: session, stop_turn: key, claim_stop_turn: true, wait_ms: HOOK_LOCK_WAIT_MS },
        env,
      ),
    );
    if (!claim.ok || claim.data['claimed'] !== true) return {};
    const task =
      typeof known?.handoff === 'string' && TASK_NAME_RE.test(known.handoff)
        ? known.handoff
        : undefined;
    return { block: stopReason(task, hc.host) };
  } catch {
    return {};
  }
}
