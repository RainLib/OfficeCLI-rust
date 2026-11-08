#!/usr/bin/env python3
"""Isolated command SDK workbench; no production documents or credentials.
Build officecli first. Prints the loopback web port; use .hcd-commands-{docx,pptx,pdf}-{writer,peer,reader}.html.
Use --slash for .hcd-slash-{format}-{role}.html and slash-specific fixture identities.
Stop with Ctrl+C after the manual browser/download checks in the editor README.
"""
import argparse,json,os,runpy,secrets,socket,subprocess,tempfile,time,zipfile
from xml.etree import ElementTree as ET
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--slash',action='store_true',help='use separate documents/pages for slash-menu verification');parser.add_argument('--follow',action='store_true',help='separate two-page fixed-layout follow fixtures');parser.add_argument('--activity',action='store_true',help='long-document collaboration location fixture');parser.add_argument('--revisions',action='store_true',help='separate revision-review fixtures');parser.add_argument('--restore',action='store_true',help='isolated coordinated restore fixtures');options=parser.parse_args();suite='follow' if options.follow else 'restore' if options.restore else 'revisions' if options.revisions else 'activity' if options.activity else 'slash' if options.slash else 'commands'
repo=Path(__file__).resolve().parents[1];editor=repo/'examples/hdoc/editor';binary=repo/'target/debug/officecli';root=Path(tempfile.mkdtemp(prefix=f'hcd-{suite}-browser-'))
runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'))['fixtures'](root)
if options.activity:
 source=root/'fixture.docx'
 with zipfile.ZipFile(source) as archive:parts={name:archive.read(name) for name in archive.namelist()}
 ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main';tree=ET.fromstring(parts['word/document.xml']);body=tree.find('{'+ns+'}body');section=body.find('{'+ns+'}sectPr')
 for index in range(60):
  paragraph=ET.Element('{'+ns+'}p');run=ET.SubElement(paragraph,'{'+ns+'}r');ET.SubElement(run,'{'+ns+'}t').text=f'位置验证 {index+1:02d} — Collaborative view location. '+('Long document paragraph. '*4)
  body.insert(len(body)-1 if section is not None else len(body),paragraph)
 parts['word/document.xml']=ET.tostring(tree,encoding='utf-8',xml_declaration=True)
 with zipfile.ZipFile(source,'w') as archive:
  for name,data in parts.items():archive.writestr(name,data)
if options.follow:
 # Two pages and a tall PDF exercise remote page changes and scroll ratios.
 source=root/'fixture.pptx'
 with zipfile.ZipFile(source) as archive:parts={name:archive.read(name) for name in archive.namelist()}
 parts['ppt/presentation.xml']=parts['ppt/presentation.xml'].replace(b'</p:sldIdLst>',b'<p:sldId id="257" r:id="rId2"/></p:sldIdLst>')
 parts['ppt/_rels/presentation.xml.rels']=parts['ppt/_rels/presentation.xml.rels'].replace(b'</Relationships>',b'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>')
 parts['ppt/slides/slide2.xml']=parts['ppt/slides/slide1.xml'].replace(b'Original',b'Second page')
 parts['ppt/slides/_rels/slide2.xml.rels']=parts['ppt/slides/_rels/slide1.xml.rels']
 with zipfile.ZipFile(source,'w') as archive:
  for name,data in parts.items():archive.writestr(name,data)
 source=root/'fixture.pdf';raw=source.read_bytes();objects=[]
 import re
 for match in re.finditer(rb'(?m)^\d+ 0 obj\n(.*?)\nendobj',raw,re.S):objects.append(match.group(1))
 objects[1]=objects[1].replace(b'/Kids [3 0 R] /Count 1',b'/Kids [3 0 R 7 0 R] /Count 2')
 objects[2]=objects[2].replace(b'/MediaBox [0 0 200 200]',b'/MediaBox [0 0 200 1200]')
 objects.append(objects[2]);data=b'%PDF-1.7\n';offsets=[0]
 for number,obj in enumerate(objects,1):offsets.append(len(data));data+=f'{number} 0 obj\n'.encode()+obj+b'\nendobj\n'
 start=len(data);data+=f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()+b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:]);data+=f'trailer\n<< /Root 1 0 R /Size {len(offsets)} >>\nstartxref\n{start}\n%%EOF\n'.encode();source.write_bytes(data)
env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True).stdout)['data']
ports=[]
for _ in range(3):
 with socket.socket() as s:s.bind(('127.0.0.1',0));ports.append(s.getsockname()[1])
