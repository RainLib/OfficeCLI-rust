#!/usr/bin/env python3
"""Read-only file verification for the owned r8 undo-review fixture."""
import gzip,hashlib,json,subprocess,sys,tempfile,urllib.request,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==8
 binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-undo-review-2026-10-25';assets.mkdir(exist_ok=True);out=Path(tempfile.mkdtemp(prefix='undo-review-files-',dir=root));initial=json.loads((root/'business-initial-evidence.json').read_text());socket=json.loads((root/'undo-review-socket.json').read_text());opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
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
 def references(revision):return json.load(opener.open(urllib.request.Request(c['origin']+f'/v1/documents/mentions-docx/references?revision={revision}',headers={'Authorization':'Bearer '+c['reader'],'X-HCD-Node-Edits-Version':'4'}),timeout=45))
 old={node['instanceId']:node for node in initial['nodes']};fresh=set(socket['newIds']);assert len(old)==6 and len(fresh)==3
 evidence={'scope':'Saved local native revisions, authenticated references, source-free offline archive, actual exported files and browser DOCX. Does not prove production or real Office editing.','head':8,'revisions':[],'files':[]}
 for revision in [6,7,8]:
  projection=state(revision);current=nodes(projection);assert set(current)==set(old)|(fresh if revision>6 else set());assert all(current[key]==value for key,value in old.items());refs=references(revision);assert refs==references(revision);assert refs['reminders']=={'enabled':False,'delivery':'disabled'}
  assert len(refs['items'])==(1 if revision==6 else 2)
  events=refs['transition']['events']
  if revision==7:assert len(events)==1 and events[0]['kind']=='reference.created' and events[0]['context']['actorId']=='alice'
  if revision==8:assert len(events)==1 and events[0]['kind']=='reference.retargeted' and events[0]['context']['actorId']=='bob',events
  evidence['revisions'].append({'revision':revision,'businessNodes':len(current),'originalEnvelopesUnchanged':True,'references':refs})
 archive=out/'review-r8.hcdz';offline=out/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',8,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 for revision in [6,7,8]:assert state(revision,offline)==state(revision)
 (assets/'review-r8.hcdz').write_bytes(archive.read_bytes());evidence['files'].append({'file':'review-r8.hcdz','sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'sourceFreeUnpackedAndValidated':True})
 record=json.loads((offline/'revisions/00000000000000000008.json').read_text());raw=(offline/record['assetIndexHref']).read_bytes();index=json.loads(gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw);indexed={item['hash']:item for item in index}
 for resource in initial['resources']:
  data=(offline/indexed[resource['hash']]['href']).read_bytes();assert hashlib.sha256(data).hexdigest()==resource['hash'] and len(data)==resource['byteLength']
 def verify(path):
  text=path.read_text() if path.suffix=='.md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  for label in ['Bob 同伴新增正文','Bob 新增子块','Bob 协作副本','@Alice 王','@Bob 李','导出资料：Bob 审阅资料']:assert text.count(label)==1,(path,label,text)
  assert text.count('Alice 离线输入')==2 and text.count('Bob 离线输入')==2
 for fmt in ['docx','pptx','pdf','md']:
  output=out/f'review-offline-r8.{fmt}';cli('export',offline,'--revision',8,'--to',fmt,'--output',output);verify(output);(assets/output.name).write_bytes(output.read_bytes());evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'sourceAndHostNotRequired':True})
 downloaded=Path(sys.argv[2]);assert downloaded.is_file() and downloaded.suffix=='.docx';verify(downloaded);(assets/'browser-r8.docx').write_bytes(downloaded.read_bytes())
 with zipfile.ZipFile(assets/'review-offline-r8.docx') as docx:
  pictures=sum(1 for path in docx.namelist() if path.endswith('.xml') for element in ET.fromstring(docx.read(path)).iter() if element.tag=='{http://schemas.openxmlformats.org/drawingml/2006/picture}pic');assert pictures==4
 with zipfile.ZipFile(root/'sources/mentions-docx.docx') as source,zipfile.ZipFile(downloaded) as docx:
  source_hashes={hashlib.sha256(source.read(path)).hexdigest() for path in source.namelist() if '/media/' in path};assert source_hashes.issubset({hashlib.sha256(docx.read(path)).hexdigest() for path in docx.namelist() if '/media/' in path})
 assert (bundle/'manifest.json').read_bytes()==before
 evidence.update(sourceFreeArchiveValid=True,resourceBytesPreserved=True,sourceImageBytesPreserved=True,pictures=4,browserDownloadVerified=True,headUnchanged=True)
 for name in ['undo-review-socket.json','business-initial-evidence.json']:(assets/name).write_bytes((root/name).read_bytes())
 (assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS r6-r8 identity, actual actors, references/resources, browser DOCX and source-free DOCX/PPTX/PDF/MD; head8 unchanged.')
if __name__=='__main__':main()
