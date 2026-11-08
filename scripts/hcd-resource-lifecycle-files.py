#!/usr/bin/env python3
"""Read-only validation of the named synthetic resource lifecycle browser case.
Only creates new export/archive products; no token enters logs or evidence.
"""
import hashlib,json,subprocess,sys,zipfile,gzip,tempfile,xml.etree.ElementTree as ET
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-')
 bundle=root/'mentions-docx.hcd';binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-resource-lifecycle-2026-10-25';assets.mkdir(exist_ok=True);before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==10
 run=Path(tempfile.mkdtemp(prefix='lifecycle-exports-',dir=root))
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 def state(revision,source=bundle):return cli('editor-state',source,'--revision',revision)
 def nodes(projection):
  out={}
  def visit(block):
   if block.get('extension'):out[block['extension']['instanceId']]=block['extension']
   for inline in block['inlines']:
    if inline.get('extension'):out[inline['extension']['instanceId']]=inline['extension']
   for child in block.get('children',[]):visit(child)
  for block in projection['blocks']:visit(block['content'])
  return out
 initial=nodes(state(6));unknown={key:value for key,value in initial.items() if value['type']=='example.future_card'}
 title='协同与超时后保留的属性草稿';peer='Bob 网络等待期间输入 · 保持选中';evidence={'scope':'Local synthetic CUA browser case, native saved revisions, actual files and source-free HCD archive. No production or real Office client acceptance.','root':str(root),'head':10,'revisions':[],'files':[]}
 for revision,count,label in [(6,2,'项目资料'),(8,2,'项目资料'),(9,3,'项目资料'),(10,3,title)]:
  projection=state(revision);current=nodes(projection);assert len(current)==4 and current.keys()==initial.keys();assert all(current[key]==value for key,value in unknown.items())
  badge=next(value for value in current.values() if value['type']=='example.resource_badge');assert len(badge['resources'])==count and badge['data']['title']==label
  output=run/f'lifecycle-r{revision}.docx';cli('export',bundle,'--output',output,'--to','docx','--revision',revision);text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True);assert text.count('导出资料：'+label)==1;assert text.count('Alice 离线输入')==1
  if revision>=8:assert text.count(peer)==1
  assert 'Alice 王' not in text and 'Bob 李' not in text
  with zipfile.ZipFile(output) as archive:assert sum(1 for path in archive.namelist() if path.endswith('.xml') for element in ET.fromstring(archive.read(path)).iter() if element.tag=='{http://schemas.openxmlformats.org/drawingml/2006/picture}pic')==2
  evidence['revisions'].append({'revision':revision,'resourceCount':count,'title':label,'fourIdsStable':True,'peerTextPreserved':revision>=8});evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()});(assets/output.name).write_bytes(output.read_bytes())
 archive=run/'lifecycle-r10.hcdz';offline=run/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',10,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert state(10,offline)==state(10);assert not (offline.parent/'sources').exists()
 record=json.loads((offline/'revisions/00000000000000000010.json').read_text());raw=(offline/record['assetIndexHref']).read_bytes();index=json.loads(gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw);indexed={item['hash']:item for item in index};resources=[]
 for resource in badge['resources']:
  data=(offline/indexed[resource['hash']]['href']).read_bytes();assert len(data)==resource['byteLength'] and hashlib.sha256(data).hexdigest()==resource['hash'];resources.append({'name':resource['name'],'sha256':resource['hash'],'bytes':len(data)})
 uploaded=next(resource for resource in resources if resource['name']=='ui-archive.txt');assert uploaded['sha256']==hashlib.sha256((root/'ui-archive.txt').read_bytes()).hexdigest();assert len([resource for resource in resources if resource['name']=='ui-archive.txt'])==1
 for fmt in ['docx','pdf','md']:
  output=run/f'lifecycle-offline-r10.{fmt}';cli('export',offline,'--output',output,'--to',fmt,'--revision',10)
  text=output.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(output),'text'],text=True)
  assert text.count('导出资料：'+title)==1 and text.count(peer)==1 and text.count('Alice 离线输入')==1
  evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'sourceAndCodecNotRequired':True});(assets/output.name).write_bytes(output.read_bytes())
 assert (bundle/'manifest.json').read_bytes()==before;evidence.update(resources=resources,headUnchangedByReadback=True,archiveHasAllSavedMetadataAndBytes=True,cancelledAndRetriedResourceAttachedOnce=True)
 (assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS saved revisions 6/8/9/10, actual DOCX/PDF/Markdown, resource bytes and source-free HCD archive; head unchanged.')
if __name__=='__main__':main()
