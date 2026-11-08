#!/usr/bin/env python3
"""Real local model-4 storage fence. Opaque bytes test transport, not Yjs semantics."""
import hashlib,json,os,secrets,socket,subprocess,tempfile,time,urllib.request,urllib.error
from pathlib import Path
def main():
 repo=Path(__file__).resolve().parents[1];runtime=repo/'target/hcd-preview-runtime';root=Path(tempfile.mkdtemp(prefix='hcd-reference-fence-',dir=runtime));root.chmod(0o700);binary=repo/'target/debug/officecli';env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
 for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json'],env=env))['data']
 source=root/'source.html';source.write_text('<p>Reference model storage fence</p>');bundle=root/'ref-fence.hcd';cli('import',source,'--output',bundle,'--document-id','ref-fence');cli('project-editor',bundle,'--expected-revision',0);before=(bundle/'manifest.json').read_bytes();head=json.loads(before)['revision']
 token=cli('issue-token','--document-id','ref-fence','--scope','write','--user-id','hcd-collaboration','--ttl-seconds',300)['token']
 with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
 log=open(root/'native.log','wb');server=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{port}'],env=env,stdout=log,stderr=log);opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));base=f'http://127.0.0.1:{port}/v1/documents/ref-fence'
 headers={'Authorization':'Bearer '+token,'X-HCD-Collaboration-Epoch':'0','X-HCD-Collaboration-Protocol':'hcd-semantic-blocks/3','X-HCD-Coordinator-Version':'4','X-HCD-Node-Edits-Version':'4'}
 def call(path,method='GET',body=None,current=None):return opener.open(urllib.request.Request(base+path,data=body,headers=current or headers,method=method),timeout=40)
 try:
  for _ in range(200):
   with socket.socket() as probe:
    if probe.connect_ex(('127.0.0.1',port))==0:break
   assert server.poll() is None;time.sleep(.1)
  # Match the current protocol; this fixture does not migrate the room.
  auth=json.loads(call('/auth').read());headers['X-HCD-Collaboration-Protocol']=auth['collaborationProtocol']
  body=b'opaque synthetic reference intent archive; no real user data';digest=hashlib.sha256(body).hexdigest();put={**headers,'X-HCD-State-Hash':'none','Content-Type':'application/octet-stream'};call('/collaboration/state','PUT',body,put).read();assert call('/collaboration/state').read()==body
  denied=[]
  for model in [None,'1','2','3','5']:
   current={**headers,'X-HCD-State-Hash':digest};current.pop('X-HCD-Node-Edits-Version')
   if model:current['X-HCD-Node-Edits-Version']=model
   for path,method,data in [('/collaboration/state','GET',None),('/collaboration/state','PUT',body),('/checkpoints','POST',json.dumps({'coordinatorVersion':4,'expectedRevision':head,'blocks':[]}).encode())]:
    if path=='/checkpoints':current['Content-Type']='application/json'
    try:call(path,method,data,current);raise AssertionError('unaware operation accepted')
    except urllib.error.HTTPError as error:assert error.code==426,(model,path,error.code,error.read())
    denied.append({'model':model,'operation':method+' '+path,'status':426})
  assert call('/collaboration/state').read()==body and (bundle/'manifest.json').read_bytes()==before
  evidence={'scope':'Actual isolated native HTTP storage and checkpoint fences with opaque synthetic bytes, not reference UI or live Yjs save acceptance. PostgreSQL code compiled separately; no live DB/multi-instance acceptance.','root':str(root),'revision':head,'acceptedModel':4,'denied':denied,'bytesSha256':digest,'sharedBytesAndManifestUnchanged':True}
  destination=repo/'docs/assets/hcd-reference-intents-2026-10-25';destination.mkdir(exist_ok=True);(destination/'native-fence-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS native model 4; missing/1/2/3/future5 shared read/write/checkpoint denied426; bytes/head unchanged.')
 finally:
  server.terminate()
  try:server.wait(timeout=5)
  except subprocess.TimeoutExpired:server.kill();server.wait()
  log.close()
if __name__=='__main__':main()
