#!/usr/bin/env python3
"""Read immutable versions after the documented CUA migration UI workflow."""
import hashlib,json,shutil,subprocess,sys,urllib.request,zipfile
from pathlib import Path


def main():
    repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root'])
    assert root.name.startswith('hcd-mention-preview-')
    binary=repo/'target/debug/officecli';bundle=root/'mentions-docx.hcd';manifest=(bundle/'manifest.json').read_bytes()
    conflict=len(sys.argv)>2 and sys.argv[2]=='--conflict'
    if len(sys.argv)>2:assert conflict,'unknown scenario'
    final=7 if conflict else 10
    assert json.loads(manifest)['revision']==final
    def state(revision,source=bundle):
        return json.loads(subprocess.check_output([str(binary),'hdoc','editor-state',str(source),'--revision',str(revision),'--json']))['data']
    def nodes(projection):
        return {n['instanceId']:n for block in projection['blocks'] for n in ([block['content']['extension']] if block['content'].get('extension') else [])+[i['extension'] for i in block['content']['inlines'] if i.get('extension')]}
    original=nodes(state(3));assert len(original)==4
    evidence={'scope':'Isolated CUA fixture, immutable migration revisions, twelve actual export files and offline readback; no PDF visual/production/physical-device claim.','root':str(root),'versions':[],'files':[]}
    expected={3:(1,1),4:(1,2),5:(1,1),6:(1,2),7:(2,2)} if conflict else {3:(1,1),4:(2,1),5:(1,1),6:(2,1),7:(2,2),8:(2,1),9:(2,2),10:(2,2)}
    for revision,versions in expected.items():
        projection=state(revision);current=nodes(projection);assert current.keys()==original.keys()
        by_type={node['type']:node for node in current.values() if node['type']!='example.future_card'}
        assert (by_type['example.task']['version'],by_type['example.notice']['version'])==versions
        for key,before in original.items():
            after=current[key]
            if before['type']=='example.future_card':assert after==before
            else:
                assert after['instanceId']==before['instanceId'] and after['display']==before['display'] and after['type']==before['type']
                field='caption' if after['version']==2 else 'title'
                title=('离线成员修改保留' if conflict and revision>=5 else '升级后继续编辑' if revision==10 else before['data']['title']) if after['type']=='example.notice' else before['data']['title']
                assert after['data']=={field:title,'done':False,'priority':1}
        body='\n'.join(i['text'] for block in projection['blocks'] for i in block['content']['inlines'])
        if not conflict and revision>=5:assert body.count('Bob 页面输入保留')==1
        evidence['versions'].append({'revision':revision,'taskVersion':versions[0],'noticeVersion':versions[1],'stableIdsAndUnknownPayloads':True})
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def media(path):
        with zipfile.ZipFile(path) as package:
            return sorted(hashlib.sha256(package.read(name)).hexdigest() for name in package.namelist() if name.startswith('word/media/'))
    for revision in [4,5,6,final]:
        labels=[node['fallback']['text'] for node in nodes(state(revision)).values()]
        if not conflict and revision>=5:labels.append('Bob 页面输入保留')
        for fmt in ['docx','pdf','md']:
            req=urllib.request.Request(config['origin']+f'/v1/documents/mentions-docx/export/{fmt}?revision={revision}',headers={'Authorization':'Bearer '+config['reader'],'X-HCD-Node-Edits-Version':'4'})
            raw=opener.open(req,timeout=120).read();path=root/f'browser-migration-r{revision}.{fmt}';path.write_bytes(raw)
            text=path.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
            assert all(text.count(label)==1 for label in labels),(revision,fmt,text)
            if fmt=='docx':assert media(path)==media(root/'fixture.docx')
            evidence['files'].append({'revision':revision,'format':fmt,'path':str(path),'sha256':hashlib.sha256(raw).hexdigest(),'exactTextAndOriginalMedia':True})
    offline=root/'browser-migration-offline.hcd';shutil.copytree(bundle,offline,dirs_exist_ok=True)
    assert nodes(state(final,offline))==nodes(state(final));assert (bundle/'manifest.json').read_bytes()==manifest
    evidence['checks']={'allFourOccurrenceIdsStable':True,'unknownDataUnchanged':True,'offlineNativePayloadsRetained':True,'readbackDoesNotPublish':True,**({'wholeVersionChoicePreservesOfflineEdit':True,'schemasNeverMixed':True} if conflict else {'postMigrationPropertyEditRetained':True,'historicalRestorePreservesSchemaAndPeerText':True})}
    name='node-migration-schema-file-evidence.json' if conflict else 'node-migration-browser-file-evidence.json'
    (repo/'docs/assets/hcd-extensions-2026-10-24'/name).write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
    print('PASS CUA migration scenario: complete native payloads, twelve exported files, stable identities and offline readback')


if __name__=='__main__':main()
