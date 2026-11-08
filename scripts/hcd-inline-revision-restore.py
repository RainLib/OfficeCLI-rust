#!/usr/bin/env python3
"""Owned real inline-model version restore, socket barriers and immutable files."""
import hashlib,json,os,secrets,shutil,socket,subprocess,tempfile,time,urllib.request,zipfile
from pathlib import Path


def main():
    repo=Path(__file__).resolve().parents[1];binary=repo/'target/debug/officecli'
    root=Path(tempfile.mkdtemp(prefix='hcd-inline-revision-restore-',dir=repo/'target/hcd-preview-runtime'))
    assets=repo/'docs/assets/hcd-inline-revision-restore-2026-10-27';assets.mkdir(exist_ok=True)
    env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
    def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
    original=repo/'docs/assets/hcd-inline-content-native-2026-10-26/inline-native-r8.hcdz';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();original_hash=sha(original)
    bundle=root/'inline-native.hcd';cli('unpack',original,'--output',bundle);initial=cli('editor-state',bundle)
    ports=[]
    for _ in range(2):
        with socket.socket() as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
    config={'root':str(root),'apiUrl':f'http://127.0.0.1:{ports[0]}/v1/documents/inline-native','collabPort':ports[1],'collabUrl':f'ws://127.0.0.1:{ports[1]}','secret':env['HCD_TOKEN_SECRET']}
    for user in ['alice','bob']:config[user]=cli('issue-token','--document-id','inline-native','--scope','write','--user-id',user,'--ttl-seconds',3600)['token']
    private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600)
    log=open(root/'api.log','wb');process=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'],env=env,stdout=log,stderr=log)
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(100):
            try:opener.open(urllib.request.Request(config['apiUrl']+'/auth',headers={'Authorization':'Bearer '+config['alice']}),timeout=1).close();break
            except OSError:time.sleep(.1)
        else:raise RuntimeError('native API did not start: '+str(root))
        result=subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-inline-revision-restore.mts'),str(private)],cwd=repo,env=env,capture_output=True,text=True,timeout=240)
        (root/'probe.log').write_text(result.stdout+result.stderr)
        assert result.returncode==0,str(root)+'\n'+result.stdout+result.stderr
        evidence=json.loads((root/'revision-restore-evidence.json').read_text())
        for item in evidence['files']:
            path=root/item['name']
            if path.suffix in ['.docx','.pptx']:
                with zipfile.ZipFile(path) as archive:text=''.join(archive.read(n).decode() for n in archive.namelist() if n.endswith('.xml'))
            elif path.suffix=='.pdf':text=subprocess.check_output(['pdftotext',str(path),'-'],text=True,timeout=60)
            else:text=path.read_text()
            for required in item['requiredText']:assert required in text,(path.name,required)
            for forbidden in item['forbiddenText']:assert forbidden not in text,(path.name,forbidden)
            item.update(actualFileVerified=True,sha256=sha(path));shutil.copyfile(path,assets/path.name)
        head=cli('editor-state',bundle)['revision']
        archive=root/'restored-history.hcdz';cli('pack',bundle,'--output',archive);offline=root/'offline.hcd';cli('unpack',archive,'--output',offline)
        for n in range(8,head+1):assert cli('editor-state',offline,'--revision',n)==cli('editor-state',bundle,'--revision',n)
        assert cli('editor-state',bundle,'--revision',8)==initial
        resources={}
        def visit(value):
            if isinstance(value,dict):
                for item in value.get('resources',[]):resources[item['hash']]=item
                for child in value.values():visit(child)
            elif isinstance(value,list):
                for child in value:visit(child)
        visit(initial);assert resources
        for digest,resource in resources.items():
            path=root/(digest+'.bin');cli('get-asset',offline,digest,'--revision',head,'--output',path);assert sha(path)==digest;assert path.stat().st_size==resource['byteLength'];shutil.copyfile(path,assets/path.name)
        assert cli('validate',offline)['valid'];assert sha(original)==original_hash
        shutil.copyfile(archive,assets/archive.name)
        evidence['validation'].update(actualFilesReadBack=True,offlineEveryRevisionExact=list(range(8,head+1)),originalHistoryAndArchiveUnchanged=True,offlineResourceHashes=list(resources),nativeBinarySha256=sha(binary))
    finally:
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        log.close()
    evidence['validation']['isolatedServicesStopped']=True
    (assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'root':str(root),'head':head,'files':len(evidence['files']),'resources':len(resources)}))

if __name__=='__main__':main()
