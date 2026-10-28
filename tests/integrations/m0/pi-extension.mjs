import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export default function (pi) {
  const log = process.env.MWF_M0_LOG;
  const record = data => fs.appendFileSync(log, JSON.stringify(data) + '\n');
  const server = fileURLToPath(new URL('./mcp-probe.mjs', import.meta.url));
  let snapshot;
  record({ event: 'extension_load' });
  pi.on('session_start', (event, ctx) => {
    record({ event: event.type, reason: event.reason, cwd: ctx.cwd, trusted: ctx.isProjectTrusted(), session: ctx.sessionManager.getSessionId(), node: process.execPath });
    snapshot = undefined;
    if (ctx.isProjectTrusted()) {
      snapshot = fs.readFileSync(path.join(ctx.cwd, 'memory.txt'), 'utf8');
      record({ event: 'session_snapshot', at: Date.now(), marker: snapshot });
      pi.registerMcpServer('mwf_m0', { command: process.execPath, args: [server, log, process.env.MWF_M0_ROOT, process.env.MWF_M0_DELAY || '0'], exposure: 'direct' });
    }
  });
  pi.on('before_agent_start', (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    const marker = snapshot;
    record({ event: 'direct_read', session: ctx.sessionManager.getSessionId(), marker });
    return { message: { customType: 'mwf-m0', content: marker, display: false } };
  });
  pi.on('before_provider_request', event => {
    record({ event: 'provider_request', markerPresent: JSON.stringify(event.payload).includes('MWF_M0_MEMORY_V1') });
  });
  pi.registerCommand('m0-status', {
    description: 'Inspect synthetic M0 server registration',
    handler: async (_args, ctx) => record({ event: 'status', session: ctx.sessionManager.getSessionId(), registrations: pi.getMcpServers().map(s => s.name), tools: pi.getAllTools().map(t => t.name).filter(n => n.includes('mwf_m0')) }),
  });
  pi.registerCommand('m0-detach', {
    description: 'Remove only the synthetic M0 server',
    handler: async () => { pi.unregisterMcpServer('mwf_m0'); record({ event: 'unregistered' }); },
  });
  pi.registerCommand('m0-reload', { description: 'Reload the synthetic probe', handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.on('session_shutdown', event => { pi.unregisterMcpServer('mwf_m0'); record({ event: event.type, reason: event.reason }); });
}
