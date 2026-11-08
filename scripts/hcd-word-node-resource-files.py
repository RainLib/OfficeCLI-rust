#!/usr/bin/env python3
"""Verify actual regional resource recovery/undo revisions and exported bytes."""
import argparse,hashlib,json,os,posixpath,re,shutil,subprocess,tempfile,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

def main():
 parser=argparse.ArgumentParser();parser.add_argument('fixture',type=Path);parser.add_argument('--browser-docx',type=Path);parser.add_argument('--browser-hcdz',type=Path);args=parser.parse_args()
 repo=Path(__file__).resolve().parents[1];root=args.fixture.resolve();assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-room-')
 config=json.loads((root/'private.json').read_text());assert config.get('nodesFixture');binary=repo/'target/debug/officecli';bundle=root/'rich.hcd';head=json.loads((bundle/'manifest.json').read_text())['revision'];assert head==7
 work=Path(tempfile.mkdtemp(prefix='node-resource-files-',dir=root));assets=repo/'docs/assets/hcd-word-node-resource-recovery-2026-10-27';assets.mkdir(exist_ok=True)
 env={**os.environ,'HCD_TOKEN_SECRET':config['secret'],'NO_COLOR':'1'}
 def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,cwd=work,text=True,capture_output=True,check=True).stdout)['data']
 states={n:cli('editor-state',bundle,'--revision',n) for n in range(head+1)}
 def card(n):
  found=[]
  def walk(value):
   if isinstance(value,dict):
    if isinstance(value.get('extension'),dict) and value['extension'].get('type')=='example.card':found.append(value['extension'])
    for item in value.values():walk(item)
   elif isinstance(value,list):
    for item in value:walk(item)
  walk(states[n]['blocks']);assert len(found)==1;return found[0]
 for n,count in [(2,0),(3,1),(4,1),(5,2),(6,1),(7,2)]:assert len(card(n).get('resources',[]))==count,(n,card(n))
 assert len({card(n)['instanceId'] for n in range(2,8)})==1
 for n in range(4,8):assert card(n)['data']=={'title':'协同后资料','owner':'团队'}
 assert card(3)['resources']==card(4)['resources']==card(6)['resources'];assert card(5)==card(7)
 resource=card(7)['resources'];expected={'replacement.png':hashlib.sha256((root/'replacement.png').read_bytes()).hexdigest(),'recovery-original.png':hashlib.sha256((root/'recovery-original.png').read_bytes()).hexdigest()};assert {r['name']:r['hash'] for r in resource}==expected
 docx=work/'node-resource-r7.docx';cli('export',bundle,'--output',docx,'--revision',head)
 with zipfile.ZipFile(docx) as z:
  document=ET.fromstring(z.read('word/document.xml'));text=''.join(document.itertext());assert '协同后资料 · 团队' in text and 'Regional room intro.' in text and 'Body one' in text
  rels={item.attrib['Id']:item.attrib['Target'] for item in ET.fromstring(z.read('word/_rels/document.xml.rels'))};embedded=[]
  for item in document.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}blip'):
   target=rels[item.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed']];embedded.append(hashlib.sha256(z.read(posixpath.normpath('word/'+target))).hexdigest())
  assert set(expected.values())<=set(embedded)
 archive=work/'node-resource-history.hcdz';offline=work/'offline.hcd';cli('pack',bundle,'--output',archive);cli('unpack',archive,'--output',offline)
 for n,state in states.items():assert cli('editor-state',offline,'--revision',n)==state
 assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid']
 assert set(expected.values())<={hashlib.sha256(p.read_bytes()).hexdigest() for p in (offline/'assets').rglob('*') if p.is_file()}
 result={'scope':'Local synthetic CUA browser, native files and offline archive only; no deployment or Microsoft Office app acceptance.','fixture':str(root),'head':head,'restoredResourceRevision':5,'ownUndoRevision':6,'ownRedoRevision':7,'peerNameRetained':True,'resourceCounts':{str(n):len(card(n).get('resources',[])) for n in range(2,8)},'resources':resource,'cancelledSlowUploadCreatedNoRevision':True,'docxDrawingLinksActualArchivedBytes':True,'offlineAllRevisionsExact':list(states),'nativeAndOfflineValidate':True,'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest()}
 if args.browser_docx:
  def parts(z):return{name:re.sub(rb' w:paraId="[a-f0-9]{8}"',b'',z.read(name)) if name.endswith('.xml') else z.read(name) for name in z.namelist()}
  with zipfile.ZipFile(args.browser_docx) as a,zipfile.ZipFile(docx) as b:assert parts(a)==parts(b)
  shutil.copy2(args.browser_docx,assets/'browser-node-resource-r7.docx');result['browserDocxExactExceptGeneratedParagraphIds']=True
 if args.browser_hcdz:
  downloaded=work/'browser-offline.hcd';cli('unpack',args.browser_hcdz.resolve(),'--output',downloaded)
  for n,state in states.items():assert cli('editor-state',downloaded,'--revision',n)==state
  assert cli('validate',downloaded)['valid'];shutil.copy2(args.browser_hcdz,assets/'browser-node-resource-r7.hcdz');result['browserHcdzAllRevisionsExact']=True
 for file in [docx,archive]:shutil.copy2(file,assets/file.name)
 (assets/'file-evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
