#!/usr/bin/env python3
"""Read the documented owned portable-node fixture, actual exports and offline directory.
No tokens are printed or copied to evidence. Does not mutate the canonical head.
"""
import hashlib,json,shutil,subprocess,sys,urllib.request,zipfile,uuid,gzip,xml.etree.ElementTree as ET
from pathlib import Path
from html.parser import HTMLParser
class Text(HTMLParser):
 def __init__(self):super().__init__();self.items=[];self.skip=0
 def handle_starttag(self,t,a):
  if t in ['style','script']:self.skip+=1
 def handle_endtag(self,t):
  if t in ['style','script']:self.skip-=1
 def handle_data(self,t):
  if not self.skip:self.items.append(t)
def main():
 repo=Path(__file__).resolve().parents[1];c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['root']);assert root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';binary=repo/'target/debug/officecli';before=(bundle/'manifest.json').read_bytes();head=json.loads(before)['revision'];assert head>=12
 def state(revision,source=bundle):return json.loads(subprocess.check_output([str(binary),'hdoc','editor-state',str(source),'--revision',str(revision),'--json']))['data']
 def nodes(projection):
  out={}
  def visit(block):
   if block.get('extension'):out[block['extension']['instanceId']]=block['extension']
   for i in block['inlines']:
    if i.get('extension'):out[i['extension']['instanceId']]=i['extension']
   for child in block.get('children',[]):visit(child)
  for b in projection['blocks']:visit(b['content'])
  return out
 initial=nodes(state(2));current=nodes(state(head));assert len(current)==4
 assert all(current[k]==v for k,v in initial.items());badge=next(v for v in current.values() if v['type']=='example.resource_badge');rich=next(v for v in current.values() if v['type']=='example.rich_callout');assert len(badge['resources'])==3
 content=next(b['content'] for b in state(head)['blocks'] if b['content'].get('extension',{}).get('type')=='example.rich_callout');assert content['children'][1]['kind']=='heading' and content['children'][1]['level']==2;assert 'Bob 页面输入' in ''.join(i['text'] for i in content['children'][0]['inlines']);assert 'Alice 页面输入' in ''.join(i['text'] for i in content['children'][1]['inlines']);assert not content['inlines']
 evidence={'scope':'Actual local native HTTP/CLI, immutable versions, exported files and disconnected native HCD directory readback. No production/live PostgreSQL/multi-instance/whole Office visual acceptance.','root':str(root),'revision':head,'files':[],'resources':[],'revisions':[]}
 for revision,count in [(6,2),(9,2),(10,3),(11,2),(12,3),(13,2),(14,3)]:
  n=nodes(state(revision));b=next(v for v in n.values() if v['type']=='example.resource_badge');assert len(b['resources'])==count;evidence['revisions'].append({'revision':revision,'resourceReferences':count,'fourIdsStable':n.keys()==current.keys()})
 offline=root/f'portable-offline-{uuid.uuid4().hex[:8]}.hcd';shutil.copytree(bundle,offline,ignore=shutil.ignore_patterns('.hcd-write-lock'));assert state(head,offline)==state(head)
 manifest=json.load(open(offline/'manifest.json'));record=json.load(open(offline/f'revisions/{head:020}.json'));index_raw=(offline/record['assetIndexHref']).read_bytes();index=json.loads(gzip.decompress(index_raw) if index_raw.startswith(b'\x1f\x8b') else index_raw);indexed={a['hash']:a for a in index}
 for resource in badge['resources']:
  a=indexed[resource['hash']];p=offline/a['href'];data=p.read_bytes();assert len(data)==resource['byteLength'] and hashlib.sha256(data).hexdigest()==resource['hash'];evidence['resources'].append({'name':resource['name'],'hash':resource['hash'],'byteLength':len(data),'offlineVerified':True})
 original=(root/'ui-archive.txt').read_bytes();download=Path('/Users/houshuai/Downloads/ui-archive.txt');assert download.read_bytes()==original;evidence['browserResourceDownload']={'path':str(download),'sha256':hashlib.sha256(original).hexdigest(),'matchesArchivedBytes':True}
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));labels=['导出资料：项目资料','团队记录 · 团队记录','Alice 页面输入','Bob 页面输入']+[v['fallback']['text'] for v in initial.values()]
 for fmt in ['docx','pdf','pptx','xlsx','html','md','txt']:
  req=urllib.request.Request(c['origin']+f'/v1/documents/mentions-docx/export/{fmt}?revision={head}',headers={'Authorization':'Bearer '+c['reader'],'X-HCD-Node-Edits-Version':'4'})
  raw=opener.open(req,timeout=120).read();p=root/f'portable-r{head}.{fmt}';p.write_bytes(raw)
  if fmt in ['md','txt']:text=raw.decode()
  elif fmt=='html':parser=Text();parser.feed(raw.decode());text=''.join(parser.items)
  else:text=subprocess.check_output([str(binary),'view',str(p),'text'],text=True)
  assert all(text.count(label)==1 for label in labels),(fmt,text)
  assert 'Alice 王' not in text and 'Bob 李' not in text
  item={'format':fmt,'revision':head,'path':str(p),'sha256':hashlib.sha256(raw).hexdigest(),'displayedContentExactlyOnce':True,'awarenessNamesOmitted':True}
  if fmt in ['docx','pptx','xlsx']:
   with zipfile.ZipFile(p) as z:
    names=z.namelist();media=[z.read(n) for n in names if '/media/' in n];drawings=sum(1 for n in names if n.endswith('.xml') for element in ET.fromstring(z.read(n)).iter() if element.tag=='{http://schemas.openxmlformats.org/drawingml/2006/picture}pic' or element.tag=='{http://schemas.openxmlformats.org/presentationml/2006/main}pic' or element.tag=='{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}pic');item['actualPictureOccurrences']=drawings;assert drawings>=2,(fmt,drawings);item['embeddedImageHashes']=sorted(hashlib.sha256(b).hexdigest() for b in media);assert badge['resources'][0]['hash'] in item['embeddedImageHashes'];assert not any(b'hcd.extension' in z.read(n) for n in names if n.endswith('.xml'))
  if fmt=='pdf':
   listing=subprocess.check_output(['pdfimages','-list',str(p)],text=True);instances=[line for line in listing.splitlines() if line.strip() and line.split()[0].isdigit()];assert len(instances)>=2,listing;item['actualImageOccurrences']=len(instances)
  evidence['files'].append(item)
 # Remove staging descriptors in the disposable copy; immutable indexed bytes are sufficient.
 shutil.rmtree(offline/'assets/staged',ignore_errors=True);(offline/'assets/staged').mkdir(parents=True,exist_ok=True);evidence['offlineBundlePath']=str(offline)
 # Offline native export uses persisted snapshots and bytes without a host codec or HTTP.
 p=root/f'portable-offline-r{head}.docx';subprocess.check_output([str(binary),'hdoc','export',str(offline),'--output',str(p),'--to','docx','--revision',str(head),'--json']);text=subprocess.check_output([str(binary),'view',str(p),'text'],text=True);assert all(text.count(label)==1 for label in labels);evidence['offlineExport']={'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'codecAndNetworkNotRequired':True,'stagingDescriptorsNotRequired':True}
 browser=Path('/Users/houshuai/Downloads')/f'mentions-docx-r{head}.docx'
 if browser.exists():
  text=subprocess.check_output([str(binary),'view',str(browser),'text'],text=True);assert all(text.count(label)==1 for label in labels);evidence['actualBrowserDocx']={'path':str(browser),'revision':head,'sha256':hashlib.sha256(browser.read_bytes()).hexdigest(),'contentReadback':True}
 assert (bundle/'manifest.json').read_bytes()==before;evidence['checks']={'sourceUnknownPayloadsRetained':True,'liveRichHeadingAndMovedChildrenRetained':True,'resourceRemovalUndoRevisionHistoryRetained':True,'nativeOfflineBytesAndExportsVerified':True,'readbackDidNotPublish':True}
 (repo/'docs/assets/hcd-node-portable-2026-10-25/portable-file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS actual seven-format files, resource bytes/history and offline native export; canonical head unchanged',head)
if __name__=='__main__':main()
