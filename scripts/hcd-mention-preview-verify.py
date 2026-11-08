#!/usr/bin/env python3
"""Read back the pinned revisions/files from the documented two-browser fixture.
Browser observations are recorded separately; this script cannot drive the UI.
"""
import hashlib,json,subprocess,sys,urllib.request,zipfile
from pathlib import Path

def main():
    repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root']);binary=repo/'target/debug/officecli';origin=config['origin']+'/v1/documents/mentions-docx'
    def request(route):
        response=urllib.request.urlopen(urllib.request.Request(origin+route,headers={'Authorization':'Bearer '+config['alice']}),timeout=90)
        return response.read()
    refs={n:json.loads(request('/references?revision='+str(n))) for n in [2,3,4,5]}
    initial=refs[2]['items'][0]['reference'];assert initial['target']['id']=='person:设计/乙' and refs[2]['transition']['events'][0]['context']['actorId']=='alice'
    assert refs[3]['items']==[] and refs[3]['transition']['events'][0]['kind']=='reference.removed'
    assert refs[4]['items'][0]['reference']['mentionId']==initial['mentionId'] and refs[4]['transition']['events'][0]['context']['actorId']=='alice'
    assert len(refs[5]['items'])==2 and len({v['reference']['mentionId'] for v in refs[5]['items']})==2 and {v['reference']['target']['id'] for v in refs[5]['items']}=={'person:设计/乙','person:产品/甲'}
    files=[]
    for fmt in ['docx','pdf','md']:
        path=root/('browser-saved-r5.'+fmt);path.write_bytes(request('/export/'+fmt+'?revision=5'));text=path.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True,timeout=90)
        assert text.count('@张三')==2 and 'Bob 的协作内容保留' in text and 'Alice 王' not in text and 'Bob 李' not in text,(fmt,text)
        if fmt=='docx':
            def media(path):
                with zipfile.ZipFile(path) as z:return sorted(hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if name.startswith('word/media/'))
            assert media(path)==media(root/'fixture.docx')
        files.append({'name':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'text':text})
    # Read the native artifact independently of directory/provider availability.
    archive=root/'browser-native-offline.zip'
    with zipfile.ZipFile(archive,'w') as z:
        for path in (root/'mentions-docx.hcd').rglob('*'):
            if path.is_file():z.write(path,path.relative_to(root/'mentions-docx.hcd'))
    offline=root/'browser-native-offline.hcd';offline.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as z:z.extractall(offline)
    projection=json.loads(subprocess.check_output([str(binary),'hdoc','editor-state',str(offline),'--json'],text=True))['data']
    offline_refs=[inline['reference'] for block in projection['blocks'] for inline in block['content']['inlines'] if 'reference' in inline]
    assert sorted(v['mentionId'] for v in offline_refs)==sorted(v['reference']['mentionId'] for v in refs[5]['items'])
    result={'schemaVersion':'hcd-mention-browser/1','scope':'Two real local embedded browser editors plus authenticated native API, immutable versions and exported-file readback. No organization provider, physical IME, PPT/PDF editor or multi-instance acceptance.',
      'browserObservations':{'typedAtChineseQuery':True,'homonymsDistinguishedByDetail':True,'arrowEnterSelectedSecondHomonym':True,'defaultCandidatesAndNextPage':True,'directoryFailureKeptTypedQuery':True,'retryRestoredCandidates':True,'peerSaveDidNotChangeReferenceAuthor':True,'ownUndoAndRedoAcrossSavedVersionsPreservedPeerInput':True,'onlineCollaborationNamesActivityAndFollow':True,'ownInputStoppedFollowing':True,'exportStaticRelationshipNotice':True,'sharedToolbarCommandAtWordEnd':True,'cancelAndUndoTriggerKeptCanonicalRevision5':True,'reopenR5PreservedMentionsAndPeerInput':True,'editorExportConfirmedRevision5':True},
      'nativeVerification':{'pinnedRevisions':[2,3,4,5],'firstAuthor':'alice','stableOccurrenceAfterUndoRedo':initial['mentionId'],'finalReferences':[v['reference'] for v in refs[5]['items']],'nativeOfflineIdentityReadback':True,'docxImageBytesUnchanged':True,'awarenessNamesExcludedFromExports':True,'reminders':refs[5]['reminders']},'files':files}
    target=repo/'docs/assets/hcd-mentions-2026-10-24/mention-browser-evidence.json';target.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print('PASS pinned browser revisions, per-occurrence authors, native offline identity and three actual exported files')

if __name__=='__main__':main()
