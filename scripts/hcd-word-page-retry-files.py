#!/usr/bin/env python3
"""Read actual DOCX and full HCDZ history after page request transport faults."""
import hashlib,json,os,subprocess,sys,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

repo=Path(__file__).resolve().parents[1]
root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
assert root.parent==repo/'target/hcd-preview-runtime'
config=json.loads((root/'private.json').read_text());assert config['root']==str(root)
e=json.loads((out/'browser.json').read_text());binary=repo/'target/debug/officecli'
bundle=root/'region-test.hcd';env={**os.environ,'NO_COLOR':'1'}
def cli(*args):
    return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=90).stdout)['data']

assert cli('validate',bundle)['valid']
states={n:cli('editor-state',bundle,'--revision',n) for n in range(e['initial'],e['finalRevision']+1)}
document=out/'recovered.docx';cli('export',bundle,'--revision',e['finalRevision'],'--output',document)
ns='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
with zipfile.ZipFile(document) as archive:
    body=ET.fromstring(archive.read('word/document.xml'))
    assert ''.join(body.itertext()).count(e['marker'])==1
    page=body.find('.//'+ns+'sectPr/'+ns+'pgSz')
    assert page is not None and int(page.get(ns+'w'))==e['pageWidthTwips']
regions=lambda state:{b['blockId']:b for b in state['blocks'] if b['region'] in ['header','footer']}
assert regions(states[e['initial']])==regions(states[e['finalRevision']])
archive=out/f"page-{e['mode']}-r{e['finalRevision']}.hcdz"
offline=root/f"page-{e['mode']}-offline-r{e['finalRevision']}.hcd"
cli('pack',bundle,'--revision',e['finalRevision'],'--output',archive);cli('unpack',archive,'--output',offline)
assert cli('validate',offline)['valid'];assert cli('editor-state',offline)['revision']==e['finalRevision']
for revision,state in states.items():assert cli('editor-state',offline,'--revision',revision)==state
result={'mode':e['mode'],'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'docx':document.name,'docxPeerTextAndPaperVerified':True,'headerFooterUnchanged':True,'archive':archive.name,'offlineVerifiedRevisions':list(states),'nativeAndOfflineValidate':True,'production':False,'physicalDevice':False}
(out/'file-readback.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False))
