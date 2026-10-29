import TOML from '@iarna/toml';
import { requireInitialized, type Ctx, type WriteInput } from './context.ts';
import { invalid } from './errors.ts';
import { readHost } from './read.ts';
import { pruneSessions, readState, stringifyState, type SessionEntry } from './state.ts';
import { isoTime } from './util.ts';
import { runWrite } from './write.ts';

export interface ConfirmHostInput extends WriteInput {
  host: string;
  channel: 'hook' | 'mcp' | 'extension';
}

/** Record that a host loaded mwf (first hook / MCP call). Written to host.local.toml (gitignored). */
export async function confirmHost(ctx: Ctx, input: ConfirmHostInput) {
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(String(input.host))) throw invalid('invalid host name');
  if (!['hook', 'mcp', 'extension'].includes(input.channel)) throw invalid('invalid channel');
  const layout = requireInitialized(ctx);
  return runWrite<{ host: string; channel: string; changed: boolean }>(
    ctx,
    'confirm_host',
    input,
    { host: input.host, channel: input.channel },
    (env) => {
      const hosts = readHost(layout.hostLocal);
      if (hosts[input.host]?.[input.channel]) {
        return {
          targets: [],
          result: { host: input.host, channel: input.channel, changed: false },
        };
      }
      hosts[input.host] = { ...(hosts[input.host] ?? {}), [input.channel]: isoTime(env.now) };
      const content = TOML.stringify({ schema: 1, hosts } as unknown as TOML.JsonMap);
      return {
        targets: [{ path: 'host.local.toml', content }],
        result: { host: input.host, channel: input.channel, changed: true },
      };
    },
  );
}

export interface SessionInput extends WriteInput {
  session_id: string;
  handoff?: string;
  injected?: string[];
}

export function getSession(ctx: Ctx, sessionId: string): SessionEntry | null {
  const layout = requireInitialized(ctx);
  return readState(layout).sessions[sessionId] ?? null;
}

/** Update the session mapping (session -> current handoff task / ids already injected). */
export async function setSession(ctx: Ctx, input: SessionInput) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(input.session_id)))
    throw invalid('invalid session_id');
  const injected = input.injected?.map(String).slice(-200);
  return runWrite<{ session_id: string }>(
    ctx,
    'session.set',
    input,
    { s: input.session_id, h: input.handoff, i: injected },
    (env) => {
      const state = readState(env.layout);
      const prev = state.sessions[input.session_id];
      const next: SessionEntry = { updated: isoTime(env.now) };
      const handoff = input.handoff ?? prev?.handoff;
      const inj = injected ?? prev?.injected;
      if (handoff !== undefined) next.handoff = handoff;
      if (inj !== undefined) next.injected = inj;
      state.sessions[input.session_id] = next;
      pruneSessions(state);
      return {
        targets: [{ path: 'state.toml', content: stringifyState(state) }],
        result: { session_id: input.session_id },
      };
    },
  );
}
