"""Run the installed Pi CLI against synthetic projects and a loopback model fixture."""
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

source = Path(__file__).resolve().parent
base = Path(tempfile.mkdtemp(prefix='mwf-m0-pi-')).resolve()
requests = []

class Endpoint(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append({'marker': 'MWF_M0_MEMORY_V1' in json.dumps(payload),
                         'tools': [t['function']['name'] for t in payload.get('tools', [])]})
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for delta, reason in [({'role': 'assistant', 'content': 'fixture response'}, None), ({}, 'stop')]:
            event = {'id': 'm0', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'm0',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
            self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')

server = ThreadingHTTPServer(('127.0.0.1', 0), Endpoint)
threading.Thread(target=server.serve_forever, daemon=True).start()
agent = base / 'agent'; agent.mkdir()
package = base / 'package'; package.mkdir()
for name in ['pi-extension.mjs', 'mcp-probe.mjs']:
    shutil.copy(source / name, package / name)
(package / 'package.json').write_text(json.dumps({'name': 'mwf-m0-probe', 'version': '0.0.0', 'type': 'module', 'pi': {'extensions': ['./pi-extension.mjs']}}))
(agent / 'models.json').write_text(json.dumps({'providers': {'m0': {'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'api': 'openai-completions', 'apiKey': 'synthetic', 'models': [{'id': 'm0', 'contextWindow': 32000, 'maxTokens': 100}]}}}))
project = base / '项目 A'; project.mkdir()
(project / 'memory.txt').write_text('MWF_M0_MEMORY_V1')
env = {k: v for k, v in os.environ.items() if k in ['PATH', 'HOME', 'TMPDIR', 'LANG']}
env.update(PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE='1', PI_TELEMETRY='0')
subprocess.run(['pi', 'install', str(package), '--local'], cwd=project, env=env, check=True, capture_output=True)
copy = base / '项目 B'; shutil.copytree(project, copy)

class Session:
    def __init__(self, root, trust=True, delay=0):
        self.log = base / f'events-{time.time_ns()}.jsonl'
        self.err = open(base / f'stderr-{time.time_ns()}.log', 'w')
        self.p = subprocess.Popen(['pi', '--mode', 'rpc', '--offline', '--approve' if trust else '--no-approve', '--provider', 'm0', '--model', 'm0', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes'], cwd=root,
            env={**env, 'MWF_M0_LOG': str(self.log), 'MWF_M0_ROOT': str(project), 'MWF_M0_DELAY': str(delay)}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.err, text=True)
        self.q = queue.Queue()
        threading.Thread(target=lambda: [self.q.put(json.loads(line)) for line in self.p.stdout], daemon=True).start()
        self.call('get_state')

    def call(self, kind, **args):
        ident = str(time.time_ns())
        self.p.stdin.write(json.dumps({'id': ident, 'type': kind, **args}) + '\n'); self.p.stdin.flush()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            msg = self.q.get(timeout=max(.1, deadline - time.monotonic()))
            if msg.get('id') == ident:
                assert msg.get('success'), msg
                return msg.get('data')
        raise TimeoutError(kind)

    def events(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def wait_event(self, event, predicate=lambda row: True):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            rows = [r for r in self.events() if r['event'] == event and predicate(r)]
            if rows: return rows[-1]
            time.sleep(.1)
        raise AssertionError((event, self.events()))

    def close(self):
        self.p.terminate()
        try: self.p.wait(timeout=10)
        except subprocess.TimeoutExpired: self.p.kill(); self.p.wait()
        self.err.close()

sessions = []
try:
    trusted = Session(project); sessions.append(trusted)
    first = trusted.wait_event('session_start')
    assert first['trusted'] and first['cwd'] == str(project)
    trusted.wait_event('mcp_start', lambda r: r['allowed'])
    time.sleep(1)
    trusted.call('prompt', message='/m0-status')
    status = trusted.wait_event('status')
    assert status['registrations'] == ['mwf_m0']
    assert 'mcp__mwf_m0__status' in status['tools']
    trusted.call('prompt', message='Synthetic M0 request')
    trusted.wait_event('provider_request', lambda r: r['markerPresent'])
    deadline = time.monotonic() + 10
    while not requests and time.monotonic() < deadline: time.sleep(.1)
    assert requests and requests[-1]['marker']
    time.sleep(.5)
    trusted.call('prompt', message='/m0-detach')
    trusted.wait_event('unregistered')
    trusted.call('prompt', message='/m0-status')
    trusted.wait_event('status', lambda r: not r['registrations'])
    trusted.call('prompt', message='Synthetic request after unregister')
    deadline = time.monotonic() + 10
    while len(requests) < 2 and time.monotonic() < deadline: time.sleep(.1)
    assert len(requests) >= 2
    assert 'mcp__mwf_m0__status' not in requests[-1]['tools'], requests[-1]
    time.sleep(.5)
    trusted.call('new_session')
    replacement = trusted.wait_event('session_start', lambda r: r['session'] != first['session'])
    assert replacement['trusted']
    old_loads = sum(e['event'] == 'extension_load' for e in trusted.events())
    trusted.call('prompt', message='/m0-reload')
    deadline = time.monotonic() + 10
    while sum(e['event'] == 'extension_load' for e in trusted.events()) <= old_loads and time.monotonic() < deadline: time.sleep(.1)
    assert sum(e['event'] == 'extension_load' for e in trusted.events()) == old_loads + 1
    untrusted = Session(project, trust=False); sessions.append(untrusted)
    time.sleep(.5)
    assert not untrusted.events(), untrusted.events()
    copied = Session(copy); sessions.append(copied)
    rejected = copied.wait_event('mcp_start')
    assert rejected['cwd'] == str(copy) and not rejected['allowed']
    delayed = Session(project, delay=10000); sessions.append(delayed)
    begin = time.monotonic()
    delayed.call('prompt', message='Synthetic request while MCP initializes')
    delayed.wait_event('direct_read')
    elapsed = time.monotonic() - begin
    snapshot = delayed.wait_event('session_snapshot')
    ready = delayed.wait_event('mcp_ready')
    assert ready['at'] - snapshot['at'] >= 9000
    assert not any(project.rglob('AGENTS.md'))
    assert not any(project.rglob('CLAUDE.md'))
    # Native mcp.json overrides the extension registration with the same name.
    override_log = base / 'override.jsonl'
    override_config = {'mcpServers': {'mwf_m0': {'command': shutil.which('node'), 'args': [str(package / 'mcp-probe.mjs'), str(override_log), str(project)], 'exposure': 'direct'}}}
    (agent / 'mcp.json').write_text(json.dumps(override_config))
    overridden = Session(project); sessions.append(overridden)
    deadline = time.monotonic() + 10
    while not override_log.exists() and time.monotonic() < deadline: time.sleep(.1)
    assert override_log.exists()
    assert not any(e['event'] == 'mcp_start' for e in overridden.events())
    project_override_log = base / 'project-override.jsonl'
    override_config['mcpServers']['mwf_m0']['args'][1] = str(project_override_log)
    (project / '.pi/mcp.json').write_text(json.dumps(override_config))
    project_overridden = Session(project); sessions.append(project_overridden)
    deadline = time.monotonic() + 10
    while not project_override_log.exists() and time.monotonic() < deadline: time.sleep(.1)
    assert project_override_log.exists()
    assert not any(e['event'] == 'mcp_start' for e in project_overridden.events())
    summary = {'pi_version': subprocess.check_output(['pi', '--version'], text=True).strip(),
               'package_discovery': True, 'trusted_session': True, 'untrusted_skipped': True,
               'native_mcp': True, 'unregistered_tool_not_in_next_request': True,
               'session_replaced': True, 'reload_discovered_again': True,
               'user_and_project_config_override_registration': True, 'copied_project_rejected': True,
               'before_agent_start_delay_seconds': round(elapsed, 3),
               'session_snapshot_before_mcp_ready_ms': ready['at'] - snapshot['at'],
               'loopback_request_contains_memory': True,
               'endpoint': 'synthetic loopback, no live model', 'evidence_dir': str(base)}
    (base / 'requests.json').write_text(json.dumps(requests, indent=2))
    (base / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
finally:
    for session in sessions: session.close()
    server.shutdown(); server.server_close()
