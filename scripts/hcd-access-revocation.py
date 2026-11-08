#!/usr/bin/env python3
"""Isolated native API + sidecar proof. No credentials are copied into evidence."""
import argparse, json, os, runpy, secrets, socket, subprocess, tempfile, time, urllib.request, urllib.error
from pathlib import Path

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--binary',type=Path,default=Path('target/debug/officecli'));args=parser.parse_args()
    repo=Path(__file__).resolve().parents[1];binary=args.binary.resolve();root=Path(tempfile.mkdtemp(prefix='hcd-access-'))
    helpers=runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'));helpers['fixtures'](root)
    env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
    def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
    cli('import',root/'fixture.docx','--output',root/'doc.hcd','--document-id','doc')
    (root/'sources').mkdir();(root/'sources/doc.docx').write_bytes((root/'fixture.docx').read_bytes())
    cli('project-editor',root/'doc.hcd','--expected-revision',0)
    ports=[]
    for _ in range(2):
        with socket.socket() as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
    config={'root':str(root),'apiUrl':f'http://127.0.0.1:{ports[0]}/v1/documents','collabUrl':f'ws://127.0.0.1:{ports[1]}'}
    for key,scope,user in [('alice','write','alice'),('bob','write','bob'),('manager','manage','owner'),('service','write','hcd-collaboration')]:config[key]=cli('issue-token','--document-id','doc','--scope',scope,'--user-id',user,'--ttl-seconds',3600)['token']
    private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600)
    processes=[];logs=[]
    try:
        for name,command,extra in [('api',[str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'],{}),('sidecar',['node','--import','tsx','sidecar.ts'],{'HCD_API_URL':f'http://127.0.0.1:{ports[0]}','HCD_COLLAB_PORT':str(ports[1])})]:
            log=open(root/f'{name}.log','wb');logs.append(log);processes.append(subprocess.Popen(command,cwd=repo/'examples/hdoc/editor',env={**env,**extra},stdout=log,stderr=log))
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(100):
            try:
                opener.open(urllib.request.Request(config['apiUrl']+'/doc/auth',headers={'Authorization':'Bearer '+config['bob']}),timeout=1).close()
                with socket.create_connection(('127.0.0.1',ports[1]),timeout=1):pass
                break
            except OSError:time.sleep(.1)
        else:raise RuntimeError('isolated API/sidecar did not start')
        subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-access-revocation.mts'),str(private)],cwd=repo,check=True,timeout=90)
        print('Evidence:',root/'access-evidence.json')
    finally:
        for process in reversed(processes):
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        for log in logs:log.close()
if __name__=='__main__':main()
