"""Installed product plugin against the bundled Codex runtime; not desktop GUI evidence."""
import json, os, queue, shutil, subprocess, sys, tempfile, threading, time, tomllib
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, str(Path(__file__).resolve().parent))
import evidence
repo=Path(__file__).resolve().parents[3];base=evidence.harness_tmp('mwf-v2-codex-');binary=sys.argv[1];requests=[];turns=[]
VERSION=json.loads((repo/'package.json').read_text())['version']
class Endpoint(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append({'path': self.path, 'mwf_tools': [t.get('name', t.get('function', {}).get('name', '')) for t in payload.get('tools', []) if 'mwf' in t.get('name', t.get('function', {}).get('name', ''))], 'marker': 'MWF_V2_CODEX_SEED' in json.dumps(payload), 'saved': 'MWF_V2_CODEX_SAVED' in json.dumps(payload), 'at': time.time()})
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


server=ThreadingHTTPServer(('127.0.0.1',0),Endpoint);threading.Thread(target=server.serve_forever,daemon=True).start()
home=base/'home';home.mkdir();market=base/'market';(market/'.agents/plugins').mkdir(parents=True);plugin=market/'mwf';plugin.mkdir();project=base/'项目 A';project.mkdir()
subprocess.run(['unzip','-q',str(repo/f'releases/mwf-codex-{VERSION}.zip'),'-d',str(plugin)],check=True)
(market/'.agents/plugins/marketplace.json').write_text(json.dumps({'name':'mwf-v2','plugins':[{'name':'mwf','version':VERSION,'source':{'source':'local','path':'./mwf'},'policy':{'installation':'AVAILABLE','authentication':'ON_INSTALL'},'category':'Developer Tools'}]}))
env={k:v for k,v in os.environ.items() if k in ['PATH','HOME','TMPDIR','LANG']};env['CODEX_HOME']=str(home)
(home/'config.toml').write_text('model = "m0"\nmodel_provider = "m0"\n[model_providers.m0]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:'+str(server.server_port)+'/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[projects.'+json.dumps(str(project))+']\ntrust_level = "trusted"\n')
def turn(args,root=project):
 # Judge only the first model request of THIS exec (its main turn). Using requests[-1]
 # was racy: late requests from a previous process (terminated app-server, secondary
 # model calls) could land last and make T09 `saved` checks flaky.
 start=len(requests);t0=time.time();r=command(args,root);new=requests[start:]
 turns.append({'args':[a for a in args if a.startswith('--')],'root':root.name,'seconds':round(time.time()-t0,2),'requests':[{k:v for k,v in q.items() if k!='at'} for q in new]})
 (base/'turns.json').write_text(json.dumps(turns,indent=1,ensure_ascii=False))
 assert new,('no model request from exec',r.stderr)
 return r,new[0]
def command(args,root=project):
 r=subprocess.run([binary,*args],cwd=root,env=env,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=60);assert r.returncode==0,(r.stdout,r.stderr);return r
try:
 for args in [['plugin','marketplace','add',str(market),'--json'],['plugin','add','mwf@mwf-v2','--json']]:
  r=command(args);(base/('install-'+str(time.time_ns())+'.json')).write_text(r.stdout)
 installed=next((p.parent for p in home.rglob('plugin.json') if (p.parent/'runtime/dist/cli.js').exists()),plugin)
 cli=installed/'runtime/dist/cli.js'
 def mwf(*args):
  r=subprocess.run([shutil.which('node'),str(cli),*args],cwd=project,env=env,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=30);assert r.returncode==0,(r.stdout,r.stderr);return json.loads(r.stdout)
 mwf('init','--root',str(project),'--git-mode','track');mwf('attach','--root',str(project),'--harness','codex','--plugin-root',str(installed),'--apply')
 mwf('add','--root',str(project),'--type','knowledge','--title','Seed','--summary','MWF_V2_CODEX_SEED','--body','Synthetic committed memory')
 args=['exec','--skip-git-repo-check','--ephemeral','--json','--sandbox','workspace-write','-C',str(project),'Synthetic fixture; respond briefly.']
 r,q=turn(args);(base/'untrusted.log').write_text(r.stdout+r.stderr);assert not q['marker']
 r,q=turn([*args[:-1],'--dangerously-bypass-hook-trust',args[-1]]);(base/'trusted.log').write_text(r.stdout+r.stderr);assert q['marker'],r.stderr
 cfg=tomllib.loads((project/'.codex/config.toml').read_text())['mcp_servers']['mwf']
 probe_tools,probe_status=evidence.mcp_probe([cfg['command'],*cfg['args']],project,env,project)
 assert len(probe_tools)==evidence.EXPECTED_TOOLS and probe_status['ok'],(probe_tools,probe_status)
 host_tools=sorted(set(q['mwf_tools']))
 copied=base/'项目 B';shutil.copytree(project,copied)
 with (home/'config.toml').open('a') as f:f.write('\n[projects.'+json.dumps(str(copied))+']\ntrust_level = "trusted"\n')
 copy_args=[str(copied) if a==str(project) else a for a in args];r,q=turn([*copy_args[:-1],'--dangerously-bypass-hook-trust',copy_args[-1]],copied);assert not q['marker']
 # Exercise product tools through the real app-server, including a still-live revoked connection.
 app=subprocess.Popen([binary,'app-server','--stdio'],cwd=project,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(base/'app-server.log','w'),text=True)
 inbox=queue.Queue()
 threading.Thread(target=lambda:[inbox.put(json.loads(line)) for line in app.stdout],daemon=True).start()
 def rpc(method,params):
  ident=str(time.time_ns());app.stdin.write(json.dumps({'id':ident,'method':method,'params':params})+'\n');app.stdin.flush();deadline=time.monotonic()+25
  while time.monotonic()<deadline:
   value=inbox.get(timeout=max(.1,deadline-time.monotonic()))
   if value.get('id')==ident:return value
  raise TimeoutError(method)
 try:
  assert 'result' in rpc('initialize',{'clientInfo':{'name':'mwf_v2','version':VERSION},'capabilities':{'experimentalApi':True,'requestAttestation':False}})
  app.stdin.write('{"method":"initialized"}\n');app.stdin.flush()
  started=rpc('thread/start',{'cwd':str(project),'ephemeral':True,'approvalPolicy':'never','sandbox':'workspace-write'});thread=started['result']['thread']['id']
  def call(tool,arguments):
   return rpc('mcpServer/tool/call',{'threadId':thread,'server':'mwf','tool':'mwf_'+tool,'arguments':{'project_root':str(project),**arguments}})
  deadline=time.monotonic()+20
  while True:
   called=call('status',{})
   if 'result' in called:break
   assert time.monotonic()<deadline,called
   time.sleep(.2)
  saved=call('add',{'type':'knowledge','title':'Codex tool saved','summary':'MWF_V2_CODEX_SAVED','body':'Real app-server product MCP write','request_id':'codex-real-write'})
  assert json.loads(saved['result']['content'][0]['text'])['ok'],saved
  handoff=call('handoff',{'action':'save','task_id':'codex-task','expected_revision':0,'request_id':'codex-real-handoff','data':{'goal':'Verify product tools','next_action':'Resume'}})
  assert json.loads(handoff['result']['content'][0]['text'])['ok'],handoff
  assert 'MWF_V2_CODEX_SAVED' in json.dumps(mwf('recall','--root',str(project)))
  mwf('detach','--root',str(project),'--harness','codex','--apply')
  revoked=call('status',{});assert not json.loads(revoked['result']['content'][0]['text'])['ok'],revoked
  mwf('attach','--root',str(project),'--harness','codex','--plugin-root',str(installed),'--apply')
  revoked_again=call('status',{});assert not json.loads(revoked_again['result']['content'][0]['text'])['ok'],revoked_again
  (base/'mcp-calls.json').write_text(json.dumps({'save':saved,'handoff':handoff,'revoked':revoked,'revoked_after_attach':revoked_again},indent=2))
 finally:
  app.terminate()
  try:app.wait(timeout=10)
  except subprocess.TimeoutExpired:app.kill();app.wait()
 r,q=turn([*args[:-1],'--dangerously-bypass-hook-trust',args[-1]]);assert q['saved']
 mwf('detach','--root',str(project),'--harness','codex','--apply');r,q=turn([*args[:-1],'--dangerously-bypass-hook-trust',args[-1]]);assert not q['marker'] and not q['saved'] and not q['mwf_tools']
 # T09 actual bundled CLI package uninstall/reinstall; fresh exec is the CLI reload boundary.
 preserved={str(p.relative_to(project)):p.read_bytes() for p in (project/'.mwf').rglob('*') if p.is_file() and (p.suffix=='.md' or '/handoffs/' in str(p) or '/contexts/' in str(p))}
 command(['plugin','remove','mwf@mwf-v2','--json'])
 r,q=turn([*args[:-1],'--dangerously-bypass-hook-trust',args[-1]]);assert not q['marker'] and not q['saved'] and not q['mwf_tools']
 command(['plugin','add','mwf@mwf-v2','--json'])
 installed=next(p.parent for p in home.rglob('plugin.json') if (p.parent/'runtime/dist/cli.js').exists())
 cli=installed/'runtime/dist/cli.js'
 r,q=turn([*args[:-1],'--dangerously-bypass-hook-trust',args[-1]]);assert not q['marker'] and not q['saved'] and not q['mwf_tools']
 mwf('attach','--root',str(project),'--harness','codex','--plugin-root',str(installed),'--apply')
 r,q=turn([*args[:-1],'--dangerously-bypass-hook-trust',args[-1]]);assert q['saved']
 assert all((project/p).read_bytes()==content for p,content in preserved.items())
 assert mwf('handoff','--root',str(project),'--action','read','--task','codex-task')['ok']
 calls=[{'tool':'mwf_status','via':'stdio tools/call','ok':bool(probe_status['ok'])},{'tool':'mwf_status','via':'codex app-server mcpServer/tool/call','ok':evidence.tool_ok(called)},{'tool':'mwf_add','via':'codex app-server mcpServer/tool/call','ok':evidence.tool_ok(saved)},{'tool':'mwf_handoff','via':'codex app-server mcpServer/tool/call','ok':evidence.tool_ok(handoff)}]
 evidence.write('codex_cli',{'status':'pass' if all(c['ok'] for c in calls) else 'fail','label':'measured','host':'codex-cli','host_version':subprocess.check_output([binary,'--version'],stdin=subprocess.DEVNULL,text=True).strip(),'tool_count':len(probe_tools),'tools':probe_tools,'host_tools':host_tools,'tool_calls':calls,'checks':['plugin install','trusted/untrusted hook gating','copied project isolation','app-server product tool calls','detach revokes live connection','plugin remove/reinstall preserves memory'],'evidence_dir':str(base),'limits':['Linux CLI only: Codex desktop GUI not run','Synthetic model endpoint; no billed model tokens','Hook trust bypass is test-only']})
finally:server.shutdown()
