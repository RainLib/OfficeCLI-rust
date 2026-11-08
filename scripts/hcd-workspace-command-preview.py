#!/usr/bin/env python3
"""Owned synthetic Word/PPT/PDF workbench for public workspace command verification."""
import json,os,runpy,secrets,shutil,signal,socket,subprocess,tempfile,time
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];editor=repo/'examples/hdoc/editor';binary=repo/'target/debug/officecli'
 runtime=repo/'target/hcd-preview-runtime';runtime.mkdir(parents=True,exist_ok=True)
 root=Path(tempfile.mkdtemp(prefix='hcd-workspace-command-',dir=runtime));root.chmod(0o700);owner=secrets.token_hex(16)
 runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'))['fixtures'](root)
 env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
 for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
 def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
 ports=[]
 for _ in range(3):
  with socket.socket() as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
 config={'root':str(root),'ports':ports,'previewPid':os.getpid(),'previewOwner':owner,'documents':{}};pages=[];children=[];logs=[];(root/'sources').mkdir()
 signal.signal(signal.SIGTERM,lambda *_:exit(0))
 try:
  for kind in ['docx','pptx','pdf']:
   doc='workspace-command-'+kind;source=root/f'fixture.{kind}';cli('import',source,'--output',root/f'{doc}.hcd','--document-id',doc);shutil.copyfile(source,root/f'sources/{doc}.{kind}')
   if kind=='docx':cli('project-editor',root/f'{doc}.hcd','--expected-revision',0)
   tokens={role:cli('issue-token','--document-id',doc,'--scope','read' if role=='reader' else 'write','--user-id',actor,'--display-name',name,'--ttl-seconds',3600)['token'] for role,actor,name in [('writer','alice','Alice 王'),('peer','bob','Bob 李'),('reader','reader','Reader 访客')]}
   config['documents'][kind]={'documentId':doc,**tokens}
   for role,token in tokens.items():
    page=editor/f'.hcd-workspace-command-{kind}-{role}.html';assert not page.exists(),'owned preview page already exists';pages.append(page)
    props={'documentId':doc,'token':token,'apiUrl':'/v1/documents','collabUrl':f'ws://127.0.0.1:{ports[1]}','locale':'zh-CN'}
    page.write_text('<!-- hcd-preview:'+owner+' --><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%}</style><div id="root"></div><script type="module">import React from"react";import{createRoot}from"react-dom/client";import{WorkspaceCommandFixture}from"/fixtures/workspaceCommands.tsx";createRoot(document.getElementById("root")).render(React.createElement(React.StrictMode,null,React.createElement(WorkspaceCommandFixture,'+json.dumps(props,ensure_ascii=False)+')));</script>');page.chmod(0o600)
  private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600);(runtime/'current-workspace-command.json').write_text(json.dumps({'root':str(root),'web':ports[2]}))
  vite=root/'vite.mjs';vite.write_text('import{createServer}from'+json.dumps(str(editor/'node_modules/vite/dist/node/index.js'))+';const s=await createServer({root:'+json.dumps(str(editor))+',configFile:false,server:{host:"127.0.0.1",port:'+str(ports[2])+',strictPort:true,proxy:{"/v1":{target:"http://127.0.0.1:'+str(ports[0])+'",ws:true}}}});await s.listen();')
  for name,command,extra in [('api',[str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'],{}),('sidecar',['node','--import','tsx','sidecar.ts'],{'HCD_API_URL':f'http://127.0.0.1:{ports[0]}','HCD_COLLAB_PORT':str(ports[1]),'HCD_SIDECAR_STATE_DIR':str(root/'sidecar-state')}),('web',['node',str(vite)],{})]:
   log=open(root/(name+'.log'),'ab');logs.append(log);children.append(subprocess.Popen(command,cwd=editor,env={**env,**extra},stdout=log,stderr=log))
  for port in ports:
   for _ in range(200):
    with socket.socket() as probe:
     if probe.connect_ex(('127.0.0.1',port))==0:break
    if any(child.poll() is not None for child in children):raise RuntimeError('owned fixture failed; inspect '+str(root))
    time.sleep(.1)
   else:raise RuntimeError('owned fixture port unavailable')
  print(json.dumps({'root':str(root),'web':ports[2]}),flush=True)
  while all(child.poll() is None for child in children):time.sleep(1)
 finally:
  for child in children:child.terminate()
  for child in children:
   try:child.wait(timeout=5)
   except subprocess.TimeoutExpired:child.kill();child.wait()
  for log in logs:log.close()
  for page in pages:
   if page.exists() and page.read_text().startswith('<!-- hcd-preview:'+owner+' -->'):page.unlink()
if __name__=='__main__':main()
