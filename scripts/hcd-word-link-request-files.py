#!/usr/bin/env python3
"""Read normal-link UI artifacts, native revisions, DOCX and offline histories."""
import hashlib,json,subprocess,sys,tempfile,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
c=json.loads((root/'private.json').read_text());e=json.loads((out/'browser.json').read_text())
assert c['root']==str(root) and root.parent==repo/'target/hcd-preview-runtime' and c['linkUiProxy']
binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
def cli(*args):
 return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=90).stdout)['data']
assert cli('validate',bundle)['valid'];assert cli('editor-state',bundle)['revision']==e['finalRevision']==5
states={r:cli('editor-state',bundle,'--revision',r) for r in range(1,6)}
base=states[2];expected=json.loads(json.dumps(base['flowLayout']));retained=expected['sections'][1]['headers'].pop('even')
assert states[3]['blocks']==base['blocks']
for r,p in states.items():
 assert p['flowLayout']==(base['flowLayout'] if r<3 else expected)
 for label,marker in e['markers'].items():assert (marker in json.dumps(p))==(r>=dict(own=2,peer=4,footer=5)[label]),(r,label)
 assert [b for b in p['blocks'] if b.get('flowRegionId')==retained]==[b for b in base['blocks'] if b.get('flowRegionId')==retained]
original=json.loads((out/'original.hcd-word-link-request').read_text());cancelled=json.loads((out/'cancelled.hcd-word-link-request').read_text())
assert original['review']['revision']==2 and original['operation']=='apply'
assert cancelled['review']['revision']==4 and cancelled['operation']=='cancel'
assert cancelled['review']['selection']['kind']=='footer' and cancelled['review']['summary']['inheritedSection'] is None
requests=json.loads((root/'link-ui-proxy-records.json').read_text());submits=[r for r in requests if r['action']=='submit' and r.get('status')==200]
assert len(submits)==2 and submits[0]['body']==submits[1]['body']
assert submits[0]['mode']=='drop-success' and submits[0]['response']['revision']==submits[1]['response']['revision']==3
assert submits[0]['body']['pending']==original['review']['pending']
assert any(r['action']=='check' and r.get('response',{}).get('status')=='installed' and r['body']['pending']==original['review']['pending'] for r in requests)
assert any(r['action']=='submit' and r.get('response',{}).get('code')=='word-story-source-draft-pending' for r in requests)
assert any(r['action']=='cancel' and r.get('response',{}).get('status')=='not-prepared' for r in requests)
assert json.loads((out/'cancelled-replay.json').read_text())['status']==409
ns='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
with zipfile.ZipFile(root/'sources/region-test.docx') as z:original_media={hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/') and not n.endswith('/')}
assert original_media
for r in [3,5]:
 path=out/f'r{r}.docx';cli('export',bundle,'--revision',r,'--output',path)
 with zipfile.ZipFile(path) as z:
  document=ET.fromstring(z.read('word/document.xml'));parents={child:parent for parent in document.iter() for child in parent};sections=[node for node in document.iter() if node.tag==ns+'sectPr' and parents.get(node) is not None and parents[node].tag!=ns+'sectPrChange'];assert len(sections)==2
  assert not any(node.tag==ns+'headerReference' and node.get(ns+'type')=='even' for node in sections[1])
  assert any(node.tag==ns+'footerReference' and node.get(ns+'type')=='first' for node in sections[1])
  text='\n'.join(''.join(ET.fromstring(z.read(n)).itertext()) for n in z.namelist() if n.startswith('word/') and n.endswith('.xml') and not '/_rels/' in n)
  for label,marker in e['markers'].items():assert text.count(marker)==int(r>=dict(own=2,peer=4,footer=5)[label]),(r,label)
  media={hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/') and not n.endswith('/')};assert original_media.issubset(media)
with tempfile.TemporaryDirectory(prefix='link-ui-readback-',dir=root) as temporary:
 directory=Path(temporary);candidate=directory/'normal-link.hcdz';offline=directory/'offline.hcd'
 cli('pack',bundle,'--revision',5,'--output',candidate);cli('unpack',candidate,'--output',offline);assert cli('validate',offline)['valid']
 for r,p in states.items():assert cli('editor-state',offline,'--revision',r)==p
 reimport=directory/'reimport.hcd';cli('import',out/'r5.docx','--word-regions','--output',reimport);assert cli('validate',reimport)['valid'];imported=json.dumps(cli('editor-state',reimport))
 for marker in e['markers'].values():assert marker in imported
 candidate.replace(out/'normal-link-history.hcdz')
(out/'requests.json').write_text(json.dumps(requests,ensure_ascii=False,indent=2)+'\n')
(out/'final-projection.json').write_text(json.dumps(states[5],ensure_ascii=False)+'\n')
subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-word-link-request-backup.mts'),str(root),str(out)],cwd=repo,capture_output=True,text=True,check=True,timeout=60)
result={'scope':'normal link UI, actual local native/sidecar, semantic DOCX and HCDZ readback','nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'revisions':[1,2,3,4,5],'nativeAndOfflineValidate':True,'onlyOneLinkVersion':True,'sameRequestAutomaticRetry':True,'latePeerBodyPreserved':True,'sourceFooterDraftRefusedAndLaterSaved':True,'cancelledBindingRetained':True,'retainedStoryUnchanged':True,'docxBindingsAndMarkers':True,'docxReimport':True,'imageBytesPreserved':True,'backup':json.loads((out/'backup-readback.json').read_text()),'normalLinkCreationUI':True,'sourcePreservingMixedExport':False,'externalOffice':False,'physicalDevice':False,'production':False}
(out/'file-readback.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
