#!/usr/bin/env python3
"""Strict actual-file checks for the named inline-deletion preview fixture."""
import gzip,hashlib,json,shutil,subprocess,sys,tempfile,urllib.request,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==7
 assets=repo/(sys.argv[3] if len(sys.argv)>3 else 'docs/assets/hcd-inline-deletion-2026-10-26');strict_sources=len(sys.argv)>4 and sys.argv[4]=='--strict-sources';binary=repo/'target/debug/officecli';work=Path(tempfile.mkdtemp(prefix='inline-files-',dir=root));identity=json.loads((root/'inline-identities.json').read_text());extra=json.loads((root/'inline-history-identity.json').read_text());resource=identity['resource'];opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 def state(revision,source=bundle):return cli('editor-state',source,'--revision',revision)
 def text(content):return ''.join(item['text'] for item in content['inlines'])+''.join(text(child) for child in content.get('children',[]))
 def nodes(projection):return {item['extension']['instanceId']:item['extension'] for block in projection['blocks'] for item in block['content']['inlines'] if item.get('extension')}
 projections={revision:state(revision) for revision in range(1,8)};initial=projections[1]['blocks'];image=next(block for block in initial if block['readOnly']);records=[]
 for revision in range(2,8):
  projection=projections[revision];assert all(next(block for block in projection['blocks'] if block['blockId']==old['blockId'])==old for old in initial);assert sum(text(block['content']).count('Original') for block in projection['blocks'])==1
  expected={} if revision==3 else {identity['extension']['instanceId']:'删除前的资料' if revision==2 else 'Bob 删除后的资料修改'}
  if revision in [5,7]:expected[extra['instanceId']]='撤销插入验证' if revision==5 else 'Bob 撤销后迟到的资料修改'
  values=nodes(projection);assert set(values)==set(expected)
  for key,title in expected.items():assert values[key]['data']['title']==title and values[key]['resources']==[resource]
  response=opener.open(urllib.request.Request(c['origin']+f'/v1/documents/mentions-docx/references?revision={revision}',headers={'Authorization':'Bearer '+c['reader'],'X-HCD-Node-Edits-Version':'6'}));refs=json.load(response);assert refs['reminders']=={'enabled':False,'delivery':'disabled'};assert len(refs['items'])==(0 if revision==3 else 1);events=refs['transition']['events']
  if revision in [2,3,4]:assert len(events)==1 and events[0]['mentionId']==identity['reference']['mentionId'] and events[0]['context']['actorId']=='alice' and events[0]['kind']==('reference.removed' if revision==3 else 'reference.created')
  else:assert not events
  record={'revision':revision,'businessNodes':expected,'referenceEvents':events};records.append(record)
  output=work/f'inline-r{revision}.docx';cli('export',bundle,'--revision',revision,'--to','docx','--output',output);shutil.copyfile(output,assets/output.name)
 def semantic_blocks(projection):
  blocks=json.loads(json.dumps(projection['blocks']))
  def strip(content):
   for inline in content['inlines']:inline.pop('nodeId',None)
   for child in content.get('children',[]):strip(child)
  for block in blocks:block.pop('blockHash',None);strip(block['content'])
  return blocks
 assert semantic_blocks(projections[4])==semantic_blocks(projections[6])
 if strict_sources:
  assert projections[4]['blocks']==projections[6]['blocks']
  initial_inlines=projections[2]['blocks'][-1]['content']['inlines']
  retained_text=[initial_inlines[index] for index in [0,2,4]]
  assert projections[3]['blocks'][-1]['content']['inlines']==retained_text
  assert [projections[4]['blocks'][-1]['content']['inlines'][index] for index in [0,2,4]]==retained_text
  original_inlines=projections[4]['blocks'][-1]['content']['inlines']
  for revision in [5,6,7]:assert projections[revision]['blocks'][-1]['content']['inlines'][:len(original_inlines)]==original_inlines
 # Historical mode can replay the earlier regenerated-source fixture. The new
 # strict mode additionally requires the canonical equalities above; neither
 # mode permits duplicate source IDs.
 for projection in projections.values():
  ids=[inline['nodeId'] for block in projection['blocks'] for inline in block['content']['inlines'] if inline.get('nodeId')];assert len(ids)==len(set(ids))
 def verify(path,revision=7):
  value=path.read_text() if path.suffix=='.md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  assert value.count('Original')==1 and value.count('行内删除验证：')==1 and value.count('保留周围文字。')==1
  assert value.count('@Alice 王')==(1 if revision==2 else 0);assert value.count('@Bob 李')==(0 if revision in [2,3] else 1)
  for token,active in [('导出资料：删除前的资料',revision==2),('导出资料：Bob 删除后的资料修改',revision in [4,5,6,7]),('导出资料：撤销插入验证',revision==5),('导出资料：Bob 撤销后迟到的资料修改',revision==7)]:assert value.count(token)==int(active),(path,token,value)
 for revision in range(2,8):verify(work/f'inline-r{revision}.docx',revision)
 archive=work/'inline-r7.hcdz';offline=work/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',7,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 for revision in range(1,8):assert state(revision,offline)==projections[revision]
 record=json.loads((offline/'revisions/00000000000000000007.json').read_text());raw=(offline/record['assetIndexHref']).read_bytes();index=json.loads(gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw);entry=next(item for item in index if item['hash']==resource['hash']);data=(offline/entry['href']).read_bytes();assert len(data)==resource['byteLength'] and hashlib.sha256(data).hexdigest()==resource['hash']
 files=[]
 for fmt in ['docx','pptx','pdf','md']:
  output=work/f'offline-r7.{fmt}';cli('export',offline,'--revision',7,'--to',fmt,'--output',output);verify(output);shutil.copyfile(output,assets/output.name);files.append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
 download=Path(sys.argv[2]);verify(download);shutil.copyfile(download,assets/'browser-r7.docx');shutil.copyfile(archive,assets/archive.name)
 with zipfile.ZipFile(download) as docx:
  assert resource['hash'] in {hashlib.sha256(docx.read(name)).hexdigest() for name in docx.namelist() if '/media/' in name};pictures=sum(1 for name in docx.namelist() if name.endswith('.xml') for element in ET.fromstring(docx.read(name)).iter() if element.tag=='{http://schemas.openxmlformats.org/drawingml/2006/picture}pic');assert pictures==3
 probes=[json.loads(path.read_text()) for path in sorted((root/'checkpoint-probe').glob('*.json'))];assert len(probes)==6 and all(probe['status']==200 for probe in probes) and [probe['request']['expectedRevision'] for probe in probes]==list(range(1,7));(assets/'checkpoint-evidence.json').write_text(json.dumps([{'status':probe['status'],'expectedRevision':probe['request']['expectedRevision']} for probe in probes],indent=2)+'\n')
 assert (bundle/'manifest.json').read_bytes()==before;(assets/'file-evidence.json').write_text(json.dumps({'scope':'Actual immutable revisions, browser DOCX, source-free offline exports. Not real Office, service restart or production acceptance.','head':7,'revisions':records,'originalBlocksExact':True,'undoExactSemanticAndBlockIdentity':[4,6],'exactCanonicalSourceUndo':strict_sources,'textSourceIdentityBoundary':'Retained owned inline IDs and exact canonical undo verified' if strict_sources else 'Existing native structural Replace regenerates later text-source IDs; exact canonical equality is not claimed','businessIdentitiesAndResourcesExact':True,'sourceFreeAllRevisionsExact':list(range(1,8)),'resourceBytesExact':True,'browserPictures':pictures,'firstCheckpoints':6,'all200':True,'files':files,'headUnchanged':True},ensure_ascii=False,indent=2)+'\n');print('PASS native r2-r7, '+('exact canonical undo4=6, stable sources4/5/6/7,' if strict_sources else 'exact semantic undo4=6,')+' original blocks, business/mention IDs and actors, browser DOCX, source-free HCD/DOCX/PPTX/PDF/MD; first checkpoints200; head7 unchanged')

if __name__=='__main__':main()
