"""Real baseline memory + native Codex MCP calls; isolated temporary fixtures only."""
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time

binary, baseline = sys.argv[1:3]
baseline = Path(baseline).resolve()
source = Path(__file__).resolve().parent
base = Path(tempfile.mkdtemp(prefix='mwf-m0-binding-')).resolve()
node = shutil.which('node')
a = base / '项目 A'; a.mkdir()
subprocess.run(['git', 'init', '--quiet', str(a)], check=True)
home = base / 'home'; home.mkdir()

def core(op, root, **kwargs):
    script = 'import {execute} from ' + json.dumps((baseline / 'dist/core.js').as_uri()) + '; console.log(JSON.stringify(execute(process.argv[1],JSON.parse(process.argv[2]))));'
    result = subprocess.run([node, '--input-type=module', '-e', script, op, json.dumps({'project_root': str(root), **kwargs})], capture_output=True, text=True, check=True)
    assert json.loads(result.stdout)['ok']

core('init', a, git_mode='ignore')
core('add', a, type='knowledge', title='M0 committed memory', summary='M0_READ_SENTINEL', body='M0_READ_SENTINEL')
receipt = {'receipt_version': 2, 'canonical_root': str(a), 'clients': {'codex': {'enabled': True, 'binding_generation': 'm0-generation'}}}
def save_receipt():
    (a / '.mwf/local/integration.json').write_text(json.dumps(receipt))
save_receipt()
(a / '.codex').mkdir()
(a / '.codex/config.toml').write_text('[mcp_servers.mwf_m0]\ncommand = ' + json.dumps(node) + '\nargs = ' + json.dumps([str(source / 'binding-gateway.mjs'), str(baseline), str(a), 'm0-generation']) + '\n')
b = base / '项目 B'; shutil.copytree(a, b)
child = a / 'nested child'; child.mkdir(); core('init', child, git_mode='ignore')
subdir = a / 'subdir'; subdir.mkdir()
(home / 'config.toml').write_text('''model = "m0"
model_provider = "m0"
[model_providers.m0]
name = "No model used"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
''' + '\n'.join('[projects.' + json.dumps(str(root)) + ']\ntrust_level = "trusted"' for root in [a, b, child]))
env = {k: v for k, v in os.environ.items() if k in ['PATH', 'HOME', 'TMPDIR', 'LANG']}
env['CODEX_HOME'] = str(home)

def snapshot():
    return {str(p.relative_to(base)): hashlib.sha256(p.read_bytes()).hexdigest()
            for root in [a, b] for p in sorted(root.rglob('*')) if p.is_file()}

with (base / 'app-server.log').open('w') as err:
    app = subprocess.Popen([binary, 'app-server', '--stdio'], cwd=base, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, text=True)
    inbox = queue.Queue()
    threading.Thread(target=lambda: [inbox.put(json.loads(line)) for line in app.stdout], daemon=True).start()
    def rpc(method, params):
        ident = str(time.time_ns())
        app.stdin.write(json.dumps({'id': ident, 'method': method, 'params': params}) + '\n'); app.stdin.flush()
        deadline = time.monotonic() + 25
        while True:
            value = inbox.get(timeout=max(.01, deadline - time.monotonic()))
            if value.get('id') == ident: return value
    def start(root):
        response = rpc('thread/start', {'cwd': str(root), 'ephemeral': True, 'approvalPolicy': 'never', 'sandbox': 'read-only'})
        assert 'result' in response, response
        return response['result']['thread']['id']
    def call(thread, operation):
        deadline = time.monotonic() + 15
        while True:
            response = rpc('mcpServer/tool/call', {'threadId': thread, 'server': 'mwf_m0', 'tool': operation, 'arguments': {}})
            if 'result' in response: return response['result']
            assert time.monotonic() < deadline, response
            time.sleep(.2)
    checks = []
    def denied(thread, code, label):
        before = snapshot()
        for operation in ['bootstrap', 'add']:
            response = call(thread, operation)
            payload = json.loads(response['content'][0]['text'])
            assert response.get('isError') and payload['error'] == code, response
            assert 'M0_READ_SENTINEL' not in json.dumps(response)
        assert snapshot() == before, label + ': data changed'
        checks.append(label)
    try:
        assert 'result' in rpc('initialize', {'clientInfo': {'name': 'mwf_m0_binding', 'version': '0.0.0'}, 'capabilities': {'experimentalApi': True, 'requestAttestation': False}})
        app.stdin.write('{"method":"initialized"}\n'); app.stdin.flush()
        active = start(subdir)
        read = call(active, 'bootstrap')
        assert not read.get('isError') and 'M0_READ_SENTINEL' in json.dumps(read), read
        assert json.loads(read['content'][0]['text'])['cwd'] == str(subdir)
        write = call(active, 'add')
        assert not write.get('isError') and json.loads(write['content'][0]['text'])['result']['ok'], write
        checks.append('A real committed read/write from nested cwd')
        denied(start(b), 'ROOT_MISMATCH', 'B copy: no A/B read/write; all file hashes unchanged')
        denied(start(child), 'ROOT_MISMATCH', 'nearest child stops parent fallback')
        receipt['clients']['codex']['enabled'] = False; save_receipt()
        denied(active, 'DISABLED', 'existing connection disabled')
        receipt['clients']['codex'].update(enabled=True, binding_generation='new-generation'); save_receipt()
        denied(active, 'BINDING_STALE', 'old connection stays stale after re-enable')
        stale = start(a)
        denied(stale, 'BINDING_STALE', 'stale process rejected at startup')
        receipt['clients']['codex']['binding_generation'] = 'm0-generation'; save_receipt()
        denied(stale, 'BINDING_STALE', 'startup-rejected process cannot revive')
        summary = {'date': '2026-10-16', 'codex_version': subprocess.check_output([binary, '--version'], text=True).strip(), 'node_version': subprocess.check_output([node, '--version'], text=True).strip(), 'upstream_commit': '7b8be0e59647c90227c0cb945b279d7fa7ab14ef', 'checks': checks, 'gui_workflow': 'not_run', 'production_atomic_revocation': 'not_tested: prototype checks before upstream transaction', 'evidence_dir': str(base), 'probe_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__), source / 'binding-gateway.mjs']}}
        (base / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False))
        print(json.dumps(summary, indent=2, ensure_ascii=False))
    finally:
        app.terminate()
        try: app.wait(timeout=10)
        except subprocess.TimeoutExpired: app.kill(); app.wait()
