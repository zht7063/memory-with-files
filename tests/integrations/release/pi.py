"""Real Pi package discovery and model-protocol observation against a local synthetic endpoint."""
import json, os, sys, subprocess, tempfile, threading, shutil, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
repo=Path(__file__).resolve().parents[3]
base=Path(tempfile.mkdtemp(prefix='mwf-v2-pi-')).resolve()
pi=sys.argv[1]; node=shutil.which('node'); requests=[]; writes=0
class Endpoint(BaseHTTPRequestHandler):
 def log_message(self,*_): pass
 def do_POST(self):
  global writes
  p=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  names=[t['function']['name'] for t in p.get('tools',[])]
  text=json.dumps(p,ensure_ascii=False)
  requests.append({'seed':'MWF_V2_HOST_SEED' in text,'saved':'MWF_V2_HOST_SAVED' in text,'tools':names})
  tool=next((n for n in names if n.endswith('mwf_add')),None) if writes==0 else next((n for n in names if n.endswith('mwf_handoff')),None) if writes==1 else None
  self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
  if tool:
   args={'project_root':str(project),'type':'knowledge','title':'Host saved','summary':'MWF_V2_HOST_SAVED','body':'Written by actual Pi MCP tool','request_id':'real-pi-add'} if writes==0 else {'project_root':str(project),'action':'save','task_id':'host-task','expected_revision':0,'request_id':'real-pi-handoff','data':{'goal':'Host verified','next_action':'Resume'}}
   delta={'role':'assistant','tool_calls':[{'index':0,'id':'call_'+str(writes),'type':'function','function':{'name':tool,'arguments':json.dumps(args)}}]}; reason='tool_calls'; writes+=1
  else: delta={'role':'assistant','content':'fixture complete'};reason='stop'
  for d,r in [(delta,None),({},reason)]:
   event={'id':'v2','object':'chat.completion.chunk','created':0,'model':'fixture','choices':[{'index':0,'delta':d,'finish_reason':r}]}
   self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n')
server=ThreadingHTTPServer(('127.0.0.1',0),Endpoint);threading.Thread(target=server.serve_forever,daemon=True).start()
agent=base/'agent';agent.mkdir();project=base/'项目 A';project.mkdir()
env={k:v for k,v in os.environ.items() if k in ['PATH','HOME','TMPDIR','LANG']};env.update(PI_CODING_AGENT_DIR=str(agent),PI_OFFLINE='1',PI_TELEMETRY='0')
(agent/'models.json').write_text(json.dumps({'providers':{'fixture':{'baseUrl':f'http://127.0.0.1:{server.server_port}/v1','api':'openai-completions','apiKey':'synthetic','models':[{'id':'fixture','contextWindow':32000,'maxTokens':1000}]}}}))
subprocess.run(['tar','-xzf',str(repo/'releases/zht7063-mwf-0.2.0.tgz'),'-C',str(base)],check=True)
pkg=base/'package';cli=pkg/'dist/cli.js'
def mwf(*args):
 r=subprocess.run([node,str(cli),*args],cwd=project,env=env,capture_output=True,text=True,timeout=30)
 assert r.returncode==0,(r.stdout,r.stderr);return json.loads(r.stdout)
def session(trust=True):
 r=subprocess.run([pi,'--print','--offline','--approve' if trust else '--no-approve','--provider','fixture','--model','fixture','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','Continue the synthetic project.'],cwd=project,env=env,capture_output=True,text=True,timeout=60)
 (base/f'session-{time.time_ns()}.log').write_text(r.stdout+'\n'+r.stderr)
 assert r.returncode==0,(r.stdout,r.stderr)
try:
 subprocess.run([pi,'install',str(pkg),'--local','--approve'],cwd=project,env=env,capture_output=True,check=True)
 start=len(requests);session();assert not requests[start]['seed'] and not any('mwf_' in n for n in requests[start]['tools'])
 assert not (project/'.mwf').exists(), 'Disabled discovery must not create memory state'
 mwf('init','--root',str(project),'--git-mode','track');mwf('attach','--root',str(project),'--harness','pi','--apply')
 mwf('add','--root',str(project),'--type','knowledge','--title','Seed','--summary','MWF_V2_HOST_SEED','--body','Synthetic startup memory')
 session();assert requests and requests[0]['seed'],requests
 assert any(n.endswith('mwf_add') for n in requests[0]['tools']),requests
 assert 'MWF_V2_HOST_SAVED' in json.dumps(mwf('recall','--root',str(project)))
 assert mwf('handoff','--root',str(project),'--action','read','--task','host-task')['ok']
 start=len(requests);session();assert requests[start]['saved'],requests[start:]
 start=len(requests);session(False);assert not requests[start]['seed'] and not any('mwf_' in n for n in requests[start]['tools'])
 mwf('detach','--root',str(project),'--harness','pi','--apply');start=len(requests);session();assert not requests[start]['seed'] and not any('mwf_' in n for n in requests[start]['tools'])
 # Removing the installed package leaves data intact and prevents automatic tools after restart.
 mwf('attach','--root',str(project),'--harness','pi','--apply')
 subprocess.run([pi,'remove',str(pkg),'--local','--approve'],cwd=project,env=env,capture_output=True,check=True)
 start=len(requests);session();assert not requests[start]['seed'] and not any('mwf_' in n for n in requests[start]['tools'])
 subprocess.run([pi,'install',str(pkg),'--local','--approve'],cwd=project,env=env,capture_output=True,check=True)
 mwf('rebind','--root',str(project),'--harness','pi','--apply');start=len(requests);session();assert requests[start]['saved']
 result={'status':'partial','pi_version':subprocess.check_output([pi,'--version'],text=True).strip(),'requests':requests,'evidence_dir':str(base),'limits':['Synthetic model endpoint, not billed model tokens','Compact/tree/resume/clear/reload, conflicting configuration, session replacement and slow/failed MCP require separate real-host scenarios']}
 (base/'evidence.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally: server.shutdown()
