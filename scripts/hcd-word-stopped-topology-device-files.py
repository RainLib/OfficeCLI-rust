#!/usr/bin/env python3
"""Verify actual stopped-structure downloads, native versions and Office files."""
import hashlib,json,subprocess,sys,tempfile,urllib.request,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
repo=Path(__file__).resolve().parents[1];root,out=map(lambda v:Path(v).resolve(),sys.argv[1:3])
assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
c=json.loads((root/'private.json').read_text());assert c['root']==str(root)
prepared='--prepared' in sys.argv[3:]
binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
def cli(*args):
 return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=120).stdout)['data']
def read(route):
 return json.load(urllib.request.urlopen(urllib.request.Request(c['origin']+'/v1/documents/region-test'+route,headers={'Authorization':'Bearer '+c['reader']}),timeout=30))
requests={kind:json.loads((out/f'{kind}-request.json').read_text()) for kind in ['layout','story','cancel']}
for kind in (['layout','story'] if prepared else requests):assert (out/f'{kind}-request.json').read_bytes()==(out/f'{kind}-request-reopened.json').read_bytes()
assert [a['kind'] for a in requests['cancel']['actions']]==(['story'] if prepared else ['story','cancel'])
assert requests['layout']['actions'][0]['sections'][0]['number']==1
assert requests['story']['actions'][0]['section']==2 and requests['cancel']['actions'][0]['section']==1
records=json.loads((root/'topology-ui-proxy-records.json').read_text())
if prepared:
 assert (out/'layout-resume-request.json').read_bytes()==(out/'layout-resume-request-reopened.json').read_bytes()
 resumed=json.loads((out/'layout-resume-request.json').read_text());assert [a['kind'] for a in resumed['actions']]==['layout','resume']
 assert resumed['actions'][0]==requests['layout']['actions'][0] and resumed['transactionId']==requests['layout']['transactionId']
 native=json.loads((root/'native-topology-records.json').read_text())
 for kind in ['layout','story']:
  original=requests[kind]['actions'][0]['body'];transactions=[r for r in native if r['kind']==kind and r['action']=='transactions']
  assert all(r['transactionId']==original['transactionId'] and r['expectedRevision']==(1 if kind=='layout' else 2) for r in transactions)
  assert len({r['bodySha256'] for r in transactions})==1
  successful=[r for r in transactions if r.get('status')==200];assert len(successful)==1
  assert len(transactions)==(2 if kind=='layout' else 1)
  assert transactions[0].get('outcome')=='blocked-before-forward' if kind=='layout' else successful[0]['mode']=='drop-success-block-recovery'
  receipts=[r for r in native if r['kind']==kind and r['action']=='receipt'];assert len(receipts)==(1 if kind=='layout' else 2) and all(r['status']==200 and r['transactionId']==original['transactionId'] for r in receipts)
  applies=[r for r in records if r['action']=='apply' and r['body']['transactionId']==original['transactionId']];assert applies and all(r['body']==original for r in applies)
  resumes=[r for r in records if r['action']=='resume' and r.get('status')==200 and r['body']['transactionId']==original['transactionId']];assert len(resumes)==1
  assert resumes[0]['response']['status']=='confirmed' and resumes[0]['response']['revision']==(2 if kind=='layout' else 3)
  assert resumes[0]['mode']==('drop-success-block-retry' if kind=='layout' else 'pass')
 for name,kind in [('first','story'),('second','cancel')]:
  migrated=json.loads((out/f'legacy-{name}.json').read_text());assert migrated['transactionId']==requests[kind]['transactionId']
  assert migrated['actions']==[{'kind':'legacy','body':{'epoch':1,'transactionId':requests[kind]['transactionId']}}]
 assert requests['story']['transactionId']!=requests['cancel']['transactionId']
 cancels=[r for r in records if r['action']=='cancel' and r.get('status')==200];assert len(cancels)>=3
 assert all(r['body']=={'epoch':1,'transactionId':requests['cancel']['transactionId']} for r in cancels)
 assert all(r['response']=={'status':'not-prepared','transactionId':requests['cancel']['transactionId']} for r in cancels)
 (out/'native-network.json').write_text(json.dumps(native,ensure_ascii=False,indent=2)+'\n')
else:
 for kind in ['layout','story']:
  original=requests[kind]['actions'][0]['body'];applies=[r for r in records if r['action']=='apply' and r['body']['transactionId']==original['transactionId']]
  assert all(r['body']==original for r in applies)
  successful=[r for r in applies if r.get('status')==200];assert len(successful)==1
  assert successful[0]['response']=={'revision':2 if kind=='layout' else 3,'transactionId':original['transactionId']}
 cancels=[r for r in records if r['action']=='cancel' and r.get('status')==200];assert len(cancels)==2 and all(r['body']==requests['cancel']['actions'][-1]['body'] for r in cancels)
 assert cancels[0]['mode']=='drop-success-block-retry' and cancels[1]['mode']=='pass'
