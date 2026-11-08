#!/usr/bin/env python3
"""Isolated native coordinator acceptance, with no live sidecar or member UI.
The fixture owns the lease; a signed journal/room replacement is not simulated.
"""
import atexit,argparse,copy,hashlib,json,os,secrets,shutil,socket,subprocess,tempfile,time,urllib.error,urllib.request,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

parser=argparse.ArgumentParser();parser.add_argument('output',type=Path);args=parser.parse_args()
repo=Path(__file__).resolve().parents[1];out=args.output.resolve()
assert out.is_relative_to(repo/'docs/assets'),out
out.mkdir(parents=True,exist_ok=False)
root=Path(tempfile.mkdtemp(prefix='word-link-native-',dir=repo/'target/hcd-preview-runtime'));binary=repo/'target/debug/officecli'
server=None;log=None
def early_cleanup():
 if server is not None and server.poll() is None:
  server.terminate()
  try:server.wait(timeout=8)
  except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
 if log is not None and not log.closed:log.close()
 if root.exists():shutil.rmtree(root)
atexit.register(early_cleanup)
env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':secrets.token_hex(32)}
for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
def cli(*values):
 result=subprocess.run([str(binary),'hdoc',*map(str,values),'--json'],capture_output=True,text=True,check=False,cwd=root,env=env,timeout=90)
 if result.returncode:raise RuntimeError(result.stdout+'\n'+result.stderr)
 return json.loads(result.stdout)['data']
def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
bundle=root/'doc.hcd';source=root/'source.docx';original=repo/'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx'
with zipfile.ZipFile(original) as incoming,zipfile.ZipFile(source,'w') as outgoing:
 for entry in incoming.infolist():
  content=incoming.read(entry)
  if entry.filename=='word/document.xml':
   xml=content.decode();even='<w:headerReference w:type="even" r:id="he"/>';default='<w:headerReference w:type="default" r:id="hd"/>';assert xml.count(even)==1 and xml.count(default)==1
   content=xml.replace(even,'<w:headerReference w:type="even" r:id="hd"/>',1).replace(default,default+even,1).encode()
  outgoing.writestr(entry,content)
cli('import',source,'--word-regions','--document-id','doc','--output',bundle);cli('project-editor',bundle,'--word-regions','--expected-revision',0)
(root/'sources').mkdir();shutil.copyfile(source,root/'sources/doc.docx');(root/'collaboration').mkdir();(root/'collaboration/doc.epoch').write_text(json.dumps({'epoch':1,'protocol':'hcd-word-regions/2','nodeEdits':7}))
token=cli('issue-token','--document-id','doc','--scope','write','--user-id','hcd-collaboration','--ttl-seconds',3600)['token']
with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
origin=f'http://127.0.0.1:{port}/v1/documents/doc';base_headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1','X-HCD-Flow-Layout-Version':'2','X-HCD-Collaboration-Epoch':'1','X-HCD-Collaboration-Protocol':'hcd-word-regions/2'}
log=open(root/'native.log','w');server=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{port}'],env=env,cwd=root,stdout=log,stderr=log)
def http(route,body=None,headers=None):
 request=urllib.request.Request(origin+route,headers={**base_headers,**(headers or {})},data=None if body is None else json.dumps(body).encode())
 try:
  with urllib.request.urlopen(request,timeout=45) as response:return response.status,json.loads(response.read())
 except urllib.error.HTTPError as error:return error.code,json.loads(error.read())
lease=None
owner_headers={'X-HCD-Coordinator-Version':'5','X-HCD-Word-Story-Recovery':'1'}
def owner(action):
 global lease
 body={'version':1,'epoch':1,'ownerId':'a'*32,'storeId':'b'*32,'action':action,'journalHashes':['none','c'*64] if action!='acquire' else ['none']}
 if lease:body['leaseId']=lease['leaseId']
 status,value=http('/collaboration/word-owner',body,owner_headers);assert status==200,(status,value);lease=value
def call(route,body,extra=None):
 owner('renew')
 headers={'X-HCD-Coordinator-Version':'7','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Story-Version':'1','X-HCD-Word-Link-Version':'1','X-HCD-Word-Owner':lease['leaseId'],'X-HCD-Word-Owner-Id':lease['ownerId'],'X-HCD-Word-Journal-Hash':lease['journalHash']}
 return http(route,body,{**headers,**(extra or {})})