config={'root':str(root),'api':ports[0],'collab':ports[1],'web':ports[2],'documents':{}}
(root/'sources').mkdir()
for kind in ['docx','pptx','pdf']:
 doc=suite+'-'+kind;source=root/f'fixture.{kind}';cli('import',source,'--output',root/f'{doc}.hcd','--document-id',doc);(root/f'sources/{doc}.{kind}').write_bytes(source.read_bytes())
 if kind=='docx':cli('project-editor',root/f'{doc}.hcd','--expected-revision',0)
 tokens={name:cli('issue-token','--document-id',doc,'--scope',scope,'--user-id',user,'--display-name',{'alice':'Alice','bob':'Bob','reader':'Reader','owner':'Owner'}[user],'--ttl-seconds',3600)['token'] for name,scope,user in [('writer','write','alice'),('manager','manage','owner'),('peer','write','bob'),('reader','read','reader')]}
 config['documents'][kind]={'documentId':doc,**tokens}
 session={'documentId':doc,'format':kind,'token':tokens['writer'],'scope':'write','userId':'alice','displayName':'Alice','collaborationEpoch':0,'collabUrl':f'ws://127.0.0.1:{ports[1]}'}
 page=editor/f'.hcd-commands-{kind}.html'
 for role in ['writer','peer','reader']:
  props={'documentId':doc,'token':tokens[role],'apiUrl':'/v1/documents','collabUrl':f'ws://127.0.0.1:{ports[1]}','locale':'zh-CN'}
  content='''<meta charset="utf-8"><style>html,body,#root{margin:0;height:100%;}#proof{position:fixed;bottom:8px;left:8px;z-index:20000;background:#fff;color:#222;border:1px solid #ccc;padding:5px;font:12px sans-serif}</style><div id="root"></div><script type="module">import React from'react';import{createRoot}from'react-dom/client';import{EmbeddedHcdEditor}from'/src/embed.tsx';function Harness(){const[message,setMessage]=React.useState('ready'),service=React.useRef(null);const extensions=React.useMemo(()=>({commands:[{id:'business.insert',label:{'zh-CN':'插入审批标记','en-US':'Approval token'},icon:'✓',surfaces:['ribbon','context','bubble','palette','slash'],shortcuts:['Mod+Alt+J'],execute:({commands})=>commands.run('text.insert',{text:'<b>审批标记</b>'})},{id:'business.late',label:'延迟插入测试',surfaces:['ribbon','palette','slash'],execute:async({commands})=>{await new Promise(resolve=>setTimeout(resolve,2500));return commands.run('text.insert',{text:'延迟内容'})}},{id:'business.fail',label:'失败不删除',surfaces:['slash'],execute:async({commands})=>{await commands.run('text.insert',{text:'不应出现'});throw new Error('host failure')}}],onReady:commands=>{service.current=commands;setMessage(JSON.stringify(commands.capabilities()))},onError:error=>setMessage(error.code??error.message)}),[]);return React.createElement(React.Fragment,null,React.createElement(EmbeddedHcdEditor,{...PROPS,commandExtensions:extensions}),React.createElement('div',{id:'proof'},React.createElement('output',{role:'status','aria-label':'宿主执行结果'},message),React.createElement('button',{'aria-label':'直接执行审批命令',onClick:()=>service.current?.execute('business.insert').catch(error=>setMessage(error.code??error.message))},'直接执行审批命令')))}createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Harness)));</script>'''.replace('PROPS',json.dumps(props))
  page=editor/f'.hcd-{suite}-{kind}-{role}.html';page.write_text(content);page.chmod(0o600)
private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600);Path(f'/tmp/hcd-{suite}-browser-location').write_text(str(root))
vite=root/'vite.mjs';vite.write_text('import{createServer}from'+json.dumps(str(editor/'node_modules/vite/dist/node/index.js'))+';const s=await createServer({root:'+json.dumps(str(editor))+',configFile:false,server:{host:"127.0.0.1",port:'+str(ports[2])+',strictPort:true,proxy:{"/v1":{target:"http://127.0.0.1:'+str(ports[0])+'",ws:true}}}});await s.listen();')
processes=[];logs=[]
try:
 for name,cmd,extra in [('api',[str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'],{}),('sidecar',['node','--import','tsx','sidecar.ts'],{'HCD_API_URL':f'http://127.0.0.1:{ports[0]}','HCD_COLLAB_PORT':str(ports[1]),'HCD_SIDECAR_STATE_DIR':str(root/'sidecar-state')}),('web',['node',str(vite)],{})]:
  log=open(root/f'{name}.log','wb');logs.append(log);processes.append(subprocess.Popen(cmd,cwd=editor,env={**env,**extra},stdout=log,stderr=log))
 print(json.dumps({'root':str(root),'webPort':ports[2]}),flush=True)
 while all(p.poll() is None for p in processes):time.sleep(1)
except KeyboardInterrupt:
 pass
finally:
 for p in processes:p.terminate()
 for p in processes:
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.kill()
 for l in logs:l.close()
 for kind in ['docx','pptx','pdf']:
  for role in ['writer','peer','reader']:
   (editor/f'.hcd-{suite}-{kind}-{role}.html').unlink(missing_ok=True)
