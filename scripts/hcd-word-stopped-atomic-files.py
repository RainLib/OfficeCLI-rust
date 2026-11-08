#!/usr/bin/env python3
"""Read back actual two-window stopped-device evidence and native Office files."""
import hashlib,json,subprocess,sys,tempfile,urllib.request,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
repo=Path(__file__).resolve().parents[1];root,out=map(lambda v:Path(v).resolve(),sys.argv[1:3])
assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
c=json.loads((root/'private.json').read_text());assert c['root']==str(root)
binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
def cli(*args):
 return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=120).stdout)['data']
def read(route):
 return json.load(urllib.request.urlopen(urllib.request.Request(c['origin']+'/v1/documents/region-test'+route,headers={'Authorization':'Bearer '+c['reader']}),timeout=30))
race=json.loads((out/'browser-race.json').read_text());assert set(race)=={'draft','topology'}
assert race['draft']['accepted'] and not race['topology']['accepted'] and race['topology']['code']=='word-layout-other-request-pending'
original=(out/'winner-request.json').read_bytes();assert original==(out/'ordinary-request.json').read_bytes()==(out/'reopened-request.json').read_bytes()
attempt=json.loads(original);assert attempt['checkpointId']==race['draft']['id'] and attempt['actions'][0]['baseRevision']==1
assert json.loads((out/'prepare-only-head.json').read_text())['head']==1
cancel=json.loads((out/'cancel-late-save.json').read_text());assert cancel['status']==409 and cancel['head']==1 and cancel['checkpointId']==attempt['checkpointId']
legacy=json.loads((out/'legacy-migration.json').read_text());assert legacy['completeRequestsExact'] and legacy['bothPending'] and legacy['oldConnectionsFenced']==[True,True]
assert legacy['originals']==legacy['imported'] and len(legacy['originals'])==2
old_draft,old_topology=map(json.loads,legacy['originals']);assert old_draft['actor']['userId']==old_topology['actor']['userId']=='bob'
for name in ['cancelled-checkpoint-'+old_draft['checkpointId']+'.json','cancelled-'+old_topology['transactionId']+'.json']:
 assert len(list((root/'sidecar').rglob(name)))==1
assert cli('validate',bundle)['valid'] and cli('editor-state',bundle)['revision']==3
states={r:cli('editor-state',bundle,'--revision',r) for r in [1,2,3]}
pages=[s['page'] for s in states[1]['flowLayout']['sections']]
assert 'even' not in states[1]['flowLayout']['sections'][0]['footers']
footer=states[2]['flowLayout']['sections'][0]['footers']['even'];assert states[3]['flowLayout']['sections'][0]['footers']['even']==footer
for r,state in states.items():
 assert [s['page'] for s in state['flowLayout']['sections']]==pages
 assert ('Shared draft from Bob' in json.dumps(state))==(r==3)
history={r:read('/revisions/'+str(r)) for r in [1,2,3]}
assert history[2]['authorId']=='alice' and history[3]['authorId']=='bob' and history[3]['authorName']=='Bob 李'
assert all(attempt['checkpointId'] not in revision.get('patchId','') for revision in history.values())
ns='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}';rel='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
with zipfile.ZipFile(root/'sources/region-test.docx') as z:original_media={hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/') and not n.endswith('/')}
assert original_media
for r in [1,2,3]:
 docx=out/f'r{r}.docx';cli('export',bundle,'--revision',r,'--output',docx)
 with zipfile.ZipFile(docx) as z:
  document=ET.fromstring(z.read('word/document.xml'));parents={child:parent for parent in document.iter() for child in parent};sections=[n for n in document.iter(ns+'sectPr') if parents.get(n) is not None and parents[n].tag!=ns+'sectPrChange'];assert len(sections)==2
  assert ''.join(document.itertext()).count('Shared draft from Bob')==int(r==3)
  media={hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/') and not n.endswith('/')};assert original_media.issubset(media)
  if r>=2:
   refs=[n for n in sections[0].findall(ns+'footerReference') if n.get(ns+'type')=='even'];assert len(refs)==1
   relationships=ET.fromstring(z.read('word/_rels/document.xml.rels'));entry=next(n for n in relationships if n.get('Id')==refs[0].get(rel+'id'));target=entry.get('Target');part=target.lstrip('/') if target.startswith('/') else 'word/'+target
   assert ET.fromstring(z.read(part)).tag==ns+'ftr'
archive=out/'atomic-history.hcdz'
with tempfile.TemporaryDirectory(prefix='stopped-atomic-readback-',dir=root) as temporary:
 directory=Path(temporary);candidate=directory/'history.hcdz';cli('pack',bundle,'--revision',3,'--output',candidate);offline=directory/'offline.hcd';cli('unpack',candidate,'--output',offline);assert cli('validate',offline)['valid']
 for r,state in states.items():assert cli('editor-state',offline,'--revision',r)==state
 reimport=directory/'reimport.hcd';cli('import',out/'r3.docx','--word-regions','--output',reimport);assert cli('validate',reimport)['valid'];projection=cli('editor-state',reimport);assert 'Shared draft from Bob' in json.dumps(projection) and projection['flowLayout']['sections'][0]['footers'].get('even')
 candidate.replace(archive)
result={'scope':'two real browser windows using production IndexedDB classes; ordinary recovery UI for cancel, story creation and Bob draft save','head':3,'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'oneFreshRequestAccepted':True,'nativeHeadUnchangedDuringRace':1,'requestExactAfterCloseAndRestart':True,'cancelledLateSaveRejected':True,'ordinaryStoryCreatedAfterCancellation':True,'legacyBothKindsExactAndOldConnectionsFenced':True,'legacyBothCancellationsSealed':True,'nativeAndOfflineValidate':True,'offlineExactRevisions':[1,2,3],'originalBobAuthorship':True,'pageGeometryUnchanged':True,'imageBytesPreserved':True,'footerXml':True,'docxReimport':True,'externalOffice':False,'production':False,'physicalDeviceFailure':False}
(out/'file-readback.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
