#!/usr/bin/env python3
"""Independent DOCX/HCDZ readback for normal and historical link recovery UI."""
import hashlib,json,subprocess,sys,tempfile,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
c=json.loads((root/'private.json').read_text());assert c['root']==str(root)
e=json.loads((out/'recovery.json').read_text());binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=90).stdout)['data']
assert cli('validate',bundle)['valid'];assert cli('editor-state',bundle)['revision']==e['headRevision']==3
states={revision:cli('editor-state',bundle,'--revision',revision) for revision in range(1,4)}
bindings='headers' if e['selection']['kind']=='header' else 'footers';variant=e['selection']['variant'];target=next(i for i,section in enumerate(states[1]['flowLayout']['sections']) if section['id']==e['selection']['sectionId'])
assert states[1]['blocks']==states[2]['blocks']
expected=json.loads(json.dumps(states[1]['flowLayout']));del expected['sections'][target][bindings][variant]
assert states[2]['flowLayout']==expected
assert states[3]['flowLayout']==(states[1]['flowLayout'] if e['historical'] else expected)
for revision,p in states.items():
 assert (variant in p['flowLayout']['sections'][target][bindings])==(revision==1 or e['historical'] and revision==3)
 assert p['flowLayout']['stories']==states[1]['flowLayout']['stories']
 if e['historical']:
  for marker in e['markers'].values():assert marker not in json.dumps(p,ensure_ascii=False)
 else:
  for marker in e['markers'].values():assert (marker in json.dumps(p,ensure_ascii=False))==(revision==3)
with zipfile.ZipFile(root/'sources/region-test.docx') as source:
 original={hashlib.sha256(source.read(name)).hexdigest() for name in source.namelist() if name.startswith('word/media/') and not name.endswith('/')}
assert original
ns='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
for revision in [2,3]:
 target_file=out/f'r{revision}.docx';cli('export',bundle,'--revision',revision,'--output',target_file)
 with zipfile.ZipFile(target_file) as package:
  document=ET.fromstring(package.read('word/document.xml'));text=''.join(document.itertext())
  for marker in e['markers'].values():assert text.count(marker)==(1 if not e['historical'] and revision==3 else 0)
  parents={child:parent for parent in document.iter() for child in parent}
  sections=[node for node in document.iter() if node.tag==ns+'sectPr' and parents.get(node) is not None and parents[node].tag!=ns+'sectPrChange']
  assert len(sections)==len(states[revision]['flowLayout']['sections'])
  direct=any(node.tag==ns+e['selection']['kind']+'Reference' and node.get(ns+'type')==variant for node in sections[target])
  assert direct==(e['historical'] and revision==3)
  media={hashlib.sha256(package.read(name)).hexdigest() for name in package.namelist() if name.startswith('word/media/') and not name.endswith('/')};assert original.issubset(media)
archive=out/'recovery-history.hcdz'
with tempfile.TemporaryDirectory(prefix='hcd-link-recovery-ui-',dir=root) as temporary:
 candidate=Path(temporary)/archive.name;cli('pack',bundle,'--revision',3,'--output',candidate)
 offline=Path(temporary)/'offline.hcd';cli('unpack',candidate,'--output',offline);assert cli('validate',offline)['valid']
 for revision,p in states.items():assert p==cli('editor-state',offline,'--revision',revision)
 candidate.replace(archive)
result={'scope':'actual files after normal browser link recovery and explicit save, or historical confirmation without publication','historical':e['historical'],'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'offlineVerifiedRevisions':[1,2,3],'onlyLinkBindingChangedAtR2':True,'allStoriesRetained':True,'docxBindingsVerified':True,'originalImageBytesPreserved':True,'privateDraftNotPublished':e['historical'],'bodyMarkersSavedOnlyAtR3':not e['historical'],'nativeAndOfflineValidate':True,'normalRecoveryUI':True,'normalLinkCreationUI':False,'externalOffice':False,'production':False}
(out/'files.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
