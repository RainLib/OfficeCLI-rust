#!/usr/bin/env python3
"""Canonical readback after confirming an older link without promoting it."""
import hashlib,json,subprocess,sys,tempfile,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
c=json.loads((root/'private.json').read_text());assert c['root']==str(root)
e=json.loads((out/'historical.json').read_text());binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=90).stdout)['data']
assert e['historical'] and e['promotionRefused'] and cli('validate',bundle)['valid']
states={revision:cli('editor-state',bundle,'--revision',revision) for revision in range(e['initial'],e['headRevision']+1)}
for revision,p in states.items():
 assert ('even' in p['flowLayout']['sections'][1]['headers'])==(revision!=e['linkRevision'])
 assert e['marker'] not in json.dumps(p,ensure_ascii=False)
 assert p['flowLayout']['stories']==states[e['initial']]['flowLayout']['stories']
for revision in [e['linkRevision'],e['headRevision']]:
 target=out/f'r{revision}.docx';cli('export',bundle,'--revision',revision,'--output',target)
 with zipfile.ZipFile(target) as package:
  text='\n'.join(''.join(ET.fromstring(package.read(name)).itertext()) for name in package.namelist() if name.startswith('word/') and name.endswith('.xml'));assert e['marker'] not in text
archive=out/'historical-confirmation.hcdz';cli('pack',bundle,'--revision',e['headRevision'],'--output',archive)
with tempfile.TemporaryDirectory(prefix='hcd-link-history-readback-') as temporary:
 offline=Path(temporary)/'offline.hcd';cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid']
 for revision,p in states.items():assert p==cli('editor-state',offline,'--revision',revision)
assert cli('editor-state',bundle)['revision']==e['headRevision']
result={'scope':'older native link confirmation with private signed draft retained; canonical restore untouched','nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'offlineVerifiedRevisions':list(states),'canonicalHeadUnchanged':True,'privateDraftNotPublished':True,'linkAndRestoreBindingsVerified':True,'nativeAndOfflineValidate':True,'normalLinkUI':False,'production':False}
(out/'files.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
