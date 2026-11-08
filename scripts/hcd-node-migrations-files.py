#!/usr/bin/env python3
"""Read back actual migration/undo/redo revisions and exported fixture files."""
import hashlib,json,shutil,subprocess,sys,urllib.request,zipfile
from pathlib import Path


def main():
    repo=Path(__file__).resolve().parents[1]
    config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root'])
    assert root.name.startswith('hcd-mention-preview-')
    socket=json.loads((root/'node-migration-socket-evidence.json').read_text())
    bundle=root/'mentions-docx.hcd';binary=repo/'target/debug/officecli'
    def state(revision,source=bundle):
        return json.loads(subprocess.check_output([str(binary),'hdoc','editor-state',str(source),'--revision',str(revision),'--json']))['data']
    def nodes(projection):
        return {n['instanceId']:n for b in projection['blocks'] for n in ([b['content']['extension']] if b['content'].get('extension') else [])+[i['extension'] for i in b['content']['inlines'] if i.get('extension')]}
    original=nodes(state(3));assert len(original)==4
    manifest=(bundle/'manifest.json').read_bytes()
    evidence={'scope':'Local migration/undo/redo immutable HCD revisions and nine exported files; no production, live PostgreSQL, physical Office or new PDF visual acceptance.', 'socket':socket,'files':[]}
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def get(path):
        return opener.open(urllib.request.Request(config['origin']+'/v1/documents/mentions-docx'+path,headers={'Authorization':'Bearer '+config['reader'],'X-HCD-Node-Edits-Version':'4'}),timeout=120).read()
    def media(path):
        with zipfile.ZipFile(path) as package:
            return sorted(hashlib.sha256(package.read(name)).hexdigest() for name in package.namelist() if name.startswith('word/media/'))
    for step in socket['revisions']:
        revision=step['revision'];current=nodes(state(revision));assert current.keys()==original.keys()
        assert all(current[key]==value for key,value in original.items() if value['type']=='example.future_card')
        for key in ['task','notice']:
            payload=step[key];assert current[payload['instanceId']]==payload
        for fmt in ['docx','pdf','md']:
            raw=get(f'/export/{fmt}?revision={revision}');path=root/f'migration-{step["label"]}-r{revision}.{fmt}';path.write_bytes(raw)
            text=path.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
            labels=[payload['fallback']['text'] for payload in current.values()]+['Bob 普通正文保留']
            assert all(text.count(label)==1 for label in labels),(step['label'],fmt,text)
            if fmt=='docx':assert media(path)==media(root/'fixture.docx')
            evidence['files'].append({'phase':step['label'],'revision':revision,'format':fmt,'sha256':hashlib.sha256(raw).hexdigest(),'eachFallbackAndPeerTextOnce':True})
    offline=root/'migration-offline.hcd';shutil.copytree(bundle,offline,dirs_exist_ok=True)
    assert nodes(state(socket['finalRevision'],offline))==nodes(state(socket['finalRevision']))
    assert (bundle/'manifest.json').read_bytes()==manifest
    evidence['checks']={'fourStableIdsAcrossRevisions':True,'unknownVersion77PayloadsUnchanged':True,'explicitChoicePreservesBobData':True,'undoRedoNativePayloadsCorrect':True,'originalImageMediaBytesUnchanged':True,'offlinePayloadsRetained':True,'exportsDoNotPublish':True}
    target=repo/'docs/assets/hcd-extensions-2026-10-24/node-migration-file-evidence.json';target.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
    print('PASS migration/undo/redo: nine actual files, stable identity, offline payloads, unknown nodes and source image media')


if __name__=='__main__':main()
