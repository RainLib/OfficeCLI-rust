#!/usr/bin/env python3
"""Exercise actual local native receipts and sidecar recovery on disposable data."""
import json,os,secrets,socket,subprocess,sys,tempfile,time,urllib.request,urllib.error
from pathlib import Path
repo=Path(__file__).resolve().parents[1];binary=repo/'target/debug/officecli';editor=repo/'examples/hdoc/editor';source=repo/'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx'
env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32),'NO_COLOR':'1','CARGO_TARGET_DIR':str(repo/'target')}
def cli(*args):
 result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,text=True,capture_output=True,check=True,timeout=120);return json.loads(result.stdout)['data']
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
with tempfile.TemporaryDirectory(prefix='word-story-sidecar-',dir=repo/'target') as temp:
 root=Path(temp);project=root/'generator';(project/'src').mkdir(parents=True);(project/'src/main.rs').write_text((repo/'scripts/hcd-word-story-real-fixture.rs').read_text())
 (project/'Cargo.toml').write_text('[package]\nname="word-story-real-fixture"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nhcd-core={path='+json.dumps(str(repo/'crates/hcd-core'))+'}\nhcd-docx={path='+json.dumps(str(repo/'crates/hcd-docx'))+'}\nserde_json="1"\n[workspace]\n')
 result=subprocess.run(['cargo','run','--offline','--manifest-path',str(project/'Cargo.toml'),'--',str(source),str(root/'doc.hcd'),*(['multi'] if '--multi' in sys.argv else [])],env=env,capture_output=True,text=True,timeout=300)
 if result.returncode:raise RuntimeError(result.stderr[-6000:])
 fixture=json.loads(result.stdout);fixture_path=root/'fixture.json';fixture_path.write_text(json.dumps(fixture,ensure_ascii=False));assert fixture['revision']==(3 if '--multi' in sys.argv else 2)
 token=cli('issue-token','--document-id','doc','--scope','write','--user-id','alice')['token'];service=cli('issue-token','--document-id','doc','--scope','write','--user-id','hcd-collaboration')['token']
 collab=root/'collaboration';collab.mkdir();(collab/'doc.epoch').write_text(json.dumps({'epoch':0,'protocol':'hcd-word-regions/1'}))
 native_port=port();sidecar_port=port();api=f'http://127.0.0.1:{native_port}'
 native=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{native_port}'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  deadline=time.monotonic()+30
  while True:
   assert native.poll() is None
   try:
    with urllib.request.urlopen(urllib.request.Request(api+'/v1/documents/doc/auth',headers={'Authorization':'Bearer '+service}),timeout=1) as response:
     if response.status==200:break
   except urllib.error.URLError:pass
   assert time.monotonic()<deadline;time.sleep(.05)
  run=subprocess.run(['node','--import','tsx',str(repo/'scripts/hcd-word-story-real-sidecar.mts'),str(root/'sidecar'),str(fixture_path),api,str(sidecar_port),token],cwd=editor,env=env,capture_output=True,text=True,timeout=60)
  if run.returncode:raise RuntimeError(run.stderr[-6000:])
  evidence=json.loads(run.stdout);assert evidence['revision']==fixture['revision'] and evidence['lateDraftPreserved'] and not evidence['oldClientSynced']
  assert cli('validate',root/'doc.hcd')['valid'];print(json.dumps(evidence,ensure_ascii=False))
 finally:
  native.terminate()
  try:native.wait(timeout=10)
  except subprocess.TimeoutExpired:native.kill();native.wait()
