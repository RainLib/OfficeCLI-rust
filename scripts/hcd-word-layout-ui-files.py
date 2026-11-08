#!/usr/bin/env python3
"""Read back the saved native and offline files after the isolated UI check."""
import hashlib,json,os,secrets,subprocess,sys,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET
repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
c=json.loads((root/'private.json').read_text());assert c['root']==str(root)
env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':c['secret']}
for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
def cli(*args):return json.loads(subprocess.run([str(repo/'target/debug/officecli'),'hdoc',*map(str,args),'--json'],cwd=root,env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
browser=json.loads((out/'browser.json').read_text());head=browser['head'];bundle=root/'region-test.hcd'
states={n:cli('editor-state',bundle,'--revision',n) for n in range(1,head+1)}
docx=out/'browser-saved.docx';docx.unlink(missing_ok=True);cli('export',bundle,'--revision',head,'--output',docx)
with zipfile.ZipFile(docx) as archive:text=''.join(ET.fromstring(archive.read('word/document.xml')).itertext())
for expected in ['Shared draft from Bob','Archived draft from Alice','Alice browser edit','Bob browser edit']:assert expected in text,expected
archive=out/'browser-saved.hcdz';archive.unlink(missing_ok=True);cli('pack',bundle,'--output',archive);offline=root/('browser-offline-'+secrets.token_hex(4)+'.hcd');cli('unpack',archive,'--output',offline)
for revision,projection in states.items():assert cli('editor-state',offline,'--revision',revision)==projection
assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid']
def geometry(layout):
 value=json.loads(json.dumps(layout))
 for section in value['sections']:section.pop('canonicalEndBlockId',None)
 return value
assert geometry(states[head]['flowLayout'])==geometry(states[c['initialProjection']['revision']]['flowLayout']),'content-only UI editing must preserve page fields and story topology'
result={'scope':'saved DOCX XML and actual HCDZ pack/unpack after isolated real browser editing','head':head,'bothRecoveredAuthorsAndBrowserEditsInDocx':True,'pageGeometryAndStoryTopologyUnchanged':True,'canonicalEndIdsMayRebind':True,'offlineExactVersions':list(states),'nativeAndOfflineValidate':True,'docxSha256':hashlib.sha256(docx.read_bytes()).hexdigest(),'hcdzSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'nativeBinarySha256':c['nativeBinarySha256'],'externalOfficeAcceptance':False}
(out/'readback.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))
