#!/usr/bin/env python3
"""Read saved drafts and immutable layout after live story preflight."""
import hashlib,json,os,subprocess,sys,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

repo=Path(__file__).resolve().parents[1]
root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
assert root.parent==repo/'target/hcd-preview-runtime'
c=json.loads((root/'private.json').read_text());assert c['root']==str(root) and c['clean']
e=json.loads((out/'browser.json').read_text());binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
def cli(*args):
    return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env={**os.environ,'NO_COLOR':'1'},capture_output=True,text=True,check=True,timeout=90).stdout)['data']
states={revision:cli('editor-state',bundle,'--revision',revision) for revision in range(e['initial'],e['finalRevision']+1)}
def topology(state):
    layout=state['flowLayout']
    return {'stories':layout['stories'],'sections':[{key:s.get(key) for key in ['id','headers','footers','page','differentFirstPage','breakType']} for s in layout['sections']],'evenAndOddHeaders':layout['evenAndOddHeaders']}
for state in states.values():assert topology(state)==topology(states[e['initial']])
assert e['stablePreview']['body']['pending']['story']['id'] not in {s['id'] for s in states[e['finalRevision']]['flowLayout']['stories']}
docx=out/'saved-drafts.docx';cli('export',bundle,'--revision',e['finalRevision'],'--output',docx)
with zipfile.ZipFile(docx) as z:
    parts={name:''.join(ET.fromstring(z.read(name)).itertext()) for name in z.namelist() if name.startswith('word/') and name.endswith('.xml')}
    assert sum(value.count(e['markers']['body']) for value in parts.values())==1
    assert sum(value.count(e['markers']['footer']) for value in parts.values())==1
archive=out/f"story-preview-r{e['finalRevision']}.hcdz";offline=root/f"story-preview-offline-r{e['finalRevision']}.hcd"
cli('pack',bundle,'--revision',e['finalRevision'],'--output',archive);cli('unpack',archive,'--output',offline)
assert cli('editor-state',offline)['revision']==e['finalRevision']
for revision,state in states.items():assert cli('editor-state',offline,'--revision',revision)==state
assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid']
source=root/'sources/region-test.docx';manifest=json.loads((bundle/'manifest.json').read_text())
assert hashlib.sha256(source.read_bytes()).hexdigest()==manifest['source']['sha256']
result={'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'docx':docx.name,'savedBodyAndFooterOnce':True,'storyAndSectionLayoutUnchanged':True,'previewCandidateNotInstalled':True,'sourceFileUnchanged':True,'archive':archive.name,'offlineVerifiedRevisions':list(states),'nativeAndOfflineValidate':True,'production':False,'physicalDevice':False,'activeStoryCommitVerified':False}
(out/'file-readback.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))
