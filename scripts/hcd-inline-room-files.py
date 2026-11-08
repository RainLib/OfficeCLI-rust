#!/usr/bin/env python3
"""Owned real sidecar/native integration. No user rooms or documents changed."""
import argparse,hashlib,json,os,secrets,shutil,socket,subprocess,tempfile,time,urllib.request,zipfile
from pathlib import Path

def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

def verify_block_resources(cli,bundle,offline,head,block_evidence,assets,work):
    """Read actual copied envelopes and offline file bytes, not UI labels."""
    state=cli('editor-state',bundle);nodes={}
    def visit(value):
        if isinstance(value,dict):
            if value.get('schemaVersion')=='hcd.extension/3':nodes[value['instanceId']]=value
            for child in value.values():visit(child)
        elif isinstance(value,list):
            for child in value:visit(child)
    visit(state)
    original=nodes[block_evidence['instanceId']].get('resources',[]);assert original
    hashes=[]
    for instance in block_evidence['createdIds']:
        resources=nodes[instance].get('resources',[]);assert resources==original
        for resource in resources:
            if resource['hash'] in hashes:continue
            output=work/('copied-resource-'+str(len(hashes))+'.bin');cli('get-asset',offline,resource['hash'],'--revision',head,'--output',output)
            assert output.stat().st_size==resource['byteLength'];assert hashlib.sha256(output.read_bytes()).hexdigest()==resource['hash']
            shutil.copy2(output,assets/output.name);hashes.append(resource['hash'])
    assert hashes
    return hashes

