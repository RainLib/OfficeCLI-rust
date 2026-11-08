#!/usr/bin/env python3
"""Owned opt-in Word layout fixture: native CLI, HTTP guards and mapped joint edits.
No browser automation and no changes to user preview documents. Tokens stay in memory.
"""
import copy,hashlib,json,os,secrets,shutil,socket,subprocess,tempfile,time,urllib.request,urllib.error,zipfile
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];binary=repo/'target/debug/officecli';fixture=repo/'target/hcd-preview-runtime/flow-layout-evidence';assets=Path(os.environ.get('HCD_FLOW_LAYOUT_EVIDENCE_DIR',repo/'docs/assets/hcd-flow-layout-2026-10-26'));assets.mkdir(parents=True,exist_ok=True)
 assert (fixture/'saved.hcd/manifest.json').is_file(),'Run the owned Rust evidence test first'
 work=Path(tempfile.mkdtemp(prefix='hcd-flow-layout-http-',dir=repo/'target/hcd-preview-runtime'));bundle=work/'layout-test.hcd';shutil.copytree(fixture/'saved.hcd',bundle);(work/'sources').mkdir();shutil.copyfile(fixture/'source.docx',work/'sources/layout-test.docx')
 env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32),'NO_COLOR':'1'}
 for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
 sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
 def run(args):return subprocess.run([str(binary),*map(str,args)],env=env,cwd=work,capture_output=True,text=True,timeout=120)
 def cli(*args):
  result=run(['hdoc',*args,'--json']);assert '\x1b[' not in result.stdout and not result.stderr,(result.returncode,result.stderr)
  value=json.loads(result.stdout);assert result.returncode==0 and value['success'],value;return value['data']
 before=cli('editor-state',bundle);assert before['revision']==1 and len(before['flowLayout']['sections'])==2 and len(before['flowLayout']['stories'])==6
 for args,name in [(['--help'],'help'),(['hdoc','export','--help'],'export-help'),(['hdoc','editor-state','--help'],'editor-help')]:
  result=run(args);assert result.returncode==0 and not result.stderr;(assets/(name+'.txt')).write_text(result.stdout)
 human=run(['hdoc','editor-state',bundle]);assert human.returncode==0 and '\x1b[' not in human.stdout
 failures=[]
 legacy_semantic=run(['hdoc','export',bundle,'--output',work/'semantic.docx','--json']);legacy_semantic_value=json.loads(legacy_semantic.stdout);assert legacy_semantic.returncode==1 and 'import paragraph identities' in legacy_semantic_value['error']['error'];assert not (work/'semantic.docx').exists() and cli('editor-state',bundle)==before
 for fmt in ['pptx','pdf','md']:
  target=work/f'unsupported.{fmt}';target.write_bytes(b'owned-existing-output');result=run(['hdoc','export',bundle,'--to',fmt,'--output',target,'--json']);value=json.loads(result.stdout);assert result.returncode==1 and value['success'] is False and value['error']['code']=='unsupported_feature' and not result.stderr;assert target.read_bytes()==b'owned-existing-output';failures.append({'format':fmt,'exit':1,'code':value['error']['code'],'existingOutputUnchanged':True})
 error=run(['hdoc','export',bundle,'--to','pdf','--output',work/'new.pdf']);assert error.returncode==1 and not error.stdout and error.stderr.count('Error:')==1 and not(work/'new.pdf').exists()
 invalid=run(['hdoc','export',bundle,'--to','nonsense','--output',work/'invalid.nonsense','--json']);assert invalid.returncode==1 and json.loads(invalid.stdout)['success'] is False
 projected=run(['hdoc','project-editor',bundle,'--expected-revision',1,'--json']);assert projected.returncode==1 and json.loads(projected.stdout)['success'] is False;assert cli('editor-state',bundle)==before
 source_model_refusals=[]
 for model in [99,None]:
  malformed=work/('model-future.hcd' if model else 'model-missing.hcd');shutil.copytree(bundle,malformed);manifest_path=malformed/'manifest.json';manifest=json.loads(manifest_path.read_text())
  if model is None:manifest['capabilities'].pop('flowLayout')
  else:manifest['capabilities']['flowLayout']=model
  manifest_path.write_text(json.dumps(manifest));output=work/('model-future.docx' if model else 'model-missing.docx');result=run(['hdoc','export',malformed,'--source',fixture/'source.docx','--output',output,'--json']);value=json.loads(result.stdout);assert result.returncode==1 and value['success'] is False and not output.exists(),(model,value)
  output.write_bytes(b'owned-existing-output');result=run(['hdoc','export',malformed,'--source',fixture/'source.docx','--output',output,'--json']);assert result.returncode==1 and json.loads(result.stdout)['success'] is False and output.read_bytes()==b'owned-existing-output';source_model_refusals.append({'model':model,'exit':1,'code':value['error']['code'],'newOutputAbsent':True,'existingOutputUnchanged':True})
 packed=work/'layout-r1.hcdz';cli('pack',bundle,'--output',packed);offline=work/'offline.hcd';cli('unpack',packed,'--output',offline);assert cli('validate',offline)['valid']
 for revision in [0,1]:assert cli('editor-state',offline,'--revision',revision)==cli('editor-state',bundle,'--revision',revision)
 tokens={scope:cli('issue-token','--document-id','layout-test','--scope',scope,'--user-id','reader' if scope=='read' else 'alice','--display-name','Reader' if scope=='read' else 'Alice','--ttl-seconds',3600)['token'] for scope in ['read','write']}
 with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
 origin=f'http://127.0.0.1:{port}';log=open(work/'server.log','w');process=subprocess.Popen([str(binary),'hdoc','serve','--root',str(work),'--bind',f'127.0.0.1:{port}'],env=env,stdout=log,stderr=log)
 observations=[]
 def download(route):
  req=urllib.request.Request(origin+'/v1/documents/layout-test'+route,headers={'Authorization':'Bearer '+tokens['read']})
  with urllib.request.urlopen(req,timeout=120) as response:
   assert response.status==200;return response.read()
 def request(route='',data=None,scope='write',model='1'):
  headers={'Authorization':'Bearer '+tokens[scope],'Content-Type':'application/json'}
  if model is not None:headers['X-HCD-Flow-Layout-Version']=model
  req=urllib.request.Request(origin+'/v1/documents/layout-test'+route,data=None if data is None else json.dumps(data).encode(),headers=headers)
  try:
   with urllib.request.urlopen(req,timeout=30) as response:return response.status,json.load(response)
  except urllib.error.HTTPError as error:
   raw=error.read().decode();
   try:value=json.loads(raw)
   except json.JSONDecodeError:value={'error':raw}
   return error.code,value
 try:
  deadline=time.monotonic()+30
  while True:
   assert process.poll() is None,'Owned server terminated during startup'
   try:
    if request()[0]==200:break
   except urllib.error.URLError:pass
   assert time.monotonic()<deadline,'Owned server startup deadline';time.sleep(.05)
  for version in [None,'0','2','unknown']:
   status,_=request('/editor',model=version);assert status==426;observations.append({'route':'GET /editor','model':version,'status':status})
  status,projection=request('/editor');assert status==200 and projection==before;observations.append({'route':'GET /editor','model':'1','status':status})
  entries=cli('extract-text',bundle)['entries'];operations=[]
  for old,new in [('Body edited','Body API'),('Header edited','Header API'),('Footer edited','Footer API')]:
   entry=next(entry for entry in entries if entry['text']==old);operations.append({'op':'text.splice','nodeId':entry['nodeId'],'start':0,'deleteCount':len(old),'insertText':new,'precondition':{'nodeHash':entry['nodeHash']}})
  patch={'schemaVersion':'hcd-patch/3','documentId':'layout-test','patchId':'http-region-joint-2','baseRevision':1,'actor':{},'metadata':{},'operations':operations}
  for scope,model,expected in [('write',None,426),('read','1',403)]:
   status,_=request('/edits',patch,scope,model);assert status==expected,(status,expected);assert cli('editor-state',bundle)==before;observations.append({'route':'POST /edits','scope':scope,'model':model,'status':status,'headUnchanged':True})
  bad=copy.deepcopy(patch);bad['operations'][1]['precondition']['nodeHash']='0'*64;status,_=request('/edits',bad);assert status==412,status;assert cli('editor-state',bundle)==before;observations.append({'route':'POST /edits bad second precondition','status':status,'headUnchanged':True})
  status,saved=request('/edits',patch);assert status==200 and saved['revision']==2,(status,saved);observations.append({'route':'POST /edits joint body/header/footer','status':status,'revision':2})
  status,replay=request('/edits',patch);assert status==200 and replay['revision']==2 and replay['idempotentReplay'];observations.append({'route':'POST /edits replay','status':status,'revision':2,'idempotentReplay':True})
  status,current=request('/editor');assert status==200 and current['revision']==2 and current['flowLayout']==before['flowLayout'];assert cli('validate',bundle)['valid'];readback=cli('extract-text',bundle)['entries'];assert all(any(entry['text']==value for entry in readback) for value in ['Body API','Header API','Footer API'])
  for route,data in [('/project',{'expectedRevision':2}),('/patch',{'schemaVersion':'hcd-patch/4','documentId':'layout-test','patchId':'not-region-aware','baseRevision':2,'actor':{},'operations':[]})]:
   status,_=request(route,data);assert status==426,(route,status);assert cli('editor-state',bundle)==current;observations.append({'route':'POST '+route,'status':status,'headUnchanged':True})
  status,options=request('/export-options');assert status==200 and options['sourceAvailable'] and options['sourceEditsSupported'] and options['semanticExportSupported'] is False and options['semanticReasonCode']=='WORD_REGION_EXPORT_PARTIAL' and options['semanticFormats']==['docx'];observations.append({'route':'GET /export-options','status':200,'sourceEditsSupported':True,'semanticExportSupported':False})
  status,_=request('/export/docx?revision=2');assert status==400;observations.append({'route':'GET /export/docx','status':400,'legacyProjectionMetadataMissing':True})
  for fmt in ['xlsx','pptx','pdf','html','md','txt']:
   status,_=request('/export/'+fmt+'?revision=2');assert status==422,(fmt,status);observations.append({'route':'GET /export/'+fmt,'status':status})
  exported=work/'http-r2.docx';exported.write_bytes(download('/export/docx?revision=2&source=true'));observations.append({'route':'GET /export/docx source=true','status':200})
  native_output=work/'cli-r2.docx';cli('export',bundle,'--source',fixture/'source.docx','--output',native_output)
  with zipfile.ZipFile(exported) as via_http,zipfile.ZipFile(native_output) as via_cli:
   assert set(via_http.namelist())==set(via_cli.namelist());assert all(via_http.read(name)==via_cli.read(name) for name in via_cli.namelist())

  with zipfile.ZipFile(exported) as actual,zipfile.ZipFile(fixture/'source.docx') as original:
   for part in ['word/settings.xml','word/_rels/document.xml.rels','[Content_Types].xml','word/parts/custom.xml','word/header2.xml','word/header3.xml','word/footer2.xml']:assert actual.read(part)==original.read(part)
   for part,text in [('word/document.xml','Body API'),('word/header1.xml','Header API'),('word/footer1.xml','Footer API')]:assert text in actual.read(part).decode()
  final=work/'layout-r2.hcdz';cli('pack',bundle,'--output',final);reopened=work/'final-offline.hcd';cli('unpack',final,'--output',reopened);assert cli('editor-state',reopened)==current and cli('validate',reopened)['valid']
  for revision in [0,1,2]:assert cli('editor-state',reopened,'--revision',revision)==cli('editor-state',bundle,'--revision',revision)
  via_http=work/'http-r2.hcdz';via_http.write_bytes(download('/export/hcdz?revision=2'));http_reopened=work/'http-offline.hcd';cli('unpack',via_http,'--output',http_reopened);assert cli('editor-state',http_reopened)==current and cli('validate',http_reopened)['valid'];observations.append({'route':'GET /export/hcdz','status':200,'sourceFreeReopenedExact':True})
  restored=work/'restored.hcd';shutil.copytree(reopened,restored);cli('restore',restored,'--revision',0,'--expected-revision',2);restored_state=cli('editor-state',restored);original_state=cli('editor-state',bundle,'--revision',0);assert restored_state['revision']==3 and restored_state['blocks']==original_state['blocks'] and restored_state['flowLayout']==original_state['flowLayout'] and cli('validate',restored)['valid']
  for name,path in [('layout-r1.hcdz',packed),('layout-r2.hcdz',final),('http-r2.docx',exported),('native-r1.docx',fixture/'saved.docx'),('native-r0.docx',fixture/'r0.docx'),('source.docx',fixture/'source.docx')]:shutil.copyfile(path,assets/name)
  (assets/'projection-r2.json').write_text(json.dumps(current,ensure_ascii=False,indent=2)+'\n')
  report={'scope':'Actual opted-in native Word section/story fixture. Real authenticated loopback HTTP joint mapped text commits and source-backed DOCX export. No browser editor or signed CRDT coordinator activation.','nativeBinarySha256':sha(binary),'initialRevision':1,'httpRevision':2,'sections':2,'stories':6,'originalLayoutAndPartRelationshipsUnchanged':True,'sourceFreeArchiveRevisions':[0,1,2],'sourceFreeReopenedExact':True,'mappedBodyHeaderFooterSavedTogether':True,'restoredAsRevision3ExactToRevision0':True,'http':observations,'semanticExportsRefused':failures,'sourceExportsWithInvalidRequiredModelRefused':source_model_refusals,'cli':{'jsonOneValue':True,'NO_COLOR':'verified','humanErrors':'stderr once; stdout empty','invalidInput':'failed without output file','help':'checked','noColorFlag':'not part of existing CLI; NO_COLOR used','quietFlag':'not part of existing CLI'},'knownBoundaries':['No header/footer creation or browser editing','No region-aware rich structural protocol/signed CRDT checkpoint','No page-number field node/actual pagination or document TOC','Eligible model 1/2 semantic DOCX is supported; this legacy fixture lacks paragraph projection identities and remains source-backed only. Other regional formats remain unsupported','No Office desktop or cross-platform acceptance','Management and actual reminder delivery deferred'],'runtime':str(work),'artifactsSha256':{path.name:sha(path) for path in assets.iterdir() if path.is_file() and path.suffix in ['.docx','.hcdz','.json'] and path.name!='file-evidence.json'}}
  (assets/'file-evidence.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print('PASS native sections/stories, actual HTTP r2 joint edits, denial/idempotency, source-backed DOCX and source-free archive; semantic refusals preserve outputs')
 finally:
  process.terminate()
  try:process.wait(timeout=10)
  except subprocess.TimeoutExpired:process.kill();process.wait()
  log.close()
if __name__=='__main__':main()
