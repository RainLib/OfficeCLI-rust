#!/usr/bin/env python3
"""Verify immutable list recovery revisions and source-free exports of an owned fixture."""
import gzip,hashlib,json,shutil,subprocess,sys,tempfile,urllib.request,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-')
 bundle=root/'mentions-docx.hcd';before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==5;identities=json.loads((root/'list-identities.json').read_text());binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-list-recovery-2026-10-25';work=Path(tempfile.mkdtemp(prefix='list-files-',dir=root));opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 def state(revision,source=bundle):return cli('editor-state',source,'--revision',revision)
 def text(content):return ''.join(item['text'] for item in content['inlines'])+''.join(text(child) for child in content.get('children',[]))
 def refs(revision):return json.load(opener.open(urllib.request.Request(config['origin']+f'/v1/documents/mentions-docx/references?revision={revision}',headers={'Authorization':'Bearer '+config['reader'],'X-HCD-Node-Edits-Version':'5'}),timeout=30))
 def nodes(projection):
  found=[]
  def visit(content):
   if content.get('extension'):found.append(content['extension'])
   found.extend(item['extension'] for item in content['inlines'] if item.get('extension'))
   for child in content.get('children',[]):visit(child)
  for block in projection['blocks']:visit(block['content'])
  return found
 projections={revision:state(revision) for revision in range(1,6)};original=next(block for block in projections[3]['blocks'] if text(block['content'])=='Original');image=next(block for block in projections[3]['blocks'] if block['readOnly'])
 records=[]
 for revision in [3,4,5]:
  projection=projections[revision];assert next(block for block in projection['blocks'] if text(block['content'])=='Original')==original;assert next(block for block in projection['blocks'] if block['blockId']==image['blockId'])==image
  assert nodes(projection)==([] if revision==3 else [identities['extension']]);references=refs(revision);assert len(references['items'])==(0 if revision==3 else 1);assert references['reminders']=={'enabled':False,'delivery':'disabled'}
  if revision==4:assert len(references['transition']['events'])==1 and references['transition']['events'][0]['kind']=='reference.created' and references['transition']['events'][0]['context']['actorId']=='bob'
  if revision==5:assert not references['transition']['events']
  actor=json.loads((bundle/'revisions'/f'{revision:020}.json').read_text())['authorId'];assert actor==('alice' if revision==3 else 'bob')
  records.append({'revision':revision,'actor':actor,'canonicalBlocks':len(projection['blocks']),'referenceEvents':references['transition']['events'],'originalAndImageExact':True})
 def new_item(projection):return next(block for block in projection['blocks'] if '列表迟到新项' in text(block['content']))
 assert new_item(projections[4])==new_item(projections[5]);old=next(block for block in projections[5]['blocks'] if '旧列表项迟到的新段' in text(block['content']));assert old['blockId'] not in [original['blockId'],new_item(projections[5])['blockId']]
 def verify(path,revision=5):
  value=path.read_text() if path.suffix=='.md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  assert value.count('Original')==1
  for token in ['列表迟到新项','@Bob 李','导出资料：列表资源']:assert value.count(token)==(0 if revision==3 else 1),(path,token,value)
  assert value.count('旧列表项迟到的新段')==(1 if revision==5 else 0)
 for revision in [3,4,5]:
  output=work/f'list-r{revision}.docx';cli('export',bundle,'--revision',revision,'--to','docx','--output',output);verify(output,revision);shutil.copyfile(output,assets/output.name)
 archive=work/'list-r5.hcdz';offline=work/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',5,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 for revision in range(1,6):assert state(revision,offline)==projections[revision]
 record=json.loads((offline/'revisions/00000000000000000005.json').read_text());raw=(offline/record['assetIndexHref']).read_bytes();index=json.loads(gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw);resource=identities['resource'];item=next(item for item in index if item['hash']==resource['hash']);data=(offline/item['href']).read_bytes();assert len(data)==resource['byteLength'] and hashlib.sha256(data).hexdigest()==resource['hash']
 files=[]
 for fmt in ['docx','pptx','pdf','md']:
  output=work/f'offline-r5.{fmt}';cli('export',offline,'--revision',5,'--to',fmt,'--output',output);verify(output);shutil.copyfile(output,assets/output.name);files.append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
 download=Path(sys.argv[2]);verify(download);shutil.copyfile(download,assets/'browser-r5.docx');shutil.copyfile(archive,assets/archive.name)
 with zipfile.ZipFile(download) as docx:
  assert resource['hash'] in {hashlib.sha256(docx.read(name)).hexdigest() for name in docx.namelist() if '/media/' in name}
  pictures=sum(1 for name in docx.namelist() if name.endswith('.xml') for element in ET.fromstring(docx.read(name)).iter() if element.tag=='{http://schemas.openxmlformats.org/drawingml/2006/picture}pic');assert pictures==2
 checkpoints=[json.loads(path.read_text()) for path in sorted((root/'checkpoint-probe').glob('*.json'))];assert len(checkpoints)==4 and [item['status'] for item in checkpoints]==[200]*4 and [item['request']['expectedRevision'] for item in checkpoints]==[1,2,3,4]
 (assets/'checkpoint-evidence.json').write_text(json.dumps([{'status':item['status'],'expectedRevision':item['request']['expectedRevision'],'revision':item['response']['data']['revision'] if 'data' in item['response'] else item['response']['revision'],'blocks':len(item['request']['blocks'])} for item in checkpoints],indent=2)+'\n')
 assert (bundle/'manifest.json').read_bytes()==before;evidence={'scope':'Actual localhost native immutable revisions, browser DOCX and source-free archive/exports. Not real Office, service restart or production acceptance.','head':5,'revisions':records,'stableSurvivingItem':True,'independentReappearingItem':True,'businessEnvelopeExact':True,'resourceBytesExact':True,'originalAndImageExact':True,'sourceFreeAllRevisionsExact':True,'browserPictures':pictures,'noDuplicateMentionEvent':True,'files':files,'headUnchanged':True};(assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS r3/r4/r5 original+image exact, list slot identities, Bob reference actor, resource bytes, browser DOCX and source-free HCD/DOCX/PPTX/PDF/MD; first four native checkpoints200; head5 unchanged')

if __name__=='__main__':main()
