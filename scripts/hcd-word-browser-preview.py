#!/usr/bin/env python3
"""Resume an isolated --rich-ui fixture at its original origin for IDB recovery QA."""
import argparse,json,os,shutil,subprocess,time,urllib.request
from pathlib import Path
from urllib.parse import urlparse

def main():
 parser=argparse.ArgumentParser();parser.add_argument('fixture',type=Path);args=parser.parse_args();repo=Path(__file__).resolve().parents[1];root=args.fixture.resolve()
 if root.parent!=repo/'target/hcd-preview-runtime' or not root.name.startswith('word-room-'):raise ValueError('isolated fixture required')
 config=json.loads((root/'private.json').read_text())
 if not config.get('richUi') or Path(config['root'])!=root:raise ValueError('rich UI fixture required')
 editor=root/'editor';shutil.copytree(repo/'examples/hdoc/editor',editor,dirs_exist_ok=True,ignore=shutil.ignore_patterns('node_modules','dist','dist-embed','.hcd-*','recovery-*.html'))
 env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':config['secret'],'HCD_WORD_ROOMS':'1','HCD_API_URL':config['origin'],'HCD_COLLAB_PORT':str(config['collabPort']),'HCD_SIDECAR_STATE_DIR':str(root/'shared-sidecar')}
 for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
 children=[];logs=[]
 try:
  commands=[([str(repo/'target/debug/officecli'),'hdoc','serve','--root',str(root),'--bind',urlparse(config['origin']).netloc],repo,'native-resumed')]
  for command,cwd,label in commands:
   log=open(root/(label+'.log'),'w');logs.append(log);children.append(subprocess.Popen(command,cwd=cwd,env=env,stdout=log,stderr=log))
  deadline=time.monotonic()+30
  while True:
   assert all(child.poll() is None for child in children),'native exited'
   try:urllib.request.urlopen(urllib.request.Request(config['apiUrl']+'/auth',headers={'Authorization':'Bearer '+config['reader']}),timeout=1).close();break
   except OSError:assert time.monotonic()<deadline;time.sleep(.1)
  for command,label in [(['node','--import','tsx','sidecar.ts'],'sidecar-resumed'),([str(editor/'node_modules/.bin/vite'),'--config',str(root/'preview.config.ts')],'vite-resumed')]:
   log=open(root/(label+'.log'),'w');logs.append(log);children.append(subprocess.Popen(command,cwd=editor,env=env,stdout=log,stderr=log))
  urls={person:f'http://127.0.0.1:{config["vitePort"]}/recovery-{person}.html' for person in ['alice','bob','reader']}
  deadline=time.monotonic()+45
  while True:
   assert all(child.poll() is None for child in children),'preview exited'
   try:urllib.request.urlopen(urls['alice'],timeout=1).close();break
   except OSError:assert time.monotonic()<deadline;time.sleep(.1)
  print(json.dumps({'root':str(root),**urls}),flush=True)
  while all(child.poll() is None for child in children):time.sleep(.5)
 finally:
  for child in children:child.terminate()
  for child in children:
   try:child.wait(timeout=6)
   except subprocess.TimeoutExpired:child.kill();child.wait()
  for log in logs:log.close()
if __name__=='__main__':main()
