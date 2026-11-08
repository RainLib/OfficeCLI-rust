#!/usr/bin/env python3
"""Read normal page-request device artifacts, native versions and actual files."""
import hashlib,json,subprocess,sys,tempfile,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
c=json.loads((root/'private.json').read_text());e=json.loads((out/'browser.json').read_text())
assert c['root']==str(root) and root.parent==repo/'target/hcd-preview-runtime'
binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
def cli(*args):
 return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=90).stdout)['data']
assert cli('validate',bundle)['valid'];assert cli('editor-state',bundle)['revision']==e['finalRevision']==5
states={r:cli('editor-state',bundle,'--revision',r) for r in range(1,6)}
base=states[3];expected=json.loads(json.dumps(base['flowLayout']));expected['sections'][0]['page'].update(widthTwips=11906,heightTwips=16838,orientation='portrait')
assert states[4]['blocks']==base['blocks']
for r,p in states.items():
 assert p['flowLayout']==(base['flowLayout'] if r<4 else expected)
 for label,marker in e['markers'].items():assert (marker in json.dumps(p))==(r>=dict(own=2,peer=3,after=5)[label]),(r,label)
 assert [b for b in p['blocks'] if b.get('region') in ['header','footer']]==[b for b in base['blocks'] if b.get('region') in ['header','footer']]
for old,new in [('original','reopened'),('cancelled','cancelled-reopened'),('original','legacy-first'),('cancelled','legacy-second')]:assert (out/f'{old}.hcd-word-page-request').read_bytes()==(out/f'{new}.hcd-word-page-request').read_bytes()
original=json.loads((out/'original.hcd-word-page-request').read_text());cancelled=json.loads((out/'cancelled.hcd-word-page-request').read_text())
assert original['request']['expectedRevision']==3 and original['operation']=='apply'
assert cancelled['request']['expectedRevision']==4 and cancelled['operation']=='cancel'
requests=json.loads((root/'page-ui-proxy-records.json').read_text());successful=[r for r in requests if r['action']=='submit' and r.get('status')==200]
assert len(successful)==1 and successful[0]['mode']=='drop-success-block-retry' and successful[0]['response']['revision']==4
assert successful[0]['body']['request']==original['request']
assert any(r['action']=='check' and r.get('status')==200 and r['body']['request']==original['request'] for r in requests)
cancels=[r for r in requests if r['action']=='cancel' and r.get('status')==200];assert len(cancels)>=2 and all(r['body']['request']==cancelled['request'] for r in cancels)
ns='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
with zipfile.ZipFile(root/'sources/region-test.docx') as z:original_media={hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/') and not n.endswith('/')}
assert original_media
for r in [4,5]:
 path=out/f'r{r}.docx';cli('export',bundle,'--revision',r,'--output',path)
 with zipfile.ZipFile(path) as z:
  document=ET.fromstring(z.read('word/document.xml'));parents={child:parent for parent in document.iter() for child in parent};sections=[node for node in document.iter() if node.tag==ns+'sectPr' and parents.get(node) is not None and parents[node].tag!=ns+'sectPrChange'];assert len(sections)==2
  size=next(node for node in sections[0] if node.tag==ns+'pgSz');assert size.get(ns+'w')=='11906' and size.get(ns+'h')=='16838'
  text=''.join(document.itertext())
  for label,marker in e['markers'].items():assert text.count(marker)==int(r>=dict(own=2,peer=3,after=5)[label]),(r,label)
  media={hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/') and not n.endswith('/')};assert original_media.issubset(media)
with tempfile.TemporaryDirectory(prefix='page-device-readback-',dir=root) as temporary:
 directory=Path(temporary);candidate=directory/'page-device.hcdz';offline=directory/'offline.hcd';cli('pack',bundle,'--revision',5,'--output',candidate);cli('unpack',candidate,'--output',offline);assert cli('validate',offline)['valid']
 for r,p in states.items():assert cli('editor-state',offline,'--revision',r)==p
 reimport=directory/'reimport.hcd';cli('import',out/'r5.docx','--word-regions','--output',reimport);assert cli('validate',reimport)['valid'];imported=json.dumps(cli('editor-state',reimport))
 for marker in e['markers'].values():assert marker in imported
 candidate.replace(out/'page-device-history.hcdz')
(out/'requests.json').write_text(json.dumps(requests,ensure_ascii=False,indent=2)+'\n')
(out/'final-projection.json').write_text(json.dumps(states[5],ensure_ascii=False)+'\n')
subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-word-page-device-backup.mts'),str(root),str(out)],cwd=repo,capture_output=True,text=True,check=True,timeout=60)
assert cli('editor-state',bundle)['revision']==5
result={'scope':'ordinary page UI, actual closed tabs and service restarts; controlled old-session fixture migration','nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'revisions':[1,2,3,4,5],'nativeAndOfflineValidate':True,'oneSuccessfulPageCommit':True,'sameDownloadedOriginalAndCancellation':True,'sameMigratedOriginals':True,'headersFootersUnchanged':True,'docxPaperAndMarkers':True,'docxReimport':True,'imageBytesPreserved':True,'cancelledReplayRefused':True,'backup':json.loads((out/'backup-readback.json').read_text()),'externalOffice':False,'physicalDevice':False,'production':False}
(out/'file-readback.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