def projection(revision=None):return cli('editor-state',bundle,*([] if revision is None else ['--revision',revision]))
def body_edit(label):
 p=projection();block=next(b for b in p['blocks'] if b['region']=='body' and b['content'].get('inlines'));content=copy.deepcopy(block['content']);content['inlines'][0]['text']+=' · '+label
 patch={'schemaVersion':'hcd-patch/6','documentId':'doc','patchId':label,'baseRevision':p['revision'],'layoutHash':p['flowLayoutHash'],'regions':[{'regionId':block['flowRegionId'],'operations':[{'op':'block.replace','blockId':block['blockId'],'block':content,'precondition':{'blockHash':block['blockHash']}}]}]}
 path=root/'body-patch.json';path.write_text(json.dumps(patch));return cli('apply',bundle,'--patch',path,'--expected-revision',p['revision'])['revision']
def page_edit(nonce):
 p=projection();section=p['flowLayout']['sections'][0];width=section['page']['widthTwips'];body={'coordinatorId':'e'*32,'transaction':{'schemaVersion':'hcd-word-layout-transaction/1','documentId':'doc','transactionId':nonce,'baseRevision':p['revision'],'expectedRevision':p['revision'],'actor':{'userId':'alice','displayName':'Alice 王'},'edits':{'schemaVersion':'hcd-word-layout-edits/1','baseLayoutHash':p['flowLayoutHash'],'changes':[{'sectionId':section['id'],'field':'widthTwips','expected':width,'value':width+100}]}}}
 status,value=call('/word/layout-transactions',body,{'X-HCD-Coordinator-Version':'6' if p['revision']<4 else '7'});assert status==200,(status,value);return value['revision']
def file_text(path):
 with zipfile.ZipFile(path) as docx:return '\n'.join(''.join(ET.fromstring(docx.read(name)).itertext()) for name in docx.namelist() if name.startswith('word/') and name.endswith('.xml'))
