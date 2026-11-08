#!/usr/bin/env python3
"""Read back ordinary saves after link preflight; never apply a link."""
import hashlib,json,subprocess,sys,tempfile,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
config=json.loads((root/'private.json').read_text());evidence=json.loads((out/'service.json').read_text());binary=repo/'target/debug/officecli'
assert config['root']==str(root) and evidence['linkSubmitted'] is False
def cli(*args):
 return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=90).stdout)['data']
bundle=root/'region-test.hcd';cli('validate',bundle)
with zipfile.ZipFile(out/'ordinary-save.docx') as docx:
 text='\n'.join(''.join(ET.fromstring(docx.read(name)).itertext()) for name in docx.namelist() if name.startswith('word/') and name.endswith('.xml'))
 for marker in evidence['markers'].values():assert text.count(marker)==1,marker
 media={hashlib.sha256(docx.read(name)).hexdigest() for name in docx.namelist() if name.startswith('word/media/') and not name.endswith('/')}
with zipfile.ZipFile(root/'sources/region-test.docx') as source:
 original_media={hashlib.sha256(source.read(name)).hexdigest() for name in source.namelist() if name.startswith('word/media/') and not name.endswith('/')}
assert original_media and original_media.issubset(media)
with tempfile.TemporaryDirectory(prefix='link-preflight-readback-') as temporary:
 offline=Path(temporary)/'offline.hcd';cli('unpack',out/'ordinary-save.hcdz','--output',offline);cli('validate',offline)
 for revision in range(evidence['initial'],evidence['finalRevision']+1):
  live=cli('editor-state',bundle,'--revision',revision);copy=cli('editor-state',offline,'--revision',revision);assert live==copy
  current=live['flowLayout']['sections'][1]['headers']['even'];assert current==evidence['first']['summary']['retainedStoryId']
result={'scope':'downloaded ordinary-save DOCX/HCDZ after read-only link preflight; no link applied','nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'markersPresentExactlyOnce':True,'originalImageBytesPreserved':True,'explicitBindingRetainedAcrossEveryRevision':True,'offlineMatchesLiveRevisions':list(range(evidence['initial'],evidence['finalRevision']+1)),'nativeAndOfflineValidate':True,'externalOffice':False,'physicalDevice':False,'production':False}
(out/'files.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result))
