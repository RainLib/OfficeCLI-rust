#!/usr/bin/env python3
"""Verify the named inline-block copy/heading/independent-property fixture without writing its head."""
import gzip,hashlib,json,subprocess,sys,tempfile,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==9;binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-inline-blocks-2026-10-25';out=Path(tempfile.mkdtemp(prefix='inline-block-files-',dir=root))
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
 baseline=nodes(state(6));original=next(node for node in baseline.values() if node['type']=='example.resource_badge');unknown={key:value for key,value in baseline.items() if value['type']=='example.future_card'};copy_id=None;evidence={'scope':'Actual native revisions6-9, CUA copy/heading/properties/download, source-free archive and real file exports. No production or real Office application acceptance.','root':str(root),'head':9,'revisions':[],'files':[]}
 with zipfile.ZipFile(root/'sources/mentions-docx.docx') as archive:source_images={hashlib.sha256(archive.read(path)).hexdigest() for path in archive.namelist() if '/media/' in path}
 for revision in [6,7,8,9]:
  projection=state(revision);current=nodes(projection);assert all(current[key]==value for key,value in baseline.items());assert len(current)==(4 if revision==6 else 5);assert all(current[key]==value for key,value in unknown.items())
  if revision>6:
   new=set(current)-set(baseline);assert len(new)==1
   next_id=next(iter(new));copy_id=copy_id or next_id;assert copy_id==next_id;copied=current[copy_id];assert copied['resources']==original['resources'];assert copied['data']['title']==('副本资料' if revision==9 else '项目资料')
   if revision<9:assert {**copied,'instanceId':original['instanceId']}==original
   block=next(block['content'] for block in projection['blocks'] if any(part.get('extension',{}).get('instanceId')==copy_id for part in block['content']['inlines']));assert block['kind']==('paragraph' if revision==7 else 'heading')
  output=out/f'inline-r{revision}.docx';cli('export',bundle,'--revision',revision,'--to','docx','--output',output);text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True);assert text.count('导出资料：项目资料')==(2 if revision in [7,8] else 1);assert text.count('导出资料：副本资料')==(1 if revision==9 else 0);assert text.count('Alice 离线输入')==1 and text.count('Bob 离线输入')==1
  with zipfile.ZipFile(output) as archive:
   media={hashlib.sha256(archive.read(path)).hexdigest() for path in archive.namelist() if '/media/' in path};assert source_images.issubset(media);assert original['resources'][0]['hash'] in media
   pictures=sum(1 for path in archive.namelist() if path.endswith('.xml') for element in ET.fromstring(archive.read(path)).iter() if element.tag=='{http://schemas.openxmlformats.org/drawingml/2006/picture}pic');assert pictures==(2 if revision==6 else 3)
  (assets/output.name).write_bytes(output.read_bytes());evidence['revisions'].append({'revision':revision,'nodes':len(current),'originalUnchanged':True,'copyId':copy_id,'pictures':pictures});evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
 archive=out/'inline-r9.hcdz';offline=out/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',9,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 for revision in [6,7,8,9]:assert state(revision,offline)==state(revision)
 record=json.loads((offline/'revisions/00000000000000000009.json').read_text());raw=(offline/record['assetIndexHref']).read_bytes();index=json.loads(gzip.decompress(raw) if raw.startswith(b'\x1f\x8b') else raw);indexed={item['hash']:item for item in index}
 for resource in original['resources']:
  data=(offline/indexed[resource['hash']]['href']).read_bytes();assert hashlib.sha256(data).hexdigest()==resource['hash'] and len(data)==resource['byteLength']
 def verify(path):
  text=path.read_text() if path.suffix=='.md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True);assert text.count('导出资料：项目资料')==1 and text.count('导出资料：副本资料')==1 and text.count('Alice 离线输入')==1 and text.count('Bob 离线输入')==1;assert text.count('扩展未加载，原始业务数据已保留')==1
 for fmt in ['docx','pptx','pdf','md']:
  output=out/f'inline-offline-r9.{fmt}';cli('export',offline,'--revision',9,'--to',fmt,'--output',output);verify(output);(assets/output.name).write_bytes(output.read_bytes());evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'sourceAndCodecNotRequired':True})
 downloaded=Path('/Users/houshuai/Downloads/mentions-docx-r9.docx');verify(downloaded);(assets/'browser-r9.docx').write_bytes(downloaded.read_bytes());evidence['files'].append({'file':'browser-r9.docx','sha256':hashlib.sha256(downloaded.read_bytes()).hexdigest(),'actualBrowserDownload':True})
 assert (bundle/'manifest.json').read_bytes()==before;evidence.update(originalId=original['instanceId'],copyId=copy_id,sourceImageHashes=sorted(source_images),resources=original['resources'],cloneIdentitySeparateAndStable=True,portablePayloadAndArchivedBytesPreserved=True,unknownPayloadsUnchanged=True,headUnchangedByReadback=True)
 (assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS r6-r9 identities/heading/independent properties, peer text, original resources/images, actual DOCX download and source-free DOCX/PPTX/PDF/MD; head9 unchanged.')
if __name__=='__main__':main()