assert json.loads((out/'cancelled-replay.json').read_text())['headUnchanged']==3
assert cli('validate',bundle)['valid'] and cli('editor-state',bundle)['revision']==4
states={r:cli('editor-state',bundle,'--revision',r) for r in range(1,5)}
original_pages=[s['page'] for s in states[1]['flowLayout']['sections']]
for r,p in states.items():
 sections=p['flowLayout']['sections'];assert len(sections)==2
 expected=dict(original_pages[0]);expected.update(widthTwips=11906,heightTwips=16838,orientation='portrait')
 assert sections[0]['page']==(original_pages[0] if r==1 else expected) and sections[1]['page']==original_pages[1]
 assert 'even' not in sections[0]['footers']
 if r>=3:assert sections[1]['footers']['even']=='n_'+requests['story']['transactionId']
 else:assert 'even' not in sections[1]['footers']
 assert ('Shared draft from Bob' in json.dumps(p))==(r==4)
history={r:read('/revisions/'+str(r)) for r in range(1,5)}
assert history[4]['authorId']=='bob' and history[4]['authorName']=='Bob 李'
for r,kind in [(2,'layout'),(3,'story')]:assert requests[kind]['transactionId'] in history[r]['patchId'] and history[r]['authorId']=='alice'
assert all(requests['cancel']['transactionId'] not in v.get('patchId','') for v in history.values())
ns='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
rel='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
with zipfile.ZipFile(root/'sources/region-test.docx') as z:original_media={hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/') and not n.endswith('/')}
assert original_media
for r in [2,3,4]:
 docx=out/f'r{r}.docx';cli('export',bundle,'--revision',r,'--output',docx)
 with zipfile.ZipFile(docx) as z:
  document=ET.fromstring(z.read('word/document.xml'));parents={child:parent for parent in document.iter() for child in parent};sections=[n for n in document.iter(ns+'sectPr') if parents.get(n) is not None and parents[n].tag!=ns+'sectPrChange'];assert len(sections)==2
  page=sections[0].find(ns+'pgSz');assert page.get(ns+'w')=='11906' and page.get(ns+'h')=='16838'
  text=''.join(document.itertext());assert text.count('Shared draft from Bob')==int(r==4)
  media={hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/') and not n.endswith('/')};assert original_media.issubset(media)
  assert not any(n.get(ns+'type')=='even' for n in sections[0].findall(ns+'footerReference'))
  if r>=3:
   refs=[n for n in sections[1].findall(ns+'footerReference') if n.get(ns+'type')=='even'];assert len(refs)==1
   relationships=ET.fromstring(z.read('word/_rels/document.xml.rels'));entry=next(n for n in relationships if n.get('Id')==refs[0].get(rel+'id'));target=entry.get('Target');part=target.lstrip('/') if target.startswith('/') else 'word/'+target
   assert ET.fromstring(z.read(part)).tag==ns+'ftr'
archive=out/'stopped-topology-history.hcdz';cli('pack',bundle,'--revision',4,'--output',archive)
with tempfile.TemporaryDirectory(prefix='topology-device-readback-',dir=root) as temporary:
 directory=Path(temporary);offline=directory/'offline.hcd';cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid']
 for r,p in states.items():assert cli('editor-state',offline,'--revision',r)==p
 reimport=directory/'reimport.hcd';cli('import',out/'r4.docx','--word-regions','--output',reimport);assert cli('validate',reimport)['valid'];projection=cli('editor-state',reimport);assert 'Shared draft from Bob' in json.dumps(projection);assert projection['flowLayout']['sections'][1]['footers'].get('even')
(out/'network.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
result={'scope':'ordinary compatibility UI, loopback native service, signed synthetic draft and actual downloaded request files','head':4,'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'nativeAndOfflineValidate':True,'offlineExactRevisions':[1,2,3,4],'allThreeRequestDownloadsExactAfterCloseAndRestart':not prepared,'layoutAndStoryExactAfterCloseAndRestart':True,'preparedRecovery':prepared,'layoutResumeExactAfterSecondRestart':prepared,'controlledLegacyMigration':prepared,'oneLayoutAndOneStoryCommit':True,'cancelNotCommitted':True,'pageAndFooterXml':True,'originalBobDraftAndAuthorship':True,'imageBytesPreserved':True,'docxReimport':True,'externalOffice':False,'physicalDeviceFailure':False,'production':False}
(out/'file-readback.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
