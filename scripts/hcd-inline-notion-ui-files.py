#!/usr/bin/env python3
"""Read native revisions produced through the owned main-editor Notion UI test."""
import argparse,hashlib,json,os,re,shutil,subprocess,tempfile,urllib.request,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET


def main():
    repo=Path(__file__).resolve().parents[1];parser=argparse.ArgumentParser();parser.add_argument('root',type=Path);parser.add_argument('--head',type=int,choices=[23,24],default=24);args=parser.parse_args();root=args.root.resolve();head=args.head
    assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-inline-editor-')
    assets=repo/'docs/assets/hcd-inline-notion-ui-2026-10-27';assets.mkdir(exist_ok=True);binary=repo/'target/debug/officecli';bundle=root/'inline-native.hcd';work=Path(tempfile.mkdtemp(prefix='notion-files-',dir=root));env={**os.environ,'NO_COLOR':'1'}
    def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
    states={n:cli('editor-state',bundle,'--revision',n) for n in range(14,head+1)}
    def text(value):
        if isinstance(value,dict):
            if value.get('kind')=='extension':return ''.join(text(v) for v in value.get('inlines',[]))
            if 'text' in value:return value['text']
            return ''.join(text(v) for k,v in value.items() if k not in ['extension','reference'])
        if isinstance(value,list):return ''.join(text(v) for v in value)
        return ''
    def containers(state):
        result={}
        def visit(value):
            if isinstance(value,dict):
                if value.get('kind')=='extension' and value.get('extension',{}).get('schemaVersion')=='hcd.extension/3':result[value['extension']['instanceId']]=value
                for v in value.values():visit(v)
            elif isinstance(value,list):
                for v in value:visit(v)
        visit(state);return result
    original={b['blockId']:b for b in states[14]['blocks'] if 'Field label' in json.dumps(b)}
    assert len(original)==3
    for n,state in states.items():
        blocks={b['blockId']:b for b in state['blocks']}
        for key,value in original.items():assert blocks[key]==value,(n,key)
    before=containers(states[14]);created=set(containers(states[20]))-set(before);assert len(created)==2
    outer='x_564cb56e25a04b8d86502701271ce805';inner='x_a357e63c178742a4a1d1e43a6590605f'
    assert created=={outer,inner};assert text(containers(states[17])[inner])=='NestedUI @Bob 李 '
    assert text(containers(states[19])[inner])=='NestedUI @Bob';assert text(containers(states[20])[inner])=='NestedUI @Bob 李 '
    for n in range(18,head+1):assert 'Bob UI retained' in text(states[n])
    copies=set(containers(states[21]))-set(containers(states[20]));assert len(copies)==2
    assert sorted(text(containers(states[21])[i]) for i in copies)==sorted(text(containers(states[20])[i]) for i in created)
    block21={b['blockId']:b for b in states[21]['blocks']};block22={b['blockId']:b for b in states[22]['blocks']};assert block21==block22
    assert [b['blockId'] for b in states[21]['blocks']]!=[b['blockId'] for b in states[22]['blocks']]
    assert len(states[22]['blocks'])==7
    body=containers(states[23])[inner];assert ''.join(v.get('text','') for v in body['inlines'])=='NestedUI @Bob 李 '
    assert [v['text'] for v in body['inlines'] if v.get('bold')]==['es']
    for instance in copies:assert containers(states[23])[instance]==containers(states[22])[instance]
    if head==24:
        assert {b['blockId']:b for b in states[24]['blocks']}=={b['blockId']:b for b in states[23]['blocks']}
        assert [b['blockId'] for b in states[24]['blocks']]!=[b['blockId'] for b in states[23]['blocks']]
    private=json.loads((root/'private.json').read_text());base=f"http://127.0.0.1:{private['ports'][0]}/v1/documents/inline-native"
    headers={'Authorization':'Bearer '+private['tokens']['alice'],'X-HCD-Node-Edits-Version':'7','X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3','X-HCD-Custom-Marks-Version':'1'}
    refs={}
    for n in range(17,head+1):
        with urllib.request.urlopen(urllib.request.Request(base+f'/references?revision={n}&locations=true',headers=headers),timeout=10) as response:refs[n]=json.load(response)
        assert refs[n]['reminders']['enabled'] is False
        (assets/f'references-r{n}.json').write_text(json.dumps(refs[n],ensure_ascii=False,indent=2)+'\n')
    bob=lambda n:{v['reference']['mentionId']:v for v in refs[n]['items'] if v['reference']['target']['id']=='bob'}
    assert len(bob(17))==1 and bob(17).keys()==bob(18).keys()==bob(20).keys();assert not bob(19)
    mention=next(iter(bob(17)));assert bob(17)[mention]['inlinePath']==[0,1]
    assert len(bob(21))==2 and bob(21).keys()==bob(22).keys()==bob(23).keys()
    for n in [18,22,23]+([24] if head==24 else []):assert refs[n]['transition']['events']==[]
    for n,kind in [(17,'reference.created'),(19,'reference.removed'),(20,'reference.created'),(21,'reference.created')]:
        events=refs[n]['transition']['events'];assert len(events)==1 and events[0]['kind']==kind and events[0]['context']['actorId']=='alice'
    copied_mention=next(iter(bob(21).keys()-bob(20).keys()));assert copied_mention!=mention
    exports={}
    for extension in ['docx','pptx','pdf','md']:
        path=work/('notion-r'+str(head)+'.'+extension);report=cli('export',bundle,'--to',extension,'--revision',head,'--output',path)
        if extension in ['docx','pptx']:
            with zipfile.ZipFile(path) as z:rendered=''.join(''.join(ET.fromstring(z.read(name)).itertext()) for name in z.namelist() if name.endswith('.xml'))
        elif extension=='pdf':rendered=subprocess.check_output(['pdftotext',str(path),'-'],text=True)
        else:
            rendered=path.read_text();assert 'N<strong>es</strong>tedUI' in rendered;rendered=re.sub(r'</?(?:strong|em|s|u)>','',rendered)
        rendered=re.sub(r'\s+','',rendered)
        for required in ['NestedUI','@Bob李','BobUIretained','还原后继续编辑😀']:assert required in rendered,(extension,required)
        assert rendered.count('NestedUI')==2,(extension,rendered)
        exports[extension]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'level':report['level']};shutil.copyfile(path,assets/path.name)
        if extension=='md':
            reopened=work/'markdown-reopened.hcd';cli('import',path,'--output',reopened,'--document-id','notion-markdown');cli('project-editor',reopened,'--expected-revision',0)
            projection=cli('editor-state',reopened);bold=[]
            def inspect(value):
                if isinstance(value,dict):
                    if value.get('bold') and value.get('text'):bold.append(value['text'])
                    for child in value.values():inspect(child)
                elif isinstance(value,list):
                    for child in value:inspect(child)
            inspect(projection);assert 'es' in bold;exports[extension]['reimportBoldText']='es'
    archive=work/('notion-r'+str(head)+'.hcdz');cli('pack',bundle,'--output',archive);offline=work/'offline.hcd';cli('unpack',archive,'--output',offline)
    for n,state in states.items():assert cli('editor-state',offline,'--revision',n)==state
    assert cli('validate',offline)['valid'];shutil.copyfile(archive,assets/archive.name)
    resources={}
    def resource_visit(value):
        if isinstance(value,dict):
            for item in value.get('resources',[]):resources[item['hash']]=item
            for v in value.values():resource_visit(v)
        elif isinstance(value,list):
            for v in value:resource_visit(v)
    resource_visit(states[head]);assert resources
    for digest,value in resources.items():
        path=work/(digest+'.bin');cli('get-asset',offline,digest,'--revision',head,'--output',path);assert hashlib.sha256(path.read_bytes()).hexdigest()==digest;assert path.stat().st_size==value['byteLength'];shutil.copyfile(path,assets/path.name)
    evidence={'scope':'Actual two-user CUA main editor actions followed by native immutable revisions, HTTP references and offline files','head':head,'slashCreatedNestedNodes':sorted(created),'mentionRevision':17,'peerRevision':18,'undoRevision':19,'redoRevision':20,'copyRevision':21,'moveRevision':22,'selectionBoldRevision':23,'postFixDragRevision':24 if head==24 else None,'copiedContainerIds':sorted(copies),'mentionId':mention,'copiedMentionId':copied_mention,'originalThreeBlocksExactEveryRevision':True,'peerInputRetainedByOwnUndoRedo':True,'movedBlocksExact':True,'inlineBoldText':'es','unrelatedReferenceEventsEmpty':[18,22,23]+([24] if head==24 else []),'remindersSent':False,'exports':exports,'offlineVersionsExact':list(states),'resourceHashesExact':list(resources)}
    (assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(json.dumps(evidence,ensure_ascii=False))

if __name__=='__main__':main()
