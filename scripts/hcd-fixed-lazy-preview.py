#!/usr/bin/env python3
"""Owned 130-page PPT/PDF workbench for lazy collaboration navigation.
Only synthetic local documents and identities; credentials stay in private.json.
"""
import argparse,json,os,runpy,secrets,shutil,signal,socket,subprocess,tempfile,time,zipfile
from pathlib import Path

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--runtime-dir',type=Path,default=Path('target/hcd-preview-runtime'));parser.add_argument('--index-delay-ms',type=int,default=4000);options=parser.parse_args();assert 0<=options.index_delay_ms<=10000
 repo=Path(__file__).resolve().parents[1];editor=repo/'examples/hdoc/editor';binary=repo/'target/debug/officecli';options.runtime_dir.mkdir(parents=True,exist_ok=True);root=Path(tempfile.mkdtemp(prefix='hcd-fixed-lazy-',dir=options.runtime_dir.resolve()));root.chmod(0o700);owner=secrets.token_hex(16)
 runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'))['fixtures'](root)
 with zipfile.ZipFile(root/'fixture.pptx') as source:parts={name:source.read(name) for name in source.namelist()}
 parts['ppt/presentation.xml']=parts['ppt/presentation.xml'].replace(b'</p:sldIdLst>',b''.join(f'<p:sldId id="{255+i}" r:id="rId{i}"/>'.encode() for i in range(2,131))+b'</p:sldIdLst>')
 parts['ppt/_rels/presentation.xml.rels']=parts['ppt/_rels/presentation.xml.rels'].replace(b'</Relationships>',b''.join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>'.encode() for i in range(2,131))+b'</Relationships>')
 first=parts['ppt/slides/slide1.xml'];rels=parts['ppt/slides/_rels/slide1.xml.rels']
 for i in range(1,131):
  parts[f'ppt/slides/slide{i}.xml']=first.replace(b'Original',f'Page {i:03d} collaboration'.encode())
  if i>1:parts[f'ppt/slides/_rels/slide{i}.xml.rels']=rels
 parts['[Content_Types].xml']=parts['[Content_Types].xml'].replace(b'</Types>',b''.join(f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'.encode() for i in range(2,131))+b'</Types>')
 with zipfile.ZipFile(root/'fixture.pptx','w',zipfile.ZIP_DEFLATED) as target:
  for name,data in parts.items():target.writestr(name,data)
 # Small real PDF pages keep the 130-page import bounded while crossing the
 # native 128-descriptor index boundary. One shared font, two editable runs.
 objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids ['+b' '.join(f'{4+2*i} 0 R'.encode() for i in range(130))+b'] /Count 130 >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
 for i in range(130):
  stream=f'BT /F1 11 Tf 20 230 Td (Page {i+1:03d} collaboration) Tj 0 -30 Td (Saved page content) Tj ET'.encode();objects.extend([f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 280] /Resources << /Font << /F1 3 0 R >> >> /Contents {5+2*i} 0 R >>'.encode(),b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream'])
 data=b'%PDF-1.7\n';offsets=[0]
 for number,obj in enumerate(objects,1):offsets.append(len(data));data+=f'{number} 0 obj\n'.encode()+obj+b'\nendobj\n'
 start=len(data);data+=f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()+b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:]);data+=f'trailer\n<< /Root 1 0 R /Size {len(offsets)} >>\nstartxref\n{start}\n%%EOF\n'.encode();(root/'fixture.pdf').write_bytes(data)
 env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
 for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
 def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=180).stdout)['data']
 ports=[]
 for _ in range(3):
  with socket.socket() as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
 config={'root':str(root),'origin':f'http://127.0.0.1:{ports[0]}','ports':ports,'previewPid':os.getpid(),'previewOwner':owner,'documents':{}};pages=[];(root/'sources').mkdir()
 for kind in ['pptx','pdf']:
  doc='fixed-lazy-'+kind;source=root/f'fixture.{kind}';manifest=cli('import',source,'--output',root/f'{doc}.hcd','--document-id',doc);assert manifest['chunkCount']==130 and manifest['indexPageCount']==2;shutil.copyfile(source,root/f'sources/{doc}.{kind}')
  tokens={role:cli('issue-token','--document-id',doc,'--scope','read' if role=='reader' else 'write','--user-id',actor,'--display-name',name,'--ttl-seconds',3600)['token'] for role,actor,name in [('writer','alice','Alice 王'),('peer','bob','Bob 李'),('reader','reader','Reader 访客')]};config['documents'][kind]={'documentId':doc,**tokens}
  for role,token in tokens.items():
   page=editor/f'.hcd-fixed-lazy-{kind}-{role}.html';assert not page.exists(),'owned preview page already exists';pages.append(page);props={'documentId':doc,'token':token,'apiUrl':'/v1/documents','collabUrl':f'ws://127.0.0.1:{ports[1]}','locale':'zh-CN'}
   page.write_text('<!-- hcd-preview:'+owner+' --><meta charset="utf-8"><style>html,body,#root{margin:0;height:100%}</style><div id="root"></div><script type="module">import React from"react";import{createRoot}from"react-dom/client";import{EmbeddedHcdEditor}from"/src/embed.tsx";createRoot(document.getElementById("root")).render(React.createElement(React.StrictMode,null,React.createElement(EmbeddedHcdEditor,'+json.dumps(props,ensure_ascii=False)+')));</script>');page.chmod(0o600)
 private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600);(options.runtime_dir/'current-fixed-lazy.json').write_text(json.dumps({'root':str(root),'web':ports[2]}))
 vite=root/'vite.mjs';vite.write_text('import{createServer}from'+json.dumps(str(editor/'node_modules/vite/dist/node/index.js'))+';import{appendFileSync}from"node:fs";const delayed=new Set();const s=await createServer({root:'+json.dumps(str(editor))+',configFile:false,plugins:[{name:"owned-request-evidence",configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url.startsWith("/v1/"))return next();let actor="unknown";try{actor=JSON.parse(Buffer.from((req.headers.authorization||" ").split(" ")[1].split(".")[1],"base64url")).sub}catch{}appendFileSync('+json.dumps(str(root/'requests.jsonl'))+',JSON.stringify({actor,url:req.url,method:req.method,time:Date.now()})+"\\n");const key=actor+req.url.split("?")[0];if(actor==="alice"&&req.url.includes("/index/1?")){delayed.add(key);setTimeout(next,'+str(options.index_delay_ms)+')}else next()})}}],server:{host:"127.0.0.1",port:'+str(ports[2])+',strictPort:true,proxy:{"/v1":{target:'+json.dumps(config['origin'])+',ws:true}}}});await s.listen();')
 children=[];logs=[];signal.signal(signal.SIGTERM,lambda *_:exit(0))
 try:
  for name,command,extra in [('api',[str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'],{}),('sidecar',['node','--import','tsx','sidecar.ts'],{'HCD_API_URL':config['origin'],'HCD_COLLAB_PORT':str(ports[1]),'HCD_SIDECAR_STATE_DIR':str(root/'sidecar-state')}),('web',['node',str(vite)],{})]:
   log=open(root/(name+'.log'),'ab');logs.append(log);children.append(subprocess.Popen(command,cwd=editor,env={**env,**extra},stdout=log,stderr=log))
  for port in ports:
   for _ in range(200):
    with socket.socket() as probe:
     if probe.connect_ex(('127.0.0.1',port))==0:break
    if any(child.poll() is not None for child in children):raise RuntimeError('owned fixture failed; inspect '+str(root))
    time.sleep(.1)
   else:raise RuntimeError('owned fixture port unavailable')
  print(json.dumps({'root':str(root),'web':ports[2],'writer':f'http://127.0.0.1:{ports[2]}/.hcd-fixed-lazy-pptx-writer.html'}),flush=True)
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
