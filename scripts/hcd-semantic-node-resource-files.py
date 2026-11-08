#!/usr/bin/env python3
"""Read actual ordinary-editor resource recovery versions and portable exports."""
import argparse,hashlib,json,os,re,shutil,subprocess,tempfile,zipfile,posixpath
from pathlib import Path
import xml.etree.ElementTree as ET
import urllib.request,base64
from html.parser import HTMLParser
class Text(HTMLParser):
 def __init__(self):super().__init__();self.items=[];self.skip=0
 def handle_starttag(self,t,a):
  if t in ['script','style']:self.skip+=1
 def handle_endtag(self,t):
  if t in ['script','style']:self.skip-=1
 def handle_data(self,t):
  if not self.skip:self.items.append(t)
def main():
 p=argparse.ArgumentParser();p.add_argument('fixture',type=Path);p.add_argument('--browser-docx',type=Path);p.add_argument('--browser-hcdz',type=Path);args=p.parse_args();repo=Path(__file__).resolve().parents[1];root=args.fixture.resolve();assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-')
 config=json.loads((root/'private.json').read_text());bundle=root/'mentions-docx.hcd';binary=repo/'target/debug/officecli';env={**os.environ,'HCD_TOKEN_SECRET':config['secret'],'NO_COLOR':'1'};out=repo/'docs/assets/hcd-semantic-node-resource-recovery-2026-10-27';work=Path(tempfile.mkdtemp(prefix='files-',dir=root));head=json.loads((bundle/'manifest.json').read_text())['revision'];assert head==6
 def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,cwd=work,text=True,capture_output=True,check=True).stdout)['data']
 states={n:cli('editor-state',bundle,'--revision',n) for n in range(7)}
 def badge(n):
  found=[]
  def walk(value):
   if isinstance(value,dict):
    if isinstance(value.get('extension'),dict) and value['extension'].get('type')=='example.resource_badge':found.append(value['extension'])
    for item in value.values():walk(item)
   elif isinstance(value,list):
    for item in value:walk(item)
  walk(states[n]['blocks']);assert len(found)==1;return found[0]
 assert len({badge(n)['instanceId'] for n in range(2,7)})==1
 for n,count in [(2,0),(3,0),(4,1),(5,0),(6,1)]:assert len(badge(n).get('resources',[]))==count
 for n in range(3,7):assert badge(n)['data']=={'title':'同伴更新资料'}
 assert badge(4)==badge(6);resource=badge(6)['resources'][0];assert resource['hash']==hashlib.sha256((root/'archived-image.png').read_bytes()).hexdigest()
 backup=json.loads((out/'pending-file-device.hcd-draft').read_text());assert backup['nodeResources'][0]['expected']['instanceId']==badge(6)['instanceId'];assert hashlib.sha256(bytes(backup['nodeResources'][0]['bytes'])).hexdigest()==resource['hash'];assert backup['crdt'] and 'token' not in backup
 events=[json.loads(line) for line in (root/'resource-events.jsonl').read_text().splitlines()];assert any(e['event']=='rejected' and e['status']==503 for e in events);assert any(e['event']=='nativeResponse' and e['status']==200 for e in events);assert any(e['event']=='clientClosed' for e in events)
 files={}
 for fmt in ['docx','pdf','pptx','xlsx','html','md','txt']:
  path=work/f'semantic-resource-r6.{fmt}'
  if fmt=='html':
   request=urllib.request.Request(config['origin']+f'/v1/documents/mentions-docx/export/html?revision={head}',headers={'Authorization':'Bearer '+config['reader'],'X-HCD-Node-Edits-Version':'7','X-HCD-Extension-Version':'2','X-HCD-Custom-Marks-Version':'1'});path.write_bytes(urllib.request.urlopen(request,timeout=60).read())
  else:cli('export',bundle,'--output',path,'--to',fmt,'--revision',head)
  if fmt in ['md','txt']:text=path.read_text()
  elif fmt=='html':parsed=Text();parsed.feed(path.read_text());text=''.join(parsed.items)
  else:text=subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  assert text.count('导出资料：同伴更新资料')==1,(fmt,text);assert 'Original' in text;assert 'Bob 李' not in text and 'Alice 王' not in text
  item={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'readableNodeExactlyOnce':True,'transport':'authenticated browser export API' if fmt=='html' else 'source-free native CLI'}
  if fmt=='docx':
   with zipfile.ZipFile(path) as z:
    rels={e.attrib['Id']:e.attrib['Target'] for e in ET.fromstring(z.read('word/_rels/document.xml.rels'))};document=ET.fromstring(z.read('word/document.xml'));drawings=[]
    for e in document.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}blip'):drawings.append(hashlib.sha256(z.read(posixpath.normpath('word/'+rels[e.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed']]))).hexdigest())
    assert resource['hash'] in drawings;item['drawingReferencesArchivedImageBytes']=True
  if fmt in ['pptx','xlsx']:
   with zipfile.ZipFile(path) as z:assert resource['hash'] in {hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if '/media/' in name}
   item['containsArchivedImageBytes']=True
  if fmt=='html':
   hashes={hashlib.sha256(base64.b64decode(data)).hexdigest() for data in re.findall(rb'data:image/png;base64,([A-Za-z0-9+/=]+)',path.read_bytes())};assert resource['hash'] in hashes;item['embedsArchivedImageBytes']=True
  if fmt=='pdf':
   listing=subprocess.check_output(['pdfimages','-list',str(path)],text=True);assert len([line for line in listing.splitlines() if line.split() and line.split()[0].isdigit()])>=2;item['sourceAndNodeImageOccurrences']=True
  if fmt in ['md','txt']:assert '节点归档图片' in text;item['imageConversion']='readable label/name; full resource bytes retained in HCD archive'
  files[fmt]=item;shutil.copy2(path,out/path.name)
 archive=work/'semantic-resource-history.hcdz';offline=work/'offline.hcd';cli('pack',bundle,'--output',archive);cli('unpack',archive,'--output',offline)
 for n,state in states.items():assert cli('editor-state',offline,'--revision',n)==state
 assert resource['hash'] in {hashlib.sha256(path.read_bytes()).hexdigest() for path in (offline/'assets').rglob('*') if path.is_file()};assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid'];shutil.copy2(archive,out/archive.name)
 result={'scope':'Local synthetic ordinary Word browser, native/files, source-independent semantic export and offline acceptance. No production or Microsoft Office app acceptance.','fixture':str(root),'head':head,'resource':resource,'peerTitlePreserved':True,'deviceBackupHasExactOriginalBytes':True,'resourceCounts':{str(n):len(badge(n).get('resources',[])) for n in range(2,7)},'verifiedExports':files,'cliSourceFreeHtml':'explicitly unsupported; browser API verified separately','offlineAllVersionsExact':list(states),'nativeAndOfflineValidate':True,'cancelledSlowRequestNoNewVersion':True,'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest()}
 if args.browser_docx:
  def parts(z):return{name:re.sub(rb' w:paraId="[a-f0-9]{8}"',b'',z.read(name)) if name.endswith('.xml') else z.read(name) for name in z.namelist()}
  with zipfile.ZipFile(args.browser_docx) as a,zipfile.ZipFile(work/'semantic-resource-r6.docx') as b:assert parts(a)==parts(b)
  shutil.copy2(args.browser_docx,out/'browser-semantic-resource-r6.docx');result['browserDocxExactExceptGeneratedParagraphIds']=True
 if args.browser_hcdz:
  downloaded=work/'browser-offline.hcd';cli('unpack',args.browser_hcdz.resolve(),'--output',downloaded)
  for n,state in states.items():assert cli('editor-state',downloaded,'--revision',n)==state
  assert cli('validate',downloaded)['valid'];shutil.copy2(args.browser_hcdz,out/'browser-semantic-resource-r6.hcdz');result['browserArchiveAllVersionsExact']=True
 (out/'file-evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
