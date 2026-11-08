#!/usr/bin/env python3
"""Read-only verification for the named business-container copy/concurrency fixture."""
import gzip,hashlib,json,subprocess,sys,tempfile,urllib.request,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==13;binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-business-blocks-2026-10-25';out=Path(tempfile.mkdtemp(prefix='business-files-',dir=root));initial=json.loads((root/'business-initial-evidence.json').read_text());socket=json.loads((assets/'socket-evidence.json').read_text());old={node['instanceId']:node for node in initial['nodes']};fresh=set(socket['newIds']);clone_id=socket['cloneId'];reference_id=socket['cloneReference']['mentionId'];opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
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
 def references(revision):return json.load(opener.open(urllib.request.Request(config['origin']+f'/v1/documents/mentions-docx/references?revision={revision}',headers={'Authorization':'Bearer '+config['reader'],'X-HCD-Node-Edits-Version':'4'}),timeout=45))
 with zipfile.ZipFile(root/'sources/mentions-docx.docx') as archive:source_images={hashlib.sha256(archive.read(path)).hexdigest() for path in archive.namelist() if '/media/' in path}
 evidence={'scope':'Actual saved native r6-r13, authenticated reference/events, CUA r7 copy/r13 property+download, offline archive and actual files. Socket actions separately prove move/delete/undo. No production or real Office acceptance.','root':str(root),'head':13,'revisions':[],'files':[]};resource_hashes={r['hash'] for r in initial['resources']};assert len(old)==6 and len(fresh)==3
 for revision in range(6,14):
  projection=state(revision);current=nodes(projection);present=revision not in [6,9,11];count=2 if present else 1;assert set(current)==set(old)|(fresh if present else set());assert all(current[key]==value for key,value in old.items())
  if present:
   assert current[clone_id]['data']['title']==('副本容器' if revision==13 else '团队记录')
   for node in current.values():
    if node.get('resources'):assert {r['hash'] for r in node['resources']}==resource_hashes
  refs=references(revision);assert refs==references(revision) and refs['reminders']=={'enabled':False,'delivery':'disabled'};assert len(refs['items'])==count;assert (reference_id in {item['reference']['mentionId'] for item in refs['items']})==present
  events=refs['transition']['events'];kind={7:'reference.created',9:'reference.removed',10:'reference.created',11:'reference.removed',12:'reference.created'}.get(revision)
  if kind:assert len(events)==1 and events[0]['kind']==kind and events[0]['mentionId']==reference_id and events[0]['context']['actorId']=='alice',events
  else:assert not events
  output=out/f'business-r{revision}.docx';cli('export',bundle,'--revision',revision,'--to','docx','--output',output);text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True)
  assert text.count('@Alice 王')==count and text.count('Alice 离线输入')==count and text.count('Bob 离线输入')==count and text.count('导出资料：容器内资料')==count
  assert text.count('Bob 移动同伴正文')==(1 if present and revision>=8 else 0) and text.count('Bob 删除竞争正文')==(1 if present and revision>=10 else 0)
  assert text.count('副本容器')==(1 if revision==13 else 0)
  with zipfile.ZipFile(output) as archive:
   assert source_images.issubset({hashlib.sha256(archive.read(path)).hexdigest() for path in archive.namelist() if '/media/' in path})
   pictures=sum(1 for path in archive.namelist() if path.endswith('.xml') for element in ET.fromstring(archive.read(path)).iter() if element.tag=='{http://schemas.openxmlformats.org/drawingml/2006/picture}pic');assert pictures==(4 if present else 3)
  (assets/output.name).write_bytes(output.read_bytes());evidence['revisions'].append({'revision':revision,'businessNodes':len(current),'references':refs,'originalsUnchanged':True,'clonePresent':present,'pictures':pictures});evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
 archive=out/'business-r13.hcdz';offline=out/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',13,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 for revision in range(6,14):assert state(revision,offline)==state(revision)
 record=json.loads((offline/'revisions/00000000000000000013.json').read_text());raw=(offline/record['assetIndexHref']).read_bytes();index=json.loads(gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw);indexed={item['hash']:item for item in index}
 for resource in initial['resources']:
  data=(offline/indexed[resource['hash']]['href']).read_bytes();assert hashlib.sha256(data).hexdigest()==resource['hash'] and len(data)==resource['byteLength']
 def verify(path):
  text=path.read_text() if path.suffix=='.md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True);assert text.count('@Alice 王')==2 and text.count('Alice 离线输入')==2 and text.count('Bob 离线输入')==2 and text.count('导出资料：容器内资料')==2;assert text.count('副本容器')==1 and text.count('Bob 移动同伴正文')==1 and text.count('Bob 删除竞争正文')==1 and text.count('扩展未加载，原始业务数据已保留')==1
 for fmt in ['docx','pptx','pdf','md']:
  output=out/f'business-offline-r13.{fmt}';cli('export',offline,'--revision',13,'--to',fmt,'--output',output);verify(output);(assets/output.name).write_bytes(output.read_bytes());evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'sourceAndHostNotRequired':True})
 downloaded=Path('/Users/houshuai/Downloads/mentions-docx-r13.docx');verify(downloaded);(assets/'browser-r13.docx').write_bytes(downloaded.read_bytes());evidence['files'].append({'file':'browser-r13.docx','sha256':hashlib.sha256(downloaded.read_bytes()).hexdigest(),'actualBrowserDownload':True})
 assert (bundle/'manifest.json').read_bytes()==before;evidence.update(originalIds=sorted(old),cloneIds=sorted(fresh),cloneReferenceId=reference_id,resources=initial['resources'],sourceImageHashes=sorted(source_images),sourceAndResourceBytesPreserved=True,originalEnvelopesAndUnknownsUnchanged=True,stableEventsAndAuthenticatedActor=True,headUnchangedByReadback=True)
 (assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');(assets/'initial-socket-evidence.json').write_text(json.dumps(initial,ensure_ascii=False,indent=2)+'\n');print('PASS actual r6-r13 identities, actors/events, peer text, image counts, downloaded DOCX and source-free DOCX/PPTX/PDF/MD; head13 unchanged.')
if __name__=='__main__':main()
