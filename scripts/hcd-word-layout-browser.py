#!/usr/bin/env python3
"""Serve synthetic layout-aware Word UI with a signed recoverable draft."""
import argparse,hashlib,json,os,secrets,shutil,socket,subprocess,tempfile,time,urllib.request
from pathlib import Path

parser=argparse.ArgumentParser();parser.add_argument('--clean',action='store_true');parser.add_argument('--book-source',action='store_true',help='Use an explicitly generated next-page/continued-numbering source for book UI tests');parser.add_argument('--draft-only',action='store_true',help='Keep a shared signed draft without a competing archived recovery copy');parser.add_argument('--stopped',action='store_true',help='Keep layout rooms disabled to exercise the normal compatibility recovery entry');parser.add_argument('--allow-restart',action='store_true');parser.add_argument('--story-source',action='store_true');parser.add_argument('--numeric-fields',action='store_true',help='Use a synthetic source with preserved and static Word field cases');parser.add_argument('--link-source',action='store_true');parser.add_argument('--allow-native-restart',action='store_true');parser.add_argument('--drop-native-link-response',action='store_true');parser.add_argument('--native-topology-proxy',action='store_true',help='Enable owned native layout/story transaction fault controls');parser.add_argument('--link-ui-proxy','--topology-ui-proxy',dest='link_ui_proxy',action='store_true');args=parser.parse_args()
if args.book_source and (not args.story_source or args.link_source or args.numeric_fields):parser.error('--book-source requires --story-source and cannot combine with other source variants')
if args.link_source and not args.story_source:parser.error('--link-source requires --story-source')
if args.numeric_fields and (not args.story_source or args.link_source):parser.error('--numeric-fields requires --story-source and cannot combine with --link-source')
native_proxy=args.drop_native_link_response or args.native_topology_proxy
repo=Path(__file__).resolve().parents[1]
root=Path(tempfile.mkdtemp(prefix='word-layout-ui-',dir=repo/'target/hcd-preview-runtime'))
binary=repo/'target/debug/officecli';env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':secrets.token_hex(32)}
for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,cwd=root,capture_output=True,text=True,check=True,timeout=90).stdout)['data']
bundle=root/'region-test.hcd'
if args.story_source:
 source=repo/'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx'
 if args.book_source:
  import zipfile
  original=source;source=root/'book-source.docx'
  with zipfile.ZipFile(original) as incoming,zipfile.ZipFile(source,'w') as outgoing:
   for entry in incoming.infolist():
    content=incoming.read(entry)
    if entry.filename=='word/document.xml':
     xml=content.decode().replace('w:top="-120"','w:top="1440"').replace('<w:cols w:num="2"/>','').replace('<w:type w:val="continuous"/>','<w:type w:val="nextPage"/>').replace('<w:pgNumType w:start="4" w:fmt="decimal"/>','<w:pgNumType w:fmt="decimal"/>')
     xml=xml.replace('<w:sectPrChange w:id="1"><w:sectPr><w:pgSz w:w="1" w:h="1"/></w:sectPr></w:sectPrChange>','')
     content=xml.encode()
    outgoing.writestr(entry,content)
 if args.numeric_fields:
  import zipfile
  original=source;source=root/'numeric-fields.docx'
  fields=r'''<w:p><w:r><w:t>Page </w:t></w:r><w:fldSimple w:instr=" PAGE \* ROMAN "><w:r><w:rPr><w:b/></w:rPr><w:t>VIII</w:t></w:r></w:fldSimple></w:p><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>12</w:t></w:r></w:p><w:p><w:r><w:t> total pages</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:fldSimple w:instr="SECTIONPAGES"><w:r><w:t>3</w:t></w:r></w:fldSimple></w:p></w:tc></w:tr></w:tbl><w:p><w:fldSimple w:instr="DATE"><w:r><w:t>Saved field date</w:t></w:r></w:fldSimple><w:fldSimple w:instr="PAGE"/><w:fldSimple w:instr="PAGE \* CHARFORMAT"><w:r><w:t>Saved char format</w:t></w:r></w:fldSimple></w:p>'''
  with zipfile.ZipFile(original) as incoming,zipfile.ZipFile(source,'w') as outgoing:
   for entry in incoming.infolist():
    content=incoming.read(entry)
    if entry.filename=='word/header1.xml':
     xml=content.decode();assert xml.count('</w:hdr>')==1;content=xml.replace('</w:hdr>',fields+'</w:hdr>').encode()
    outgoing.writestr(entry,content)
 if args.link_source:
  import zipfile
  original=source;source=root/'link-source.docx'
  with zipfile.ZipFile(original) as incoming,zipfile.ZipFile(source,'w') as outgoing:
   for entry in incoming.infolist():
    content=incoming.read(entry)
    if entry.filename=='word/document.xml':
     xml=content.decode();even='<w:headerReference w:type="even" r:id="he"/>';default='<w:headerReference w:type="default" r:id="hd"/>';assert xml.count(even)==1 and xml.count(default)==1
     content=xml.replace(even,'<w:headerReference w:type="even" r:id="hd"/>',1).replace(default,default+even,1).encode()
    outgoing.writestr(entry,content)
 cli('import',source,'--word-regions','--document-id','region-test','--output',bundle);cli('project-editor',bundle,'--word-regions','--expected-revision',0)
 (root/'sources').mkdir();shutil.copyfile(source,root/'sources/region-test.docx')
