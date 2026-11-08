#!/usr/bin/env python3
"""Read-only validation of the named typed-source repair fixture through r14."""
import gzip,hashlib,json,subprocess,sys,tempfile,urllib.request,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==14
 binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-source-repair-2026-10-25';assets.mkdir(exist_ok=True);out=Path(tempfile.mkdtemp(prefix='source-repair-files-',dir=root));initial=json.loads((root/'business-initial-evidence.json').read_text());opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 def state(revision,source=bundle):return cli('editor-state',source,'--revision',revision)
 def nodes(projection):
  result={}
  def visit(block):
   for node in [block.get('extension'),*[part.get('extension') for part in block['inlines']]]:
    if node:assert node['instanceId'] not in result;result[node['instanceId']]=node
   for child in block.get('children',[]):visit(child)
  for block in projection['blocks']:visit(block['content'])
  return result
 def refs(revision):return json.load(opener.open(urllib.request.Request(c['origin']+f'/v1/documents/mentions-docx/references?revision={revision}',headers={'Authorization':'Bearer '+c['reader'],'X-HCD-Node-Edits-Version':'4'}),timeout=45))
 old={node['instanceId']:node for node in initial['nodes']};copied=nodes(state(7));fresh=set(copied)-set(old);assert len(old)==6 and len(fresh)==3
 evidence={'scope':'Actual native r6-r14, canonical source IDs, actors/references, offline archive/exports and actual browser DOCX. Error controls are separate captures. No production, real Office or device-IME acceptance.','head':14,'revisions':[],'files':[]};tail_source=None
 for revision in range(6,15):
  projection=state(revision);current=nodes(projection);present=revision not in [6,8];count=2 if present else 1;assert set(current)==set(old)|(fresh if present else set());assert all(value==copied[key] for key,value in current.items());references=refs(revision);assert references==refs(revision);assert references['reminders']=={'enabled':False,'delivery':'disabled'} and len(references['items'])==count
  events=references['transition']['events']
  if revision in [7,8,9]:assert len(events)==1 and events[0]['kind']==('reference.removed' if revision==8 else 'reference.created') and events[0]['context']['actorId']=='alice'
  else:assert not events
  if revision>=10:
   record=json.loads((bundle/'revisions'/f'{revision:020}.json').read_text());assert record['authorId']==('bob' if revision==10 else 'alice');ids={part['nodeId'] for part in projection['blocks'][-1]['content']['inlines']};assert len(ids)==1
   if tail_source is None:tail_source=ids
   else:assert ids==tail_source
  output=out/f'source-r{revision}.docx';cli('export',bundle,'--revision',revision,'--to','docx','--output',output);text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True)
  assert text.count('@Alice 王')==count and text.count('Alice 离线输入')==count and text.count('Bob 离线输入')==count;assert text.count('Bob 在扩展卸载后继续协作')==(1 if revision>=10 else 0)
  assert text.count('页面输入')==(1 if revision>=11 else 0);assert text.count('页面输入验证')==(1 if revision in [12,14] else 0)
  (assets/output.name).write_bytes(output.read_bytes());evidence['revisions'].append({'revision':revision,'businessNodes':len(current),'clonePresent':present,'allEnvelopesUnchanged':True,'references':references})
 archive=out/'source-r14.hcdz';offline=out/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',14,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 for revision in range(6,15):assert state(revision,offline)==state(revision)
 (assets/archive.name).write_bytes(archive.read_bytes());record=json.loads((offline/'revisions/00000000000000000014.json').read_text());raw=(offline/record['assetIndexHref']).read_bytes();index=json.loads(gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw);indexed={item['hash']:item for item in index}
 for resource in initial['resources']:
  data=(offline/indexed[resource['hash']]['href']).read_bytes();assert hashlib.sha256(data).hexdigest()==resource['hash'] and len(data)==resource['byteLength']
 def verify(path):
  text=path.read_text() if path.suffix=='.md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  assert text.count('@Alice 王')==2 and text.count('Alice 离线输入')==2 and text.count('Bob 离线输入')==2 and text.count('导出资料：容器内资料')==2 and text.count('Bob 在扩展卸载后继续协作')==1 and text.count('页面输入验证')==1
 for fmt in ['docx','pptx','pdf','md']:
  output=out/f'source-offline-r14.{fmt}';cli('export',offline,'--revision',14,'--to',fmt,'--output',output);verify(output);(assets/output.name).write_bytes(output.read_bytes());evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'sourceAndHostNotRequired':True})
 downloaded=Path(sys.argv[2]);assert downloaded.is_file() and downloaded.suffix=='.docx';verify(downloaded);(assets/'browser-r14.docx').write_bytes(downloaded.read_bytes())
 with zipfile.ZipFile(root/'sources/mentions-docx.docx') as source,zipfile.ZipFile(downloaded) as docx:
  source_hashes={hashlib.sha256(source.read(path)).hexdigest() for path in source.namelist() if '/media/' in path};assert source_hashes.issubset({hashlib.sha256(docx.read(path)).hexdigest() for path in docx.namelist() if '/media/' in path});pictures=sum(1 for path in docx.namelist() if path.endswith('.xml') for element in ET.fromstring(docx.read(path)).iter() if element.tag=='{http://schemas.openxmlformats.org/drawingml/2006/picture}pic');assert pictures==4
 assert (bundle/'manifest.json').read_bytes()==before;evidence.update(sourceFreeArchiveValid=True,resourceBytesPreserved=True,sourceImageBytesPreserved=True,pictures=4,browserDownloadVerified=True,tailSourceIdsStableR10ToR14=sorted(tail_source),headUnchanged=True)
 (assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS r6-r14 actor, source/occurrence identity, own undo keeps Bob, browser DOCX and source-free HCD/DOCX/PPTX/PDF/MD; head14 unchanged.')
if __name__=='__main__':main()
