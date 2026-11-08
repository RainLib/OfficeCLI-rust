#!/usr/bin/env python3
"""Read actual link, own undo/redo, inherited edits, offline and device files."""
import hashlib,json,subprocess,sys,tempfile,zipfile,posixpath
from pathlib import Path
from xml.etree import ElementTree as ET
repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();c=json.loads((root/'private.json').read_text());e=json.loads((out/'browser.json').read_text())
assert c['root']==str(root) and root.parent==repo/'target/hcd-preview-runtime'
binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=90).stdout)['data']
assert cli('validate',bundle)['valid'];assert cli('editor-state',bundle)['revision']==e['finalRevision']
states={revision:cli('editor-state',bundle,'--revision',revision) for revision in range(e['initial'],e['finalRevision']+1)}
base=states[e['initial']];expected=json.loads(json.dumps(base['flowLayout']));assert expected['sections'][1]['headers'].pop('even')==e['retainedStoryId'];assert states[e['linkRevision']]['blocks']==base['blocks']
for revision,p in states.items():
 assert p['flowLayout']==(base['flowLayout'] if revision<e['linkRevision'] else expected)
 text=json.dumps(p,ensure_ascii=False)
 for label,marker in e['markers'].items():
  present=revision>=(e['finalRevision'] if label=='header' else e['peerRevision'] if label=='postPeer' else e['linkRevision']+1) and not(label=='own' and revision==e['undoRevision'])
  assert (marker in text)==present,(revision,label)
 if revision==e['finalRevision']:
  matching=[block for block in p['blocks'] if e['markers']['header'] in json.dumps(block,ensure_ascii=False)];assert len(matching)==1 and matching[0]['flowRegionId']==e['inheritedStoryId']
 retained=lambda state:[block for block in state['blocks'] if block.get('flowRegionId')==e['retainedStoryId']]
 assert retained(p)==retained(base)
ns='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}';rn='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
with zipfile.ZipFile(root/'sources/region-test.docx') as source:original={hashlib.sha256(source.read(name)).hexdigest() for name in source.namelist() if name.startswith('word/media/') and not name.endswith('/')}
assert original
for revision in [e['linkRevision'],e['undoRevision'],e['redoRevision'],e['finalRevision']]:
 path=out/f'r{revision}.docx';cli('export',bundle,'--revision',revision,'--output',path)
 with zipfile.ZipFile(path) as z:
  document=ET.fromstring(z.read('word/document.xml'));body=''.join(document.itertext())
  for label in ['own','peer','postPeer']:
   present=revision>=(e['peerRevision'] if label=='postPeer' else e['linkRevision']+1) and not(label=='own' and revision==e['undoRevision']);assert body.count(e['markers'][label])==int(present),(revision,label)
  parents={child:parent for parent in document.iter() for child in parent};sections=[node for node in document.iter() if node.tag==ns+'sectPr' and parents.get(node) is not None and parents[node].tag!=ns+'sectPrChange']
  assert len(sections)==len(expected['sections']);assert not any(node.tag==ns+'headerReference' and node.get(ns+'type')=='even' for node in sections[1])
  ref=next(node for node in sections[0] if node.tag==ns+'headerReference' and node.get(ns+'type')=='even');rels=ET.fromstring(z.read('word/_rels/document.xml.rels'));relationship=next(node for node in rels if node.get('Id')==ref.get(rn+'id'));part=posixpath.normpath(posixpath.join('word',relationship.get('Target')))
  assert ''.join(ET.fromstring(z.read(part)).itertext()).count(e['markers']['header'])==int(revision==e['finalRevision'])
  media={hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if name.startswith('word/media/') and not name.endswith('/')};assert original.issubset(media)
archive=out/'link-session-history.hcdz'
with tempfile.TemporaryDirectory(prefix='hcd-link-session-',dir=root) as temporary:
 candidate=Path(temporary)/archive.name;offline=Path(temporary)/'offline.hcd';cli('pack',bundle,'--revision',e['finalRevision'],'--output',candidate);cli('unpack',candidate,'--output',offline);assert cli('validate',offline)['valid']
 for revision,p in states.items():assert p==cli('editor-state',offline,'--revision',revision)
 candidate.replace(archive)
(out/'final-projection.json').write_text(json.dumps(states[e['finalRevision']],ensure_ascii=False)+'\n')
subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-word-link-session-backup.mts'),str(root),str(out)],cwd=repo,capture_output=True,text=True,check=True,timeout=60)
result={'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'offlineVerifiedRevisions':list(states),'nativeAndOfflineValidate':True,'onlyLinkBindingChanged':True,'ownUndoRedoRetainsBothPeerInputs':True,'retainedStoryUnchanged':True,'inheritedEditTargetsSource':True,'docxBindingsAndMarkersVerified':True,'originalImageBytesPreserved':True,'deviceBackupReadback':json.loads((out/'backup-readback.json').read_text()),'normalLinkCreationUI':False,'externalOffice':False,'physicalDevice':False,'production':False}
(out/'file-readback.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
