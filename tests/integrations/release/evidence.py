"""Shared Linux CLI harness evidence helpers: MCP tools/list probe and evidence file writing.

No environment values, tokens or host config are recorded; only versions, tool names
and tool results from synthetic fixture projects.
"""
import json, os, platform, subprocess, sys, time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
EXPECTED_TOOLS = 8


def commit_info():
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=REPO, text=True).strip())
    return head, dirty


def binding_generation(project, harness):
    """Read the attach receipt's binding generation for harness from the project's .mwf state."""
    for path in sorted((Path(project) / '.mwf').rglob('*.json')):
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                client = node.get('clients', {}).get(harness) if isinstance(node.get('clients'), dict) else None
                if isinstance(client, dict) and client.get('binding_generation'):
                    return client['binding_generation']
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
    raise AssertionError(f'no {harness} binding_generation in {project}/.mwf')


def mcp_probe(cmd, cwd, env, project_root, timeout=30):
    """Speak MCP over stdio to the installed runtime: initialize, tools/list, then a real mwf_status call."""
    p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    def send(obj):
        p.stdin.write(json.dumps(obj) + '\n'); p.stdin.flush()
    def recv(ident):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = p.stdout.readline()
            if not line:
                break
            msg = json.loads(line)
            if msg.get('id') == ident:
                return msg
        raise TimeoutError(ident)
    try:
        send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'mwf-linux-harness', 'version': '1'}}})
        assert 'result' in recv(1)
        send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        send({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}})
        tools = sorted(t['name'] for t in recv(2)['result']['tools'])
        send({'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'mwf_status', 'arguments': {'project_root': str(project_root)}}})
        status = json.loads(recv(3)['result']['content'][0]['text'])
        return tools, status
    finally:
        p.terminate()
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill(); p.wait()


def tool_ok(response):
    """True when an MCP tools/call response carries an ok MWF envelope."""
    try:
        return bool(json.loads(response['result']['content'][0]['text'])['ok'])
    except Exception:
        return False


def write(harness, payload):
    head, dirty = commit_info()
    record = {
        'schema': 'mwf-linux-harness-evidence/1',
        'harness': harness,
        'platform': sys.platform,
        'kernel': platform.release(),
        'machine': platform.machine(),
        'node': subprocess.check_output(['node', '--version'], stdin=subprocess.DEVNULL, text=True).strip(),
        'commit': head,
        'dirty': dirty,
        'finished_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        **payload,
    }
    out = os.environ.get('MWF_EVIDENCE_OUT')
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(json.dumps(record, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps(record, ensure_ascii=False))
    return record
