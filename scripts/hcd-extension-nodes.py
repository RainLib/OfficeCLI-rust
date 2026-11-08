#!/usr/bin/env python3
"""Isolated native extension envelopes, real socket save, exports and offline readback."""
import hashlib,json,os,runpy,secrets,shutil,socket,subprocess,tempfile,time,urllib.request,urllib.error,zipfile
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];binary=repo/'target/debug/officecli';root=Path(tempfile.mkdtemp(prefix='hcd-extension-nodes-'));root.chmod(0o700)
 runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'))['fixtures'](root)
 env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
 for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
 def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,text=True,capture_output=True,check=True,timeout=120).stdout)['data']
 bundle=root/'doc.hcd';cli('import',root/'fixture.docx','--output',bundle,'--document-id','doc');cli('project-editor',bundle,'--expected-revision',0)
 tokens={actor:cli('issue-token','--document-id','doc','--scope','read' if actor=='reader' else 'write','--user-id',actor,'--ttl-seconds',3600)['token'] for actor in ['alice','reader']}
 tokens['service']=cli('issue-token','--document-id','doc','--scope','write','--user-id','hcd-collaboration','--ttl-seconds',3600)['token']
 ports=[]
 for _ in range(2):
  with socket.socket() as s:s.bind(('127.0.0.1',0));ports.append(s.getsockname()[1])
 origin=f'http://127.0.0.1:{ports[0]}';base=origin+'/v1/documents/doc';opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def request(path,body=None,actor='alice',aware=True,expected=200):
  headers={'X-HCD-Node-Edits-Version':'4','Authorization':'Bearer '+tokens[actor],'Content-Type':'application/json'}
  if aware:headers['X-HCD-Extension-Version']='1'
  if actor=='service':headers.update({'X-HCD-Coordinator-Version':'4','X-HCD-Collaboration-Epoch':str(request('/auth')['collaborationEpoch'])})
  try:
   response=opener.open(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers),timeout=90);raw=response.read();status=response.status
  except urllib.error.HTTPError as e:status=e.code;raw=e.read()
  assert status==expected,(path,status,raw[:500]);return json.loads(raw) if raw[:1] in [b'{',b'['] else raw
 log=open(root/'api.log','wb');process=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'],env=env,stdout=log,stderr=log)
 evidence={'schemaVersion':'hcd-extension-nodes/1','scope':'Local generic inert envelopes, native API, real structural WebSocket and actual exported files. No host codec registration UI, custom properties/migrations or business-specific export adapter acceptance.','validation':{},'files':[]}
 try:
  for _ in range(100):
   try:request('/auth');break
   except OSError:time.sleep(.1)
  def node(n,display,text):return {'schemaVersion':'hcd.extension/1','instanceId':'x_'+format(n,'032x'),'type':'example.future_card','version':77,'display':display,'data':{'unknown':{'text':'保留 <&😀','nested':[1,True,None]},'businessId':'external:42'},'fallback':{'text':text}}
  inline=node(1,'inline','自定义行内卡片');block=node(2,'block','自定义提示块')
  projection=request('/editor');anchor=projection['blocks'][0]['blockId']
  patch={'schemaVersion':'hcd-patch/4','documentId':'doc','patchId':'extension-fixture','baseRevision':1,'actor':{},'operations':[{'op':'block.insert','afterBlockId':anchor,'block':{'kind':'paragraph','inlines':[{'text':'before '},{'text':inline['fallback']['text'],'extension':inline},{'text':' after'}]}},{'op':'block.insert','afterBlockId':anchor,'block':{'kind':'extension','extension':block,'inlines':[{'text':block['fallback']['text']}]}}]}
  blocked=request('/patch',patch,aware=False,expected=426);assert 'extension-aware' in json.dumps(blocked);assert request('')['revision']==1
  request('/patch',patch,actor='reader',expected=403);request('/patch',patch);assert request('')['revision']==2
  native=request('/editor');extract=lambda p:[value for b in p['blocks'] for value in ([b['content']['extension']] if b['content'].get('extension') else [])+[i['extension'] for i in b['content']['inlines'] if i.get('extension')]]
  assert sorted(extract(native),key=lambda n:n['instanceId'])==[inline,block]
  # An unaware snapshot may not silently remove extensions.
  blocked=request('/checkpoints',{'coordinatorVersion':4,'coordinatorId':'a'*32,'checkpointId':'b'*32,'coordinatorDigest':'0'*64,'typographyVersion':2,'expectedRevision':2,'blocks':[{'blockId':b['blockId'],'content':{'kind':'paragraph','inlines':[{'text':'flattened'}]}} for b in native['blocks']]},actor='service',aware=False,expected=426);assert 'extension-aware' in json.dumps(blocked)
  assert request('')['revision']==2;evidence['validation']['unawarePatchAndSnapshotRejectedBeforeCommit']=True
  private=root/'private.json';private.write_text(json.dumps({'root':str(root),'origin':origin,'collabPort':ports[1],'secret':env['HCD_TOKEN_SECRET'],'alice':tokens['alice']}));private.chmod(0o600)
  subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-extension-nodes.mts'),str(private)],cwd=repo,env=env,check=True,timeout=120)
  evidence['validation'].update(json.loads((root/'socket-evidence.json').read_text()));revision=request('')['revision'];assert sorted(extract(request('/editor')),key=lambda n:n['instanceId'])==[inline,block]
  for fmt in ['docx','pdf','md']:
   p=root/f'extensions.{fmt}';p.write_bytes(request(f'/export/{fmt}?revision={revision}',actor='reader'));text=p.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(p),'text'],text=True)
   assert all(s in text for s in ['自定义行内卡片','自定义提示块','before',' after','Unrelated collaborative input retained']),(fmt,text)
   if fmt=='docx':
    def media(path):
     with zipfile.ZipFile(path) as z:return sorted(hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if name.startswith('word/media/'))
    assert media(p)==media(root/'fixture.docx')
   evidence['files'].append({'format':fmt,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'readableFallbacksPreserved':True})
  report=root/'fidelity.json';cli('export',bundle,'--output',root/'reported.docx','--revision',revision,'--fidelity-report',report);assert sum(w['code']=='HCD_EXTENSION_FLATTENED' for w in json.loads(report.read_text())['warnings'])==2
  offline=root/'offline.hcd';shutil.copytree(bundle,offline);assert sorted(extract(cli('editor-state',offline)),key=lambda n:n['instanceId'])==[inline,block]
  evidence['validation'].update(offlineNativeDataAndIdentityRetained=True,unknownBusinessVersionPreserved=True,flatteningReportedPerNode=True,readOnlyExportAllowed=True)
 finally:
  process.terminate()
  try:process.wait(timeout=10)
  except subprocess.TimeoutExpired:process.kill();process.wait()
  log.close()
 evidence['validation']['ownedServicesStopped']=True;evidence['retainedFixture']=str(root)
 target=repo/'docs/assets/hcd-extensions-2026-10-24';target.mkdir(exist_ok=True);(target/'extension-native-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS generic extension envelopes, real socket save, offline data and three exported files')
if __name__=='__main__':main()