def main():
    parser=argparse.ArgumentParser();modes=parser.add_mutually_exclusive_group();modes.add_argument('--draft-recovery',action='store_true');modes.add_argument('--commands',action='store_true');modes.add_argument('--node-files',action='store_true');modes.add_argument('--inline-interactions',action='store_true');modes.add_argument('--block-operations',action='store_true');args=parser.parse_args();args.inline_interactions=args.inline_interactions or args.block_operations;args.commands=args.commands or args.node_files or args.inline_interactions
    repo=Path(__file__).resolve().parents[1];editor=repo/'examples/hdoc/editor';binary=repo/'target/debug/officecli'
    root=Path(tempfile.mkdtemp(prefix='hcd-inline-block-operations-' if args.block_operations else 'hcd-inline-interactions-' if args.inline_interactions else 'hcd-inline-node-files-' if args.node_files else 'hcd-inline-commands-' if args.commands else 'hcd-inline-device-' if args.draft_recovery else 'hcd-inline-room-',dir=repo/'target/hcd-preview-runtime'));assets=repo/('docs/assets/hcd-inline-block-operations-2026-10-27' if args.block_operations else 'docs/assets/hcd-inline-interactions-2026-10-27' if args.inline_interactions else 'docs/assets/hcd-inline-node-files-2026-10-27' if args.node_files else 'docs/assets/hcd-inline-commands-2026-10-27' if args.commands else 'docs/assets/hcd-inline-device-2026-10-27' if args.draft_recovery else 'docs/assets/hcd-inline-room-2026-10-27');assets.mkdir(exist_ok=True)
    env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':secrets.token_hex(32),'HCD_INLINE_ROOMS':'1'}
    for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
    def cli(*args):
        p=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],cwd=root,env=env,capture_output=True,text=True,check=True,timeout=120);return json.loads(p.stdout)['data']
    archive=repo/'docs/assets/hcd-inline-content-native-2026-10-26/inline-native-r8.hcdz';original_hash=hashlib.sha256(archive.read_bytes()).hexdigest();bundle=root/'inline-native.hcd';cli('unpack',archive,'--output',bundle)
    (root/'people').mkdir();(root/'people/inline-native.json').write_text(json.dumps({'schemaVersion':'hcd-people/1','generation':1,'people':[{'id':'alice','label':'Alice 王','active':True},{'id':'bob','label':'Bob 李','active':True}]}))
    native_port,collab_port=port(),port();origin=f'http://127.0.0.1:{native_port}';collab=f'http://127.0.0.1:{collab_port}'
    config={'root':str(root),'origin':origin,'collabOrigin':collab,'collabUrl':f'ws://127.0.0.1:{collab_port}','secret':env['HCD_TOKEN_SECRET'],'draftRecovery':args.draft_recovery,'commands':args.commands,'nodeFiles':args.node_files,'interactions':args.inline_interactions,'blocks':args.block_operations}
    for user in ['alice','bob','reader']:config[user]=cli('issue-token','--document-id','inline-native','--scope','read' if user=='reader' else 'write','--user-id',user,'--display-name',user,'--ttl-seconds',1200)['token']
    if args.draft_recovery:
        plain=root/'ordinary.txt';plain.write_text('Ordinary document remains unchanged')
        cli('import',plain,'--document-id','ordinary','--output',root/'ordinary.hcd');cli('project-editor',root/'ordinary.hcd','--expected-revision',0)
        config['ordinary']=cli('issue-token','--document-id','ordinary','--scope','write','--user-id','alice','--ttl-seconds',1200)['token']
    private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600)
    env.update(HCD_API_URL=origin,HCD_COLLAB_PORT=str(collab_port),HCD_SIDECAR_STATE_DIR=str(root/'sidecar'))
    logs=[];children=[]
    def spawn(command,name,cwd):
        log=open(root/(name+'.log'),'w');logs.append(log);child=subprocess.Popen(command,cwd=cwd,env=env,stdout=log,stderr=log);children.append(child);return child
    def ready(url,child):
        deadline=time.monotonic()+40
        while True:
            assert child.poll() is None,'Owned service exited: '+str(root)
            try:urllib.request.urlopen(url,timeout=1).close();return
            except OSError:assert time.monotonic()<deadline,'Owned service did not start';time.sleep(.05)
    try:
        native=spawn([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{native_port}'],'native',root);ready(origin+'/health',native)
        for phase in ['prepare','resume']:
            sidecar=spawn(['node','--import','tsx','sidecar.ts'],'sidecar-'+phase,editor);ready(collab+'/health',sidecar)
            try:p=subprocess.run(['node','--import','tsx','fixtures/inlineRoomSocket.ts',str(private),phase],cwd=editor,capture_output=True,text=True,timeout=300)
            except subprocess.TimeoutExpired as error:
                output=lambda value:value.decode(errors='replace') if isinstance(value,bytes) else value or ''
                (root/(phase+'.log')).write_text(output(error.stdout)+output(error.stderr));raise RuntimeError('Owned fixture timed out: '+str(root)) from error
            (root/(phase+'.log')).write_text(p.stdout+p.stderr)
            if p.returncode:raise RuntimeError(str(root)+'\n'+p.stdout+p.stderr)
            sidecar.terminate();sidecar.wait(timeout=15)
        evidence={name:json.loads((root/(name+'-evidence.json')).read_text()) for name in ['prepare','resume']};head=evidence['resume']['head'];assert cli('validate',bundle)['valid']
        if args.commands:evidence['commands']=json.loads((root/'command-evidence.json').read_text())
        if args.inline_interactions:evidence['interactions']=json.loads((root/'interaction-evidence.json').read_text())
        if args.block_operations:evidence['blocks']=json.loads((root/'block-evidence.json').read_text())
        exported={}
        for extension in ['docx','pdf','pptx','md']:
            path=root/('inline-room-r'+str(head)+'.'+extension);report=cli('export',bundle,'--to',extension,'--revision',head,'--output',path);assert path.stat().st_size>0
            if extension in ['docx','pptx']:
                with zipfile.ZipFile(path) as z:text=''.join(z.read(n).decode(errors='ignore') for n in z.namelist() if n.endswith('.xml'))
            elif extension=='pdf':text=subprocess.run(['pdftotext',str(path),'-'],capture_output=True,text=True,check=True).stdout
            else:text=path.read_text()
            assert 'Restart后' in text and 'Alice真实协同' in text and 'Bob迟到输入' in text,extension
            if args.draft_recovery:assert 'Device离线' in text and 'Peer在线' in text,extension
            if args.commands:assert '命令行内正文' in text and '命令字段更新 v2' in text,extension
            if args.inline_interactions:assert 'AI采纳' in text and 'Bob 李' in text,extension
            if args.block_operations:assert '同伴块保留' in text and '嵌套字段正文' in text,extension
            exported[extension]={'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'level':report['level'],'warnings':report.get('warnings',[])};(assets/path.name).write_bytes(path.read_bytes())
        packed=root/'inline-room.hcdz';cli('pack',bundle,'--revision',head,'--output',packed);offline=root/'offline.hcd';cli('unpack',packed,'--output',offline);assert cli('editor-state',offline)==cli('editor-state',bundle);assert cli('validate',offline)['valid'];(assets/packed.name).write_bytes(packed.read_bytes())
        if args.block_operations:evidence['blocks']['offlineSharedResourcesExact']=verify_block_resources(cli,bundle,offline,head,evidence['blocks'],assets,root)
        if args.node_files:
            files=json.loads((root/'node-files-evidence.json').read_text());resource=files['resource'];actual=root/'offline-node-file.bin';cli('get-asset',offline,resource['hash'],'--revision',head,'--output',actual);assert actual.read_bytes()==bytes(files['bytes']);assert hashlib.sha256(actual.read_bytes()).hexdigest()==resource['hash'];files['offlineAssetBytesExact']=True;evidence['nodeFiles']=files;shutil.copyfile(actual,assets/actual.name)
        assert hashlib.sha256(archive.read_bytes()).hexdigest()==original_hash
        evidence.update(head=head,exports=exported,offlineCanonicalMatches=True,originalArchiveUnchanged=True,nativeBinarySha256=hashlib.sha256(binary.read_bytes()).hexdigest());(assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'root':str(root),'head':head,'exports':list(exported)},ensure_ascii=False))
    finally:
        for child in children:
            if child.poll() is None:child.terminate()
        for child in children:
            try:child.wait(timeout=8)
            except subprocess.TimeoutExpired:child.kill();child.wait()
        for log in logs:log.close()

if __name__=='__main__':main()