else:cli('unpack',repo/'docs/assets/hcd-word-layout-receipt-2026-10-27/layout-r7.hcdz','--output',bundle)
projection=cli('editor-state',bundle);assert projection['documentId']=='region-test'
(root/'collaboration').mkdir();(root/'collaboration/region-test.epoch').write_text(json.dumps({'epoch':1,'protocol':'hcd-word-regions/2','nodeEdits':7}))
ports=[]
for _ in range(3+int(native_proxy)+int(args.link_ui_proxy)):
 with socket.socket() as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
c={'root':str(root),'documentId':'region-test','origin':f'http://127.0.0.1:{ports[0]}','collabPort':ports[1],'vitePort':ports[2],'secret':env['HCD_TOKEN_SECRET'],'initialProjection':projection,'clean':args.clean,'draftOnly':args.draft_only,'allowRestart':args.allow_restart,'linkSource':args.link_source,'allowNativeRestart':args.allow_native_restart,'dropNativeLinkResponse':args.drop_native_link_response,'nativeTopologyProxy':args.native_topology_proxy,'numericFields':args.numeric_fields,'bookSource':args.book_source,'linkUiProxy':args.link_ui_proxy}
for person,scope,sub in [('alice','write','alice'),('bob','write','bob'),('reader','read','reader'),('service','write','hcd-collaboration')]:c[person]=cli('issue-token','--document-id','region-test','--scope',scope,'--user-id',sub,'--display-name',{'alice':'Alice 王','bob':'Bob 李'}.get(person,person),'--ttl-seconds',3600)['token']
private=root/'private.json';private.write_text(json.dumps(c));private.chmod(0o600)
if args.link_ui_proxy:
 c['browserCollabPort']=ports[-1]
 private.write_text(json.dumps(c));private.chmod(0o600)
children=[];logs=[]
def start(command,label,cwd=repo,extra=None):
 log=open(root/(label+'.log'),'w');logs.append(log);child=subprocess.Popen(command,cwd=cwd,env={**env,**(extra or {})},stdout=log,stderr=log);children.append(child);return child
def wait(url,headers=None):
 deadline=time.monotonic()+45
 while True:
  assert all(p.poll() is None for p in children),'fixture service exited'
  try:urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=1).close();return
  except OSError:assert time.monotonic()<deadline;time.sleep(.1)
