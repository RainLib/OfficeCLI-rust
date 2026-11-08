#!/usr/bin/env python3
"""Read actual stopped-draft browser downloads, revisions, DOCX and HCDZ."""
import hashlib,json,subprocess,sys,tempfile,urllib.request,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

repo=Path(__file__).resolve().parents[1]
root,out=map(lambda value:Path(value).resolve(),sys.argv[1:3]);kind=sys.argv[3]
assert kind in ['save','cancel']
assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
c=json.loads((root/'private.json').read_text());assert c['root']==str(root)
binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
def cli(*args):
 return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=120).stdout)['data']
def read(route):
 return json.load(urllib.request.urlopen(urllib.request.Request(c['origin']+'/v1/documents/region-test'+route,headers={'Authorization':'Bearer '+c['reader']}),timeout=30))

assert cli('validate',bundle)['valid'] and cli('editor-state',bundle)['revision']==2
states={r:cli('editor-state',bundle,'--revision',r) for r in [1,2]}
assert 'Shared draft from Bob' not in json.dumps(states[1]) and 'Shared draft from Bob' in json.dumps(states[2])
def geometry(layout):
 value=json.loads(json.dumps(layout))
 for section in value['sections']:section.pop('canonicalEndBlockId',None)
 return value
assert geometry(states[1]['flowLayout'])==geometry(states[2]['flowLayout'])
assert (out/f'{kind}-request.json').read_bytes()==(out/f'{kind}-request-reopened.json').read_bytes()
request=json.loads((out/f'{kind}-request.json').read_text());records=json.loads((root/'draft-ui-proxy-records.json').read_text())
saves=[item for item in records if item['action']=='save' and item.get('status')==200]
assert len(saves)==1 and saves[0]['response']=={'saved':True,'revision':2,'checkpointId':saves[0]['body']['checkpointId']}
if kind=='save':
 assert request['checkpointId']==saves[0]['body']['checkpointId'] and request['actions'][0]['body']==saves[0]['body']
 assert saves[0]['mode']=='drop-success'
 assert any(item['action']=='inspect' and item.get('response',{}).get('status')=='confirmed' and item['response']['checkpointId']==request['checkpointId'] for item in records)
else:
 assert [action['kind'] for action in request['actions']]==['save','cancel']
 cancels=[item for item in records if item['action']=='cancel' and item.get('status')==200]
 assert len(cancels)==2 and all(item['body']['checkpointId']==request['checkpointId'] for item in cancels)
 assert cancels[0]['mode']=='drop-success-block-retry' and cancels[1]['mode']=='pass'
 assert saves[0]['body']['checkpointId']!=request['checkpointId']
 assert json.loads((out/'cancel-late-save.json').read_text())['head']==1
revision=read('/revisions/2');assert revision['authorId']=='bob' and revision['authorName']=='Bob 李'
assert saves[0]['body']['checkpointId'] in revision['patchId']
with zipfile.ZipFile(root/'sources/region-test.docx') as z:
 original_media={hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if name.startswith('word/media/') and not name.endswith('/')}
assert original_media
docx=out/f'{kind}-r2.docx';cli('export',bundle,'--revision',2,'--output',docx)
with zipfile.ZipFile(docx) as z:
 text=''.join(ET.fromstring(z.read('word/document.xml')).itertext());assert text.count('Shared draft from Bob')==1
 media={hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if name.startswith('word/media/') and not name.endswith('/')}
 assert original_media.issubset(media)
archive=out/f'{kind}-history.hcdz';cli('pack',bundle,'--revision',2,'--output',archive)
with tempfile.TemporaryDirectory(prefix='stopped-device-readback-',dir=root) as temporary:
 directory=Path(temporary);offline=directory/'offline.hcd';cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid']
 for revision,state in states.items():assert cli('editor-state',offline,'--revision',revision)==state
 reimport=directory/'reimport.hcd';cli('import',docx,'--word-regions','--output',reimport);assert cli('validate',reimport)['valid'];assert 'Shared draft from Bob' in json.dumps(cli('editor-state',reimport))
(out/f'{kind}-network.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
result={'scope':'actual ordinary compatibility UI and loopback fault proxy; same physical computer and synthetic signed drafts','kind':kind,'head':2,'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'nativeAndOfflineValidate':True,'offlineExactRevisions':[1,2],'downloadExactAfterCloseAndSidecarRestart':True,'oneSuccessfulSave':True,'originalBobAuthorship':True,'docxTextOnce':True,'imageBytesPreserved':True,'docxReimport':True,'pageGeometryUnchanged':True,'docxSha256':hashlib.sha256(docx.read_bytes()).hexdigest(),'hcdzSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'physicalDeviceFailure':False,'externalOffice':False,'production':False}
(out/f'{kind}-file-readback.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