result={'scope':'native HTTP with explicitly owned fixture; no live sidecar/member lifecycle','linkUI':False,'signedCoordinatorJournal':False,'production':False,'externalOffice':False}
try:
 deadline=time.monotonic()+45
 while True:
  assert server.poll() is None
  try:
   status,_=http('/auth')
   if status==200:break
  except OSError:pass
  assert time.monotonic()<deadline;time.sleep(.1)
 owner('acquire');owner('record');body_edit('Before coordinated link');page_edit('4'*32)
 p=projection();layout=p['flowLayout'];transaction={'schemaVersion':'hcd-word-story-link/1','documentId':'doc','transactionId':'d'*32,'expectedRevision':p['revision'],'actor':{'userId':'alice','displayName':'Alice 王'},'link':{'baseLayoutHash':p['flowLayoutHash'],'sectionId':layout['sections'][1]['id'],'kind':'header','variant':'even','expectedDirectStoryId':layout['sections'][1]['headers']['even']}}
 status,preview=call('/word/link-preflight',{'coordinatorId':'e'*32,'transaction':transaction});assert status==200,(status,preview)
 prepared={'coordinatorId':'e'*32,'transaction':transaction,'candidateLayoutHash':preview['candidateLayoutHash'],'reviewHash':preview['reviewHash']}
 (out/'prepared.json').write_text(json.dumps(prepared,ensure_ascii=False,indent=2)+'\n')
 status,saved=call('/word/link-transactions',prepared);assert status==200,(status,saved);link_revision=saved['revision'];assert link_revision==4
 status,replay=call('/word/link-transactions',prepared);assert status==200 and replay['idempotentReplay'] is True and replay['revision']==link_revision
 linked=projection();assert linked['blocks']==p['blocks'];assert linked['flowLayout']['stories']==layout['stories'];assert 'even' not in linked['flowLayout']['sections'][1]['headers']
 receipt_request={'apiHash':'1'*64,'pendingHash':'2'*64,'initialUpdateHash':'3'*64,'prepared':prepared}
 status,first=call('/word/link-receipt',receipt_request);assert status==200,(status,first)
 status,denied=call('/word/topology-cancel',{'transactionId':transaction['transactionId'],'actor':transaction['actor']});assert status==409,(status,denied)
 import base64,hmac
 message=['hcd-word-link-receipt/1',receipt_request['apiHash'],'doc',1,'e'*32,first['journalHash'],3,4,'d'*32,first['requestHash'],receipt_request['pendingHash'],first['rootHash'],transaction['link']['baseLayoutHash'],prepared['candidateLayoutHash'],prepared['reviewHash'],receipt_request['initialUpdateHash']]
 expected=base64.urlsafe_b64encode(hmac.new(env['HCD_TOKEN_SECRET'].encode(),json.dumps(message,ensure_ascii=False,separators=(',',':')).encode(),hashlib.sha256).digest()).decode().rstrip('=');assert first['signature']==expected
 body_edit('After coordinated link');mixed_revision=page_edit('5'*32);assert mixed_revision==6
 assert call('/word/link-receipt',receipt_request)==(200,first);assert call('/word/link-transactions',prepared)[1]['revision']==4;assert projection()['revision']==6
 cli('restore',bundle,'--revision',3,'--expected-revision',6);assert projection()['revision']==7;assert call('/word/link-receipt',receipt_request)==(200,first);assert call('/word/link-transactions',prepared)[1]['revision']==4;assert projection()['revision']==7
 assert projection()['flowLayout']['sections'][1]['headers']['even']==layout['sections'][1]['headers']['even']
 assert call('/word/topology-cancel',{'transactionId':transaction['transactionId'],'actor':transaction['actor']})[0]==409
 fresh=copy.deepcopy(transaction);fresh['transactionId']='f'*32;fresh['expectedRevision']=7;fresh['link']['baseLayoutHash']=projection()['flowLayoutHash']
 status,fresh_review=call('/word/link-preflight',{'coordinatorId':'e'*32,'transaction':fresh});assert status==200,(status,fresh_review)
 assert call('/word/topology-cancel',{'transactionId':fresh['transactionId'],'actor':fresh['actor']})[0]==200
 assert call('/word/link-transactions',{'coordinatorId':'e'*32,'transaction':fresh,'candidateLayoutHash':fresh_review['candidateLayoutHash'],'reviewHash':fresh_review['reviewHash']})[0]==409
 assert projection()['revision']==7
 for revision in range(1,8):
  target=out/f'r{revision}.docx';cli('export',bundle,'--revision',revision,'--output',target);text=file_text(target)
  assert ('Before coordinated link' in text)==(revision>=2)
  assert ('After coordinated link' in text)==(revision in [5,6])
  imported=root/f'reimport-{revision}.hcd';cli('import',target,'--word-regions','--document-id','roundtrip','--output',imported)
  roundtrip=projection(revision)['flowLayout'];meta=cli('editor-state',imported)['flowLayout'];assert ('even' in meta['sections'][1]['headers'])==(revision not in [4,5,6])
  assert meta['sections'][0]['page']['widthTwips']==roundtrip['sections'][0]['page']['widthTwips']
 with zipfile.ZipFile(source) as incoming:media={sha for sha in [hashlib.sha256(incoming.read(name)).hexdigest() for name in incoming.namelist() if name.startswith('word/media/') and not name.endswith('/')]}
 for revision in [3,4,6,7]:
  with zipfile.ZipFile(out/f'r{revision}.docx') as docx:assert media.issubset({hashlib.sha256(docx.read(name)).hexdigest() for name in docx.namelist() if name.startswith('word/media/') and not name.endswith('/')})
 unsupported=out/'unsupported-source.docx';source_attempt=subprocess.run([str(binary),'hdoc','export',str(bundle),'--revision','6','--source',str(source),'--output',str(unsupported),'--json'],capture_output=True,text=True,cwd=root,env=env,timeout=90);assert source_attempt.returncode!=0 and not unsupported.exists()
 source_error=source_attempt.stdout+'\n'+source_attempt.stderr;assert 'source Word region text' in source_error and 'non-text edits' in source_error,source_error
 (out/'source-export-refusal.json').write_text(json.dumps({'scope':'known unsupported mixed source-preserving export','diagnostic':source_error},ensure_ascii=False,indent=2)+'\n')
 archive=out/'mixed-history.hcdz';cli('pack',bundle,'--revision',7,'--output',archive);offline=root/'offline.hcd';cli('unpack',archive,'--output',offline);cli('validate',bundle);cli('validate',offline)
 for revision in range(1,8):assert projection(revision)==cli('editor-state',offline,'--revision',revision)
 result.update(nativeBinarySha256=sha(binary),linkRevision=4,mixedRevision=6,restoredRevision=7,exactReplayAfterLaterSavesAndRestore=True,historicalSignedReceiptStable=True,signatureVerified=True,contentAndImageBytesPreserved=True,docxReimportVerifiedRevisions=list(range(1,8)),offlineProjectionVerifiedRevisions=list(range(1,8)),nativeAndOfflineValidate=True,sourcePreservingMixedExport=False,completedCancellationRefused=True,unpreparedCancellationSealed=True)
 for path in out.rglob('*'):
  if path.is_file():assert env['HCD_TOKEN_SECRET'].encode() not in path.read_bytes() and token.encode() not in path.read_bytes(),path
except Exception as error:
 (out/'failure.json').write_text(json.dumps({'message':str(error),'scope':result['scope']},ensure_ascii=False,indent=2)+'\n');raise
finally:
 server.terminate()
 try:server.wait(timeout=8)
 except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
 log.close();shutil.copyfile(root/'native.log',out/'native.log');shutil.rmtree(root)
 result['ownedNativeServiceStopped']=True;result['privateFixtureRemoved']=not root.exists()
 (out/'service-files.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False))