try:
 if args.link_ui_proxy:start(['node',str(repo/'scripts/hcd-word-link-ui-proxy.mjs'),str(root),str(c['browserCollabPort']),str(c['collabPort'])],'link-ui-proxy')
 native_port=ports[3] if native_proxy else ports[0]
 if native_proxy:start(['node',str(repo/'scripts/hcd-word-link-native-proxy.mjs'),str(root),str(ports[0]),str(native_port)],'native-proxy')
 native=start([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{native_port}'],'native')
 wait(c['origin']+'/v1/documents/region-test/auth',{'Authorization':'Bearer '+c['reader']})
 setup=subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-word-layout-browser-setup.mts'),str(private)],cwd=repo,capture_output=True,text=True,timeout=90)
 (root/'setup.log').write_text(setup.stdout+'\n'+setup.stderr)
 if setup.returncode:raise RuntimeError('layout setup failed; inspect owned setup.log')
 editor=root/'editor';editor.mkdir();(editor/'node_modules').symlink_to(repo/'examples/hdoc/editor/node_modules',target_is_directory=True);(editor/'src').symlink_to(repo/'examples/hdoc/editor/src',target_is_directory=True);(editor/'tsconfig.json').symlink_to(repo/'examples/hdoc/editor/tsconfig.json')
 pages={}
 for person in ['alice','bob','reader']:
  props={'documentId':'region-test','token':c[person],'apiUrl':'/v1/documents','collabUrl':f"ws://127.0.0.1:{c.get('browserCollabPort',ports[1])}",'locale':'zh-CN'}
  page=editor/f'layout-{person}.html';page.write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Word 布局协作验证</title><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{EmbeddedHcdEditor}from"/src/embed.tsx";createRoot(document.getElementById("root")).render(React.createElement(EmbeddedHcdEditor,'+json.dumps(props)+'));</script></html>');pages[person]=f'http://127.0.0.1:{ports[2]}/{page.name}'
 c.update(pages=pages,nativeBinarySha256=hashlib.sha256(binary.read_bytes()).hexdigest());private.write_text(json.dumps(c));private.chmod(0o600)
 config=root/'vite.config.ts';config.write_text('export default '+json.dumps({'root':str(editor),'server':{'host':'127.0.0.1','port':ports[2],'strictPort':True,'fs':{'allow':[str(repo)]},'proxy':{'/v1':c['origin']}}}))
 sidecar_env={'HCD_API_URL':c['origin'],'HCD_COLLAB_PORT':str(ports[1]),'HCD_SIDECAR_STATE_DIR':str(root/'sidecar'),'HCD_WORD_ROOMS':'1','HCD_WORD_LAYOUT_ROOMS':'0' if args.stopped else '1'}
 sidecar=start(['node','--import','tsx','sidecar.ts'],'sidecar',repo/'examples/hdoc/editor',sidecar_env)
 start([str(editor/'node_modules/.bin/vite'),'--config',str(config)],'vite',editor)
 wait(pages['alice']);print(json.dumps({'root':str(root),**pages}),flush=True)
 restarts=0;native_restarts=0
 while all(p.poll() is None for p in children):
  native_flag=root/'restart-native'
  if args.allow_native_restart and native_flag.is_file():
   assert not native_flag.is_symlink() and native_flag.read_text()=='restart';native_flag.unlink();native.terminate()
   try:native.wait(timeout=10)
   except subprocess.TimeoutExpired:
    assert native.poll() is None;native.kill();native.wait(timeout=5)
   children.remove(native);native_restarts+=1
   native=start([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{native_port}'],f'native-restart-{native_restarts}')
   wait(c['origin']+'/v1/documents/region-test/auth',{'Authorization':'Bearer '+c['reader']});(root/'native-restarted.json').write_text(json.dumps({'generation':native_restarts}))
  flag=root/'restart-sidecar'
  if args.allow_restart and flag.is_file():
   assert not flag.is_symlink() and flag.read_text()=='restart';flag.unlink();sidecar.terminate()
   try:sidecar.wait(timeout=10)
   except subprocess.TimeoutExpired:
    assert sidecar.poll() is None;sidecar.kill();sidecar.wait(timeout=5)
   children.remove(sidecar);restarts+=1
   sidecar=start(['node','--import','tsx','sidecar.ts'],f'sidecar-restart-{restarts}',repo/'examples/hdoc/editor',sidecar_env);wait(f'http://127.0.0.1:{ports[1]}');(root/'sidecar-restarted.json').write_text(json.dumps({'generation':restarts}))
  time.sleep(.2)
finally:
 for child in reversed(children):child.terminate()
 for child in children:
  try:child.wait(timeout=6)
  except subprocess.TimeoutExpired:child.kill();child.wait()
 for log in logs:log.close()
