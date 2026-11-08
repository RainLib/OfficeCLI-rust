#!/usr/bin/env python3
"""Read-only named deletion-review fixture, real native files and source-free exports."""
import gzip,hashlib,json,subprocess,sys,tempfile,urllib.request,zipfile
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';manifest=(bundle/'manifest.json').read_bytes();assert json.loads(manifest)['revision']==10
 binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-deletion-review-2026-10-25';out=Path(tempfile.mkdtemp(prefix='deletion-files-',dir=root));initial=json.loads((root/'business-initial-evidence.json').read_text());opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
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
 old={node['instanceId']:node for node in initial['nodes']};assert len(old)==6
 evidence={'scope':'Actual immutable canonical r6-r10, reference actors, browser DOCX, resources and source-free archive/exports; not real Office or production. Deleted shared drafts are not an offline canonical archive.','revisions':[],'files':[]};mention=None
 for revision in range(6,11):
  projection=state(revision);current=nodes(projection);present=revision in [6,8,10];assert len(current)==(6 if present else 3) and all(value==old[key] for key,value in current.items())
  refs=json.load(opener.open(urllib.request.Request(c['origin']+f'/v1/documents/mentions-docx/references?revision={revision}',headers={'Authorization':'Bearer '+c['reader'],'X-HCD-Node-Edits-Version':'5'}),timeout=45));assert len(refs['items'])==(1 if present else 0) and refs['reminders']=={'enabled':False,'delivery':'disabled'}
  events=refs['transition']['events']
  if revision>6:assert len(events)==1 and events[0]['kind']==('reference.created' if present else 'reference.removed') and events[0]['context']['actorId']=='alice'
  if present:
   identity=refs['items'][0]['reference']['mentionId']
   if mention is None:mention=identity
   else:assert mention==identity
  output=out/f'deletion-r{revision}.docx';cli('export',bundle,'--revision',revision,'--to','docx','--output',output);text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True);assert text.count('@Alice 王')==(1 if present else 0)
  assert ('Bob 删除后离线输入' in text)==(revision in [8,10]);assert ('Bob 第二次离线输入' in text)==(revision==10)
  for label in ['Bob 迟到复核输入','Bob 确认后再到输入']:assert (label in text)==(revision==10)
  (assets/output.name).write_bytes(output.read_bytes());evidence['revisions'].append({'revision':revision,'businessNodes':len(current),'envelopesUnchanged':True,'references':refs})
 archive=out/'deletion-r10.hcdz';offline=out/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',10,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'] and not (offline.parent/'sources').exists()
 for revision in range(6,11):assert state(revision,offline)==state(revision)
 (assets/archive.name).write_bytes(archive.read_bytes());record=json.loads((offline/'revisions/00000000000000000010.json').read_text());raw=(offline/record['assetIndexHref']).read_bytes();index=json.loads(gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw);indexed={item['hash']:item for item in index}
 for resource in initial['resources']:
  data=(offline/indexed[resource['hash']]['href']).read_bytes();assert hashlib.sha256(data).hexdigest()==resource['hash'] and len(data)==resource['byteLength']
 labels=['Bob 删除后离线输入','Bob 第二次离线输入','Bob 迟到复核输入','Bob 确认后再到输入','@Alice 王','嵌套正文','导出资料：容器内资料']
 def verify(path):
  text=path.read_text() if path.suffix=='.md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  for label in labels:assert label in text,(path.name,label)
 for fmt in ['docx','pptx','pdf','md']:
  output=out/f'deletion-offline-r10.{fmt}';cli('export',offline,'--revision',10,'--to',fmt,'--output',output);verify(output);(assets/output.name).write_bytes(output.read_bytes());evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'sourceAndHostNotRequired':True})
 download=Path(sys.argv[2]);assert download.is_file() and download.suffix=='.docx';verify(download);(assets/'browser-r10.docx').write_bytes(download.read_bytes())
 with zipfile.ZipFile(root/'sources/mentions-docx.docx') as source,zipfile.ZipFile(download) as docx:
  source_images={hashlib.sha256(source.read(name)).hexdigest() for name in source.namelist() if '/media/' in name};assert source_images.issubset({hashlib.sha256(docx.read(name)).hexdigest() for name in docx.namelist() if '/media/' in name})
 assert (bundle/'manifest.json').read_bytes()==manifest;evidence.update(sourceFreeArchiveValid=True,allHistoricalProjectionsEqual=True,resourceBytesPreserved=True,sourceImageBytesPreserved=True,stableBusinessAndMentionIds=True,browserDownloadVerified=True,headUnchanged=True,head=10)
 (assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS actual r6-r10 envelopes/actors/reference identities, browser DOCX, source-free HCD/DOCX/PPTX/PDF/MD and resource bytes; head10 unchanged.')
if __name__=='__main__':main()
