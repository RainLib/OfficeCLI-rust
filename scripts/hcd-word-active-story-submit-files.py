#!/usr/bin/env python3
"""Inspect actual independent footer relationships, saved drafts and history."""
import hashlib,json,os,posixpath,subprocess,sys,tempfile,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve();recovery='--recovery' in sys.argv[3:];editor='--editor' in sys.argv[3:]
assert root.parent==repo/'target/hcd-preview-runtime'
assert json.loads((root/'private.json').read_text())['root']==str(root)
name='lease-failure-recovery' if recovery else 'service';e=json.loads((out/(name+'.json')).read_text()) if not editor else json.loads((out.parent/'service.json').read_text());binary=repo/'target/debug/officecli';bundle=root/'region-test.hcd'
if editor:
    editing=json.loads((out/'browser.json').read_text());assert editing['storyId']==e['pending']['story']['id'];e['finalRevision']=editing['finalRevision'];name='editor'
def cli(*args):
    result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env={**os.environ,'NO_COLOR':'1'},capture_output=True,text=True,timeout=90)
    if result.returncode:raise RuntimeError(result.stderr or result.stdout)
    return json.loads(result.stdout)['data']
states={n:cli('editor-state',bundle,'--revision',n) for n in range(min(1,e['initial']),e['finalRevision']+1)}
before=states[e['initial']]['flowLayout'];after=states[e['storyRevision']]['flowLayout'];pending=e['pending'];target=next(i for i,s in enumerate(before['sections']) if s['id']==pending['intent']['sectionId']);bindings='headers' if pending['intent']['kind']=='header' else 'footers';variant=pending['intent']['variant']
assert len(after['stories'])==len(before['stories'])+1 and after['stories'][:-1]==before['stories']
assert after['stories'][-1]==pending['story'];assert variant not in before['sections'][target][bindings];assert after['sections'][target][bindings][variant]==pending['story']['id']
for i,s in enumerate(before['sections']):
    expected=json.loads(json.dumps(s));expected.pop('canonicalEndBlockId',None)
    actual=json.loads(json.dumps(after['sections'][i]));actual.pop('canonicalEndBlockId',None)
    if i==target:expected[bindings][variant]=pending['story']['id']
    assert expected==actual
assert states[e['finalRevision']]['flowLayout']['stories']==after['stories']
docx=out/(name+'.docx');cli('export',bundle,'--revision',e['finalRevision'],'--output',docx)
ns='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}';rn='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
with zipfile.ZipFile(docx) as z:
    document=ET.fromstring(z.read('word/document.xml'));text=''.join(document.itertext())
    assert text.count(e['markers']['own'])==1 and text.count(e['markers']['peer'])==1
    parents={child:parent for parent in document.iter() for child in parent}
    sections=[node for node in document.iter() if node.tag==ns+'sectPr' and parents.get(node) is not None and parents[node].tag!=ns+'sectPrChange']
    assert len(sections)==len(after['sections'])
    reference=next(node for node in sections[target] if node.tag==ns+pending['intent']['kind']+'Reference' and node.get(ns+'type')==variant)
    relationships=ET.fromstring(z.read('word/_rels/document.xml.rels'));relationship=next(node for node in relationships if node.get('Id')==reference.get(rn+'id'));part=posixpath.normpath(posixpath.join('word',relationship.get('Target')))
    assert part.startswith('word/') and part in z.namelist()
    inherited=pending['intent']['expectedInheritedStoryId']
    if inherited:
        source_index=next(i for i,s in enumerate(before['sections']) if s[bindings].get(variant)==inherited)
        source_reference=next(node for node in sections[source_index] if node.tag==ns+pending['intent']['kind']+'Reference' and node.get(ns+'type')==variant)
        source_relationship=next(node for node in relationships if node.get('Id')==source_reference.get(rn+'id'))
        assert source_relationship.get('Target')!=relationship.get('Target')
    copied=''.join(ET.fromstring(z.read(part)).itertext())
    edited_marker=editing['marker'] if editor else e.get('storyMarker')
    if edited_marker:
        assert copied.count(edited_marker)==1
        for item in z.namelist():
            if item.startswith('word/') and item.endswith('.xml') and item!=part:assert edited_marker not in ''.join(ET.fromstring(z.read(item)).itertext())
    for block in pending['blocks']:
        for inline in block['content'].get('inlines',[]):
            if inline.get('text'):assert inline['text'] in copied
archive=out/(name+'.hcdz')
with tempfile.TemporaryDirectory(prefix='active-story-readback-',dir=root) as temporary:
    work=Path(temporary);candidate=work/archive.name;offline=work/'offline.hcd'
    cli('pack',bundle,'--revision',e['finalRevision'],'--output',candidate);cli('unpack',candidate,'--output',offline)
    assert cli('editor-state',offline)['revision']==e['finalRevision']
    for revision,state in states.items():assert cli('editor-state',offline,'--revision',revision)==state
    assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid']
    os.replace(candidate,archive)
manifest=json.loads((bundle/'manifest.json').read_text());assert hashlib.sha256((root/'sources/region-test.docx').read_bytes()).hexdigest()==manifest['source']['sha256']
result={'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'docx':docx.name,'bodyBothAuthorsOnce':True,'independentStoryRelationshipVerified':True,'copiedStoryTextVerified':True,'otherBindingsAndPageFieldsUnchanged':True,'sourceFileUnchanged':True,'archive':archive.name,'offlineVerifiedRevisions':list(states),'nativeAndOfflineValidate':True,'normalStoryUI':bool(e.get('normalStoryCreationUI')),'externalOffice':False,'production':False}
if editor:result['normalEditorIndependentStoryEditVerified']=True
if e.get('automaticStoryRebind'):
    for label,key in [('undo','undoRevision'),('redo','redoRevision')] if 'undoRevision' in e else []:
        path=out/('own-'+label+'.docx');cli('export',bundle,'--revision',e[key],'--output',path)
        with zipfile.ZipFile(path) as archive_file:
            body=''.join(ET.fromstring(archive_file.read('word/document.xml')).itertext())
            assert body.count(e['markers']['peer'])==1 and body.count(e['markers']['own'])==(1 if label=='redo' else 0)
    (out/'final-projection.json').write_text(json.dumps(states[e['finalRevision']],ensure_ascii=False)+'\n')
    subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-word-story-session-backup.mts'),str(root),str(out)],cwd=repo,check=True,capture_output=True,text=True)
    result.update(normalEditorStoryRebindVerified=True,docxPersonalUndoRedoVerified='undoRevision' in e,deviceBackupReadback=json.loads((out/'backup-readback.json').read_text()))
(out/(name+'-files.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))
