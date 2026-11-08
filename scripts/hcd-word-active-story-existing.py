#!/usr/bin/env python3
"""Resume the exact private native/sidecar fixture after a stopped process.
Only accepts the synthetic fixture roots created by our browser driver.
"""
import json,os,subprocess,sys,time,urllib.request
from pathlib import Path

repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
c=json.loads((root/'private.json').read_text());assert c['root']==str(root) and c['clean']
env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':c['secret']}
for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
children=[];logs=[]
def start(command,label,extra=None,cwd=repo):
    log=open(root/(label+'.log'),'w');logs.append(log)
    child=subprocess.Popen(command,cwd=cwd,env={**env,**(extra or {})},stdout=log,stderr=log);children.append(child)
def wait(url,headers=None):
    end=time.monotonic()+45
    while True:
        assert all(p.poll() is None for p in children),'owned service exited'
        try:urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=1).close();return
        except OSError:assert time.monotonic()<end;time.sleep(.1)
try:
    start([str(repo/'target/debug/officecli'),'hdoc','serve','--root',str(root),'--bind',c['origin'].removeprefix('http://')],'existing-native')
    wait(c['origin']+'/v1/documents/region-test/auth',{'Authorization':'Bearer '+c['reader']})
    start(['node','--import','tsx','sidecar.ts'],'existing-sidecar',{'HCD_API_URL':c['origin'],'HCD_COLLAB_PORT':str(c['collabPort']),'HCD_SIDECAR_STATE_DIR':str(root/'sidecar'),'HCD_WORD_ROOMS':'1','HCD_WORD_LAYOUT_ROOMS':'1'},repo/'examples/hdoc/editor')
    wait(f"http://127.0.0.1:{c['collabPort']}")
    result=subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-word-active-story-recover.mts'),str(root),str(out)],cwd=repo,capture_output=True,text=True,timeout=120)
    (out/'existing-recovery-console.log').write_text(result.stdout+result.stderr)
    assert result.returncode==0,'exact recovery failed; inspect owned console log'
    print(result.stdout.strip(),flush=True)
finally:
    for child in reversed(children):child.terminate()
    for child in children:
        try:child.wait(timeout=8)
        except subprocess.TimeoutExpired:child.kill();child.wait()
    for log in logs:log.close()
