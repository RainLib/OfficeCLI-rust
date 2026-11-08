#!/usr/bin/env python3
"""Read actual native history and files after stopped link-journal recovery."""
import hashlib,json,subprocess,sys,tempfile,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
c=json.loads((root/'private.json').read_text());assert c['root']==str(root)
e=json.loads((out/'peers.json').read_text());binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=90).stdout)['data']
assert cli('validate',bundle)['valid'];states={revision:cli('editor-state',bundle,'--revision',revision) for revision in range(e['initial'],e['finalRevision']+1)}
for revision,p in states.items():
 assert ('even' in p['flowLayout']['sections'][1]['headers'])==(revision<e['linkRevision'])
 assert p['flowLayout']['stories']==states[e['initial']]['flowLayout']['stories']
 text='\n'.join(item.get('text','') for block in p['blocks'] for item in block['content'].get('inlines',[]))
 assert (e['markers']['draft'] in text)==(revision>=e['recoverySaveRevision'])
for revision in [e['linkRevision'],e['recoverySaveRevision'],e['finalRevision']]:
 target=out/f'r{revision}.docx';cli('export',bundle,'--revision',revision,'--output',target)
 with zipfile.ZipFile(target) as package:
  text='\n'.join(''.join(ET.fromstring(package.read(name)).itertext()) for name in package.namelist() if name.startswith('word/') and name.endswith('.xml'))
  assert (e['markers']['draft'] in text)==(revision>=e['recoverySaveRevision'])
  if revision==e['finalRevision']:
   for marker in e['markers'].values():assert text.count(marker)==1,marker
  media={hashlib.sha256(package.read(name)).hexdigest() for name in package.namelist() if name.startswith('word/media/') and not name.endswith('/')}
 with zipfile.ZipFile(root/'sources/region-test.docx') as source:
  original={hashlib.sha256(source.read(name)).hexdigest() for name in source.namelist() if name.startswith('word/media/') and not name.endswith('/')}
 assert original and original.issubset(media)
archive=out/'journal-history.hcdz';cli('pack',bundle,'--revision',e['finalRevision'],'--output',archive)
with tempfile.TemporaryDirectory(prefix='hcd-link-journal-readback-') as temporary:
 offline=Path(temporary)/'offline.hcd';cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid']
 for revision,p in states.items():assert p==cli('editor-state',offline,'--revision',revision)
result={'scope':'actual files after stopped signed-journal recovery and fresh Socket continuation','nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'offlineVerifiedRevisions':list(states),'linkChangesOnlyOnce':True,'draftSavedAtRecoveryRevision':True,'threeMarkersExactlyOnce':True,'originalImageBytesPreserved':True,'allStoriesRetained':True,'nativeAndOfflineValidate':True,'normalLinkUI':False,'liveReplacement':False,'externalOffice':False,'production':False}
(out/'files.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
