#!/usr/bin/env python3
"""Read actual native link history, DOCX relationships and packed revisions."""
import hashlib,json,subprocess,sys,tempfile,urllib.request,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
c=json.loads((root/'private.json').read_text());assert c['root']==str(root)
e=json.loads((out/'service.json').read_text());binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
def cli(*args):
 p=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=90)
 return json.loads(p.stdout)['data']
assert cli('validate',bundle)['valid']
states={revision:cli('editor-state',bundle,'--revision',revision) for revision in range(e['initial'],e['restartedRevision']+1)}
before=states[e['initial']];target=next(i for i,s in enumerate(before['flowLayout']['sections']) if s['id']==e['selection']['sectionId']);kind=e['selection']['kind'];bindings='headers' if kind=='header' else 'footers';variant=e['selection']['variant']
expected=json.loads(json.dumps(before['flowLayout']));assert expected['sections'][target][bindings].pop(variant)==e['pending']['request']['link']['expectedDirectStoryId']
for revision,p in states.items():
 assert p['flowLayout']==(before['flowLayout'] if revision<e['linkRevision'] else expected)
 assert p['flowLayout']['stories']==before['flowLayout']['stories']
if states[e['linkRevision']]['blocks']!=before['blocks']:raise AssertionError('link changed saved content')
ns='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
with zipfile.ZipFile(root/'sources/region-test.docx') as source:
 original={hashlib.sha256(source.read(name)).hexdigest() for name in source.namelist() if name.startswith('word/media/') and not name.endswith('/')}
assert original
for revision in [e['linkRevision'],e['finalRevision'],e['restartedRevision']]:
 path=out/f'r{revision}.docx';cli('export',bundle,'--revision',revision,'--output',path)
 with zipfile.ZipFile(path) as package:
  document=ET.fromstring(package.read('word/document.xml'));text=''.join(document.itertext())
  for label,marker in e['markers'].items():
   expected_count=1 if revision>=(e['restartedRevision'] if label=='restart' else e['finalRevision']) else 0
   assert text.count(marker)==expected_count,(revision,label)
  parents={child:parent for parent in document.iter() for child in parent}
  sections=[node for node in document.iter() if node.tag==ns+'sectPr' and parents.get(node) is not None and parents[node].tag!=ns+'sectPrChange']
  assert len(sections)==len(expected['sections'])
  assert not any(node.tag==ns+kind+'Reference' and node.get(ns+'type')==variant for node in sections[target])
  media={hashlib.sha256(package.read(name)).hexdigest() for name in package.namelist() if name.startswith('word/media/') and not name.endswith('/')};assert original.issubset(media)
records=[]
for revision in states:
 request=urllib.request.Request(c['origin']+f'/v1/documents/region-test/revisions/{revision}',headers={'Authorization':'Bearer '+c['reader']})
 with urllib.request.urlopen(request,timeout=30) as response:records.append(json.load(response))
links=[record for record in records if record.get('patchId','').startswith('word-story-link-')]
assert len(links)==1 and links[0]['revision']==e['linkRevision'] and links[0]['patchId']=='word-story-link-'+e['selection']['transactionId']
archive=out/'active-link-history.hcdz';cli('pack',bundle,'--revision',e['restartedRevision'],'--output',archive)
with tempfile.TemporaryDirectory(prefix='hcd-active-link-files-') as temporary:
 offline=Path(temporary)/'offline.hcd';cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid']
 for revision,p in states.items():assert p==cli('editor-state',offline,'--revision',revision)
result={'scope':'actual active link service followed by new Socket sessions and sidecar-restart continuation','nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'offlineVerifiedRevisions':list(states),'exactlyOneNativeLinkCommit':True,'linkPreservesCanonicalBlocks':True,'onlyRequestedBindingChanged':True,'docxInheritedBindingVerified':True,'markersExactlyOnceAtExpectedRevisions':True,'originalImageBytesPreserved':True,'allStoriesRetained':True,'nativeAndOfflineValidate':True,'nativeResponseDropped':e.get('nativeSuccessfulResponseLost',False),'normalLinkUI':False,'originalClientBridge':False,'externalOffice':False,'production':False}
(out/'files.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
