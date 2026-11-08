#!/usr/bin/env python3
"""Actual revision/export verification of the named concurrent-owner fixture."""
import gzip,hashlib,json,shutil,subprocess,sys,tempfile,urllib.request,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';before=(bundle/'manifest.json').read_bytes();head=int(sys.argv[3]) if len(sys.argv)>3 else 8;assert head in [8,10];assert json.loads(before)['revision']==head;added=head-2;undone=head-1
 binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-owner-race-2026-10-26';work=Path(tempfile.mkdtemp(prefix='owner-files-',dir=root));identity=json.loads((root/'owner-identities.json').read_text());opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));expected={item['user']:item for item in identity['items']}
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 def state(revision,source=bundle):return cli('editor-state',source,'--revision',revision)
 def text(content):return ''.join(item['text'] for item in content['inlines'])+''.join(text(child) for child in content.get('children',[]))
 def nodes(projection):
  result=[]
  def visit(content):
   if content.get('extension'):result.append(content['extension'])
   result.extend(item['extension'] for item in content['inlines'] if item.get('extension'))
   for child in content.get('children',[]):visit(child)
  for block in projection['blocks']:visit(block['content'])
  return {item['instanceId']:item for item in result}
 def references(revision):return json.load(opener.open(urllib.request.Request(c['origin']+f'/v1/documents/mentions-docx/references?revision={revision}',headers={'Authorization':'Bearer '+c['reader'],'X-HCD-Node-Edits-Version':'5'}),timeout=30))
 projections={revision:state(revision) for revision in range(1,head+1)};original=next(block for block in projections[1]['blocks'] if text(block['content'])=='Original');image=next(block for block in projections[1]['blocks'] if block['readOnly']);records=[]
 for revision in range(2,head+1):
  projection=projections[revision];original_now=next(block for block in projection['blocks'] if 'Original' in text(block['content']));assert original_now['blockId']==original['blockId'];assert sum(text(block['content']).count('Original') for block in projection['blocks'])==1;assert next(block for block in projection['blocks'] if block['blockId']==image['blockId'])==image
  users=['bob'] if revision==3 else ['alice','bob'];assert nodes(projection)=={expected[user]['extension']['instanceId']:expected[user]['extension'] for user in users};refs=references(revision);assert len(refs['items'])==len(users);assert refs['reminders']=={'enabled':False,'delivery':'disabled'};events=refs['transition']['events']
  if revision==2:
   assert len(events)==2
   for event in events:assert event['kind']=='reference.created' and event['mentionId']==expected[event['target']['id']]['reference']['mentionId'] and event['context']['actorId']==event['target']['id']
  elif revision in [3,4]:assert len(events)==1 and events[0]['mentionId']==expected['alice']['reference']['mentionId'] and events[0]['context']['actorId']=='alice' and events[0]['kind']==('reference.removed' if revision==3 else 'reference.created')
  else:assert not events
  output=work/f'owner-r{revision}.docx';cli('export',bundle,'--revision',revision,'--to','docx','--output',output);shutil.copyfile(output,assets/output.name);records.append({'revision':revision,'blocks':len(projection['blocks']),'originalRootId':original_now['blockId'],'originalImageExact':True,'businessNodesExact':True,'events':events})
 assert projections[5]['blocks']==projections[undone]['blocks'];assert projections[added]['blocks']==projections[head]['blocks']
 def verify(path,revision=None):
  if revision is None:revision=head
  value=path.read_text() if path.suffix=='.md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  assert value.count('Original')==1 and value.count('Bob 并发新增')==1 and value.count('@Bob 李')==1 and value.count('导出资料：Bob 分支资料')==1
  for token in ['Alice 并发新增','@Alice 王','导出资料：Alice 分支资料']:assert value.count(token)==(0 if revision==3 else 1),(path,token,value)
  assert value.count('Bob 后续协作输入')==(1 if revision>=5 else 0)
  assert value.count('浏览器追加')==(1 if revision in [added,head] else 0)
 for revision in range(2,head+1):verify(work/f'owner-r{revision}.docx',revision)
 archive=work/f'owner-r{head}.hcdz';offline=work/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',head,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 for revision in range(1,head+1):assert state(revision,offline)==projections[revision]
 record=json.loads((offline/f'revisions/{head:020}.json').read_text());raw=(offline/record['assetIndexHref']).read_bytes();index=json.loads(gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw);resource=identity['resource'];entry=next(item for item in index if item['hash']==resource['hash']);data=(offline/entry['href']).read_bytes();assert len(data)==resource['byteLength'] and hashlib.sha256(data).hexdigest()==resource['hash']
 files=[]
 for fmt in ['docx','pptx','pdf','md']:
  output=work/f'offline-r{head}.{fmt}';cli('export',offline,'--revision',head,'--to',fmt,'--output',output);verify(output);shutil.copyfile(output,assets/output.name);files.append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
 download=Path(sys.argv[2]);verify(download);shutil.copyfile(download,assets/f'browser-r{head}.docx');shutil.copyfile(archive,assets/archive.name)
 with zipfile.ZipFile(download) as docx:
  assert resource['hash'] in {hashlib.sha256(docx.read(name)).hexdigest() for name in docx.namelist() if '/media/' in name};pictures=sum(1 for name in docx.namelist() if name.endswith('.xml') for element in ET.fromstring(docx.read(name)).iter() if element.tag=='{http://schemas.openxmlformats.org/drawingml/2006/picture}pic');assert pictures==3
 probes=[json.loads(path.read_text()) for path in sorted((root/'checkpoint-probe').glob('*.json'))];assert len(probes)==head-1 and all(probe['status']==200 for probe in probes) and [probe['request']['expectedRevision'] for probe in probes]==list(range(1,head));(assets/'checkpoint-evidence.json').write_text(json.dumps([{'status':probe['status'],'expectedRevision':probe['request']['expectedRevision'],'blocks':len(probe['request']['blocks'])} for probe in probes],indent=2)+'\n')
 assert (bundle/'manifest.json').read_bytes()==before;evidence={'scope':f'Actual native r2-r{head}, browser DOCX, source-free exports, identities and reference events. Not service restart, real Office or production acceptance.','head':head,'revisions':records,'originalRootIdStable':True,'imageExact':True,'businessPayloadsExact':True,'resourceBytesExact':True,'browserUndoRestoresExactRevision':5,'browserRedoRestoresExactRevision':added,'sourceFreeAllRevisionsExact':list(range(1,head+1)),'browserPictures':pictures,'firstNativeCheckpoints':head-1,'all200':True,'files':files,'headUnchanged':True};(assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(f'PASS r2-r{head} identity/source/image/reference checks, exact UI undo5={undone} and redo{added}={head}, browser DOCX, source-free HCD/DOCX/PPTX/PDF/MD; {head-1} first checkpoints200; head{head} unchanged')

if __name__=='__main__':main()
