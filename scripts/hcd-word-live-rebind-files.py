#!/usr/bin/env python3
"""Read back actual UI undo/redo exports, native bundle and device backup."""
import hashlib,json,os,subprocess,sys,zipfile,xml.etree.ElementTree as ET
from pathlib import Path
repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();config=json.loads((root/'private.json').read_text());e=json.loads((out/'browser.json').read_text());assert config['root']==str(root) and root.parent==repo/'target/hcd-preview-runtime'
binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd';env={**os.environ,'NO_COLOR':'1'}
def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True).stdout)['data']
head=e['redoRevision'];states={revision:cli('editor-state',bundle,'--revision',revision) for revision in range(e['initial'],head+1)}
assert cli('validate',bundle)['valid']
for name,key in [('undo','undoRevision'),('redo','redoRevision')]:
 path=out/f'own-{name}.docx';cli('export',bundle,'--revision',e[key],'--output',path)
 with zipfile.ZipFile(path) as archive:
  xml=ET.fromstring(archive.read('word/document.xml'));text=''.join(xml.itertext());assert text.count(e['markers']['peer'])==1;assert text.count(e['markers']['own'])==(1 if name=='redo' else 0)
  page=xml.find('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}sectPr/{http://schemas.openxmlformats.org/wordprocessingml/2006/main}pgSz');assert page is not None and int(page.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}w'))==e['pageWidthTwips']
base_regions={block['blockId']:block for block in states[e['initial']]['blocks'] if block['region'] in ['header','footer']};last_regions={block['blockId']:block for block in states[head]['blocks'] if block['region'] in ['header','footer']};assert base_regions==last_regions
archive=out/f'regional-live-rebind-r{head}.hcdz';offline=root/f'live-rebind-offline-r{head}.hcd';cli('pack',bundle,'--revision',head,'--output',archive);cli('unpack',archive,'--output',offline)
for revision,state in states.items():assert cli('editor-state',offline,'--revision',revision)==state
assert cli('validate',offline)['valid'];assert cli('editor-state',offline)['revision']==head;(out/'final-projection.json').write_text(json.dumps(states[head],ensure_ascii=False)+'\n')
subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-word-live-rebind-backup.mts'),str(root),str(out)],cwd=repo,check=True,capture_output=True,text=True)
result={'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'archive':archive.name,'docxUndoRedoAndPeerVerified':True,'docxPageWidthVerified':True,'headerFooterUnchanged':True,'offlineVerifiedRevisions':list(states),'nativeAndOfflineValidate':True,'deviceBackupReadback':json.loads((out/'backup-readback.json').read_text())}
(out/'file-readback.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))
