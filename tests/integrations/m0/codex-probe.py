"""Probe a supplied Codex binary in an isolated home; never touch the active app config."""
import json
import os
import queue
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

source = Path(__file__).resolve().parent
base = Path(tempfile.mkdtemp(prefix='mwf-m0-codex-')).resolve()
binary = sys.argv[1]
requests = []

class Endpoint(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append({'path': self.path, 'marker': 'MWF_M0_MEMORY_V1' in json.dumps(payload), 'at': time.time()})
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        message = {'id': 'msg_m0', 'type': 'message', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': 'fixture response', 'annotations': []}]}
        response = {'id': 'resp_m0', 'object': 'response', 'created_at': 0, 'status': 'completed', 'model': 'm0', 'output': [message], 'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
        events = [
            {'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
            {'type': 'response.output_item.added', 'output_index': 0, 'item': {**message, 'status': 'in_progress', 'content': []}},
            {'type': 'response.output_text.delta', 'item_id': 'msg_m0', 'output_index': 0, 'content_index': 0, 'delta': 'fixture response'},
            {'type': 'response.output_item.done', 'output_index': 0, 'item': message},
            {'type': 'response.completed', 'response': response},
        ]
        for event in events:
            self.wfile.write(('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n').encode())

server = ThreadingHTTPServer(('127.0.0.1', 0), Endpoint)
threading.Thread(target=server.serve_forever, daemon=True).start()
home = base / 'home'; home.mkdir()
market = base / 'market'; (market / '.agents/plugins').mkdir(parents=True)
plugin = market / 'probe'; (plugin / 'hooks').mkdir(parents=True)
project = base / '项目 A'; (project / '.codex').mkdir(parents=True)
(project / 'memory.txt').write_text('MWF_M0_MEMORY_V1')
shutil.copy(source / 'codex-hook.mjs', plugin / 'hook.mjs')
shutil.copy(source / 'mcp-probe.mjs', plugin / 'mcp-probe.mjs')
(plugin / 'plugin.json').write_text(json.dumps({'name': 'mwf-m0-probe', 'version': '0.0.0', 'description': 'Synthetic M0 probe', 'extensions': {'com.openai': {'hooks': './hooks/hooks.json'}}}))
(plugin / 'hooks/hooks.json').write_text(json.dumps({'hooks': {event: [{'hooks': [{'type': 'command', 'command': 'node "${PLUGIN_ROOT}/hook.mjs"', 'timeout': 5}]}] for event in ['SessionStart', 'UserPromptSubmit']}}))
(market / '.agents/plugins/marketplace.json').write_text(json.dumps({'name': 'mwf-m0', 'plugins': [{'name': 'mwf-m0-probe', 'source': {'source': 'local', 'path': './probe'}, 'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_INSTALL'}, 'category': 'Developer Tools'}]}))
env = {k: v for k, v in os.environ.items() if k in ['PATH', 'HOME', 'TMPDIR', 'LANG']}
env['CODEX_HOME'] = str(home)
(home / 'config.toml').write_text(f'''model = "m0"
model_provider = "m0"
[model_providers.m0]
name = "M0 loopback fixture"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
''')

def command(args, root=project, timeout=45):
    result = subprocess.run([binary, *args], cwd=root, env=env, capture_output=True, text=True, timeout=timeout)
    return result

try:
    for args in [['plugin', 'marketplace', 'add', str(market), '--json'], ['plugin', 'add', 'mwf-m0-probe@mwf-m0', '--json']]:
        result = command(args)
        assert result.returncode == 0, (result.stdout, result.stderr)
    # Trust only these reviewed synthetic fixtures for this invocation, using the documented flag.
    args = ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '--sandbox', 'read-only', '-C', str(project), 'Synthetic M0 request; answer briefly.']
    untrusted = command(args)
    (base / 'untrusted.log').write_text(untrusted.stdout + untrusted.stderr)
    assert untrusted.returncode == 0, untrusted.stderr
    assert not (project / 'hook-events.jsonl').exists()
    assert requests and not requests[-1]['marker']
    trusted = command([*args[:-1], '--dangerously-bypass-hook-trust', args[-1]])
    (base / 'trusted.log').write_text(trusted.stdout + trusted.stderr)
    assert trusted.returncode == 0, trusted.stderr
    events = [json.loads(line) for line in (project / 'hook-events.jsonl').read_text().splitlines()]
    assert {'SessionStart', 'UserPromptSubmit'} <= {e['event'] for e in events}
    assert len({e['session'] for e in events}) == 1
    assert requests[-1]['marker']
    # Host must choose cwd; neither project configuration nor MCP launch arguments set it.
    log = base / 'mcp-events.jsonl'
    (project / '.codex/config.toml').write_text('[mcp_servers.mwf_m0]\ncommand = ' + json.dumps(shutil.which('node')) + '\nargs = ' + json.dumps([str(plugin / 'mcp-probe.mjs'), str(log), str(project), '10000']) + '\nstartup_timeout_sec = 15\n')
    copied = base / '项目 B'; shutil.copytree(project, copied)
    (copied / 'hook-events.jsonl').unlink()
    with (home / 'config.toml').open('a') as config:
        for root in [project, copied]: config.write('\n[projects.' + json.dumps(str(root)) + ']\ntrust_level = "trusted"\n')
    before = len(requests)
    copied_args = [str(copied) if a == str(project) else a for a in args]
    result = command(copied_args)
    (base / 'copied.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stderr
    starts = [json.loads(line) for line in log.read_text().splitlines()]
    rejected = next(e for e in starts if e['event'] == 'mcp_start')
    assert rejected['cwd'] == str(copied) and not rejected['allowed'], rejected
    assert not (copied / 'hook-events.jsonl').exists()
    # Run trusted A with slow MCP to measure actual SessionStart ordering.
    (project / 'hook-events.jsonl').unlink()
    result = command([*args[:-1], '--dangerously-bypass-hook-trust', args[-1]])
    (base / 'delayed.log').write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stderr
    events = [json.loads(line) for line in (project / 'hook-events.jsonl').read_text().splitlines()]
    starts = [json.loads(line) for line in log.read_text().splitlines()]
    start_hook = next(e for e in events if e['event'] == 'SessionStart')
    mcp_start = [e for e in starts if e['event'] == 'mcp_start'][-1]
    request_delay = requests[-1]['at'] * 1000 - mcp_start['at']
    assert request_delay < 9000, request_delay
    assert not any(e['event'] == 'mcp_ready' for e in starts)
    assert requests[-1]['marker']
    # Exercise the app-server MCP call API after a normal zero-delay handshake.
    config_path = project / '.codex/config.toml'
    config_path.write_text(config_path.read_text().replace('"10000"', '"0"'))
    app = subprocess.Popen([binary, 'app-server', '--stdio'], cwd=project, env=env,
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=open(base / 'app-server.log', 'w'), text=True)
    inbox = queue.Queue()
    threading.Thread(target=lambda: [inbox.put(json.loads(line)) for line in app.stdout], daemon=True).start()
    def rpc(method, params):
        ident = str(time.time_ns())
        app.stdin.write(json.dumps({'id': ident, 'method': method, 'params': params}) + '\n'); app.stdin.flush()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            value = inbox.get(timeout=max(.1, deadline - time.monotonic()))
            if value.get('id') == ident: return value
        raise TimeoutError(method)
    try:
        initialized = rpc('initialize', {'clientInfo': {'name': 'mwf_m0', 'version': '0.0.0'}, 'capabilities': {'experimentalApi': True, 'requestAttestation': False}})
        assert 'result' in initialized, initialized
        app.stdin.write('{"method":"initialized"}\n'); app.stdin.flush()
        hooks = rpc('hooks/list', {'cwds': [str(project)]})
        metadata = hooks['result']['data'][0]['hooks']
        assert len(metadata) == 2 and all(h['trustStatus'] == 'untrusted' for h in metadata)
        (base / 'hooks.json').write_text(json.dumps(hooks, indent=2))
        started = rpc('thread/start', {'cwd': str(project), 'ephemeral': True, 'approvalPolicy': 'never', 'sandbox': 'read-only'})
        thread = started['result']['thread']['id']
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            called = rpc('mcpServer/tool/call', {'threadId': thread, 'server': 'mwf_m0', 'tool': 'status', 'arguments': {}})
            if 'result' in called: break
            time.sleep(.2)
        (base / 'mcp-call.json').write_text(json.dumps(called, indent=2))
        assert 'result' in called and 'ROOT_MISMATCH' not in json.dumps(called), called
        assert json.loads(called['result']['content'][0]['text']) == {'allowed': True, 'cwd': str(project), 'code': 'OK'}, called
    finally:
        app.terminate()
        try: app.wait(timeout=10)
        except subprocess.TimeoutExpired: app.kill(); app.wait()
    summary = {'binary_version': command(['--version']).stdout.strip(), 'normal_plugin_install': True, 'app_server_mcp_call': True,
               'untrusted_hooks_skipped': True, 'reviewed_fixture_one_off_trust': True,
               'session_and_prompt_hooks': True, 'session_id_consistent': True,
               'loopback_request_contains_memory': True, 'copied_project_cwd_rejected_before_hook': True,
               'request_before_10s_mcp_ready_ms': round(request_delay),
               'mcp_ready_before_exit': False,
               'gui_workflow': 'not_run', 'endpoint': 'synthetic loopback, no live model', 'evidence_dir': str(base)}
    (base / 'requests.json').write_text(json.dumps(requests, indent=2))
    (base / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))
finally:
    server.shutdown(); server.server_close()
