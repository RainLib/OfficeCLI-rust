#!/usr/bin/env python3
"""Owned read-only browser workbench for the saved synthetic PDF layout fixture."""
import argparse,json,os,secrets,signal,socket,subprocess,time
from pathlib import Path

def main():
 parser=argparse.ArgumentParser();parser.add_argument('root',type=Path);args=parser.parse_args()
 repo=Path(__file__).resolve().parents[1];root=args.root.resolve();runtime=repo/'target/hcd-preview-runtime';editor=repo/'examples/hdoc/editor';binary=repo/'target/debug/officecli'
 assert root.parent==runtime.resolve() and root.name.startswith('hcd-pdf-search-');manifest=json.loads((root/'search-pdf.hcd/manifest.json').read_text());assert manifest['source']['format']=='pdf'
 env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
 for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
 ports=[]
 for _ in range(3):
  with socket.socket() as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
 owner=secrets.token_hex(16);pages=[];children=[];logs=[];signal.signal(signal.SIGTERM,lambda *_:exit(0));config={'root':str(root),'ports':ports,'previewPid':os.getpid(),'previewOwner':owner,'documentId':'search-pdf','revision':manifest['revision'],'actors':{}}
 try:
  for role,name in [('reader','Alice 只读'),('peer','Bob 只读')]:
   token=json.loads(subprocess.check_output([str(binary),'hdoc','issue-token','--document-id','search-pdf','--scope','read','--user-id','layout-'+role,'--display-name',name,'--ttl-seconds','3600','--json'],env=env))['data']['token'];config['actors'][role]=token
   page=editor/f'.hcd-pdf-layout-{role}.html';assert not page.exists(),'owned page already exists';pages.append(page)
   props={'documentId':'search-pdf','token':token,'apiUrl':'/v1/documents','collabUrl':f'ws://127.0.0.1:{ports[1]}','locale':'zh-CN'}
   page.write_text('<!-- hcd-preview:'+owner+' --><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%}</style><div id="root"></div><script type="module">import React from"react";import{createRoot}from"react-dom/client";import{EmbeddedHcdEditor}from"/src/embed.tsx";createRoot(document.getElementById("root")).render(React.createElement(React.StrictMode,null,React.createElement(EmbeddedHcdEditor,'+json.dumps(props,ensure_ascii=False)+')));</script>');page.chmod(0o600)
  private=root/'layout-preview-private.json';private.write_text(json.dumps(config));private.chmod(0o600);(runtime/'current-pdf-layout.json').write_text(json.dumps({'root':str(root),'web':ports[2]}))
  vite=root/'layout-preview-vite.mjs';vite.write_text('import{createServer}from'+json.dumps(str(editor/'node_modules/vite/dist/node/index.js'))+';const s=await createServer({root:'+json.dumps(str(editor))+',configFile:false,server:{host:"127.0.0.1",port:'+str(ports[2])+',strictPort:true,proxy:{"/v1":{target:"http://127.0.0.1:'+str(ports[0])+'",ws:true}}}});await s.listen();')
  for name,command,extra in [('api',[str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'],{}),('sidecar',['node','--import','tsx','sidecar.ts'],{'HCD_API_URL':f'http://127.0.0.1:{ports[0]}','HCD_COLLAB_PORT':str(ports[1]),'HCD_SIDECAR_STATE_DIR':str(root/('layout-sidecar-'+owner))}),('web',['node',str(vite)],{})]:
   log=open(root/('layout-'+name+'.log'),'ab');logs.append(log);children.append(subprocess.Popen(command,cwd=editor,env={**env,**extra},stdout=log,stderr=log))
  for port in ports:
   for _ in range(200):
    with socket.socket() as probe:
     if probe.connect_ex(('127.0.0.1',port))==0:break
    assert all(child.poll() is None for child in children),'owned preview failed';time.sleep(.1)
   else:raise RuntimeError('owned preview port unavailable')
  print(json.dumps({'root':str(root),'web':ports[2],'reader':f'http://127.0.0.1:{ports[2]}/.hcd-pdf-layout-reader.html'}),flush=True)
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
