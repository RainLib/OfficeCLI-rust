#!/usr/bin/env python3
"""Isolated, explicitly preconfigured regional identity; no user migration."""
import argparse,hashlib,json,os,secrets,socket,subprocess,tempfile,time,urllib.request,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

def main():
 repo=Path(__file__).resolve().parents[1];parser=argparse.ArgumentParser();parser.add_argument('--owners',action='store_true');parser.add_argument('--recovery',action='store_true');parser.add_argument('--preview',action='store_true');parser.add_argument('--rich-ui',action='store_true');parser.add_argument('--ai-fixture',action='store_true');parser.add_argument('--nodes-fixture',action='store_true');parser.add_argument('--evidence-dir',type=Path);parser.add_argument('--layout',action='store_true');parser.add_argument('--active-layout',action='store_true');args=parser.parse_args();assert not args.active_layout or args.layout, '--active-layout requires --layout';args.rich_ui=args.rich_ui or args.ai_fixture or args.nodes_fixture;args.preview=args.preview or args.rich_ui;args.recovery=args.recovery or args.preview;root=Path(tempfile.mkdtemp(prefix='word-room-',dir=repo/'target/hcd-preview-runtime'));assets=args.evidence_dir or repo/('docs/assets/hcd-word-recovery-2026-10-26' if args.recovery else 'docs/assets/hcd-word-owner-2026-10-26' if args.owners else 'docs/assets/hcd-word-room-2026-10-26');assets.mkdir(parents=True,exist_ok=True);binary=repo/'target/debug/officecli';env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':secrets.token_hex(32)}
 for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
 def cli(*args):
  result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],cwd=root,env=env,capture_output=True,text=True,check=True);return json.loads(result.stdout)['data']
 source=root/'source.docx'
 with zipfile.ZipFile(repo/'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx') as original,zipfile.ZipFile(source,'w') as out:
  for name in original.namelist():
   content=original.read(name)
   if name=='word/document.xml':content=content.decode().replace('<w:body>','<w:body><w:p><w:r><w:t>Regional room intro.</w:t></w:r></w:p>',1).encode()
   out.writestr(name,content)
 if args.rich_ui:
  (root/'people').mkdir();(root/'people/rich.json').write_text(json.dumps({'schemaVersion':'hcd-people/1','generation':1,'people':[{'id':'alice','label':'Alice 王','detail':'测试编辑者','active':True},{'id':'bob','label':'Bob 李','detail':'测试编辑者','active':True}]},ensure_ascii=False))
 if args.rich_ui or args.layout:
  import struct,zlib
  def png_part(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
  for name,data in [('replacement.png',b'\x00\xff\x00\x00\x00\x80\xff'),('recovery-original.png',b'\x00\x30\xc0\x60\x60\x20\xd0'),('interrupted-original.png',b'\x00\xf0\xa0\x10\x20\x90\x30')]:
   (root/name).write_bytes(b'\x89PNG\r\n\x1a\n'+png_part(b'IHDR',struct.pack('>IIBBBBB',2,1,8,2,0,0,0))+png_part(b'IDAT',zlib.compress(data))+png_part(b'IEND',b''))
 bundle=root/'rich.hcd';cli('import',source,'--word-regions','--document-id','rich','--output',bundle);cli('project-editor',bundle,'--word-regions','--expected-revision',0)
 # Explicit fixture setup BEFORE either server starts. This does not implement
 # a user-document migration or manufacture an old room's missing drafts.
 (root/'collaboration').mkdir();(root/'collaboration/rich.epoch').write_text(json.dumps({'epoch':1,'protocol':'hcd-word-regions/2' if args.layout else 'hcd-word-regions/1','nodeEdits':7}))
 ports=[]
 for _ in range(5 if args.owners else 4 if args.ai_fixture else 3 if args.preview else 2):
  with socket.socket() as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
 config={'root':str(root),'secret':env['HCD_TOKEN_SECRET'],'origin':f'http://127.0.0.1:{ports[0]}','apiUrl':f'http://127.0.0.1:{ports[0]}/v1/documents/rich','collabPort':ports[1]}
 if args.layout:
  assert not (args.preview or args.owners or args.recovery), '--layout currently targets the socket/API fixture'
  config.update(layout=True,activeLayout=args.active_layout,initialProjection=cli('editor-state',bundle))
 if args.preview:config.update(preview=True,vitePort=ports[2],richUi=args.rich_ui)
 if args.ai_fixture:config.update(aiFixture=True,aiPort=ports[3])
 if args.nodes_fixture:config.update(nodesFixture=True)
 if args.owners:config.update(secondOrigin=f'http://127.0.0.1:{ports[2]}',standbyPort=ports[3],wrongStorePort=ports[4])
 if args.active_layout:config['activeDisplayName']='Alice 王'
 for person,scope in [('alice','write'),('bob','write'),('reader','read'),('manager','manage'),('hcd-collaboration','write')]:config[person]=cli('issue-token','--document-id','rich','--scope',scope,'--user-id',person,'--display-name',config.get('activeDisplayName',person.title()) if person=='alice' else person.title(),'--ttl-seconds',3600)['token']
 private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600)
 log=open(root/'native.log','w');second_log=open(root/'native-second.log','w') if args.owners else None;second=None;native=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'],env=env,stdout=log,stderr=log)
 try:
  if args.owners:second=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[2]}'],env=env,stdout=second_log,stderr=second_log)
  deadline=time.monotonic()+30
  while True:
   assert native.poll() is None,'native exited'
   try:urllib.request.urlopen(urllib.request.Request(config['apiUrl']+'/auth',headers={'Authorization':'Bearer '+config['reader']}),timeout=1).close();break
   except OSError:assert time.monotonic()<deadline;time.sleep(.1)
  result=subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/('scripts/hcd-word-recovery.mts' if args.recovery else 'scripts/hcd-word-owner.mts' if args.owners else 'scripts/hcd-word-room.mts')),str(private)],cwd=repo,capture_output=True,text=True,timeout=240);(root/'worker.log').write_text(result.stdout+'\n'+result.stderr)
  if result.returncode:raise RuntimeError(result.stdout+'\n'+result.stderr)
  if args.preview:
   import shutil
   editor=root/'editor';shutil.copytree(repo/'examples/hdoc/editor',editor,ignore=shutil.ignore_patterns('node_modules','dist','dist-embed','.hcd-*'));(editor/'node_modules').symlink_to(repo/'examples/hdoc/editor/node_modules',target_is_directory=True)
   ai_proxy={'/hcd-test-ai':f'http://127.0.0.1:{ports[3]}'} if args.ai_fixture else {}
   preview_config=root/'preview.config.ts';preview_config.write_text('export default '+json.dumps({'root':str(editor),'server':{'host':'127.0.0.1','port':ports[2],'strictPort':True,'fs':{'allow':[str(repo)]},'proxy':{'/v1':config['origin'],'/health':config['origin'],**ai_proxy}}}))
   urls={}
   for person in (['alice','bob','reader'] if args.rich_ui else ['bob','reader']):
    session={'documentId':'rich','token':config[person],'format':'docx','scope':'read' if person=='reader' else 'write','apiUrl':'/v1/documents','collabUrl':f'ws://127.0.0.1:{ports[1]}','collaborationEpoch':1,'collaborationProtocol':'hcd-word-regions/1','flowLayoutVersion':2}
    page=editor/f'recovery-{person}.html'
    if args.rich_ui:
     props={'documentId':'rich','token':config[person],'apiUrl':'/v1/documents','collabUrl':f'ws://127.0.0.1:{ports[1]}','locale':'zh-CN'}
     page.write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>区域富文本编辑</title><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style><div id="root"></div><script type="module">import React from"react";import{createRoot}from"react-dom/client";import{EmbeddedHcdEditor}from"/src/embed.tsx";createRoot(document.getElementById("root")).render(React.createElement(EmbeddedHcdEditor,'+json.dumps(props)+'));</script></html>')
     if args.nodes_fixture and person!='reader':
      markup=page.read_text().replace('import React from','import{regionalExampleNodes}from"/src/examples/regionalNodes.ts";import React from').replace('React.createElement(EmbeddedHcdEditor,','React.createElement(EmbeddedHcdEditor,Object.assign(').replace('));</script>',', {nodeExtensions:{nodes:regionalExampleNodes}})));</script>')
      page.write_text(markup)
      if person=='bob':(editor/'recovery-no-codec.html').write_text(markup.replace('import{regionalExampleNodes}from"/src/examples/regionalNodes.ts";','').replace('nodeExtensions:{nodes:regionalExampleNodes}','nodeExtensions:{}'))
     if args.ai_fixture:
      markup=page.read_text().replace('import React from', 'import{createHttpAiProvider}from"/src/ai/http.ts";import React from').replace('React.createElement(EmbeddedHcdEditor,','React.createElement(EmbeddedHcdEditor,Object.assign(').replace('));</script>',', {aiExtensions:{provider:createHttpAiProvider({url:"/hcd-test-ai"}),autocomplete:{enabled:true,delayMs:600,cooldownMs:1200,minPrefix:3}}})));</script>')
      page.write_text(markup)
    else:
     page.write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>恢复内容审阅</title><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{I18nProvider}from"/src/i18n.tsx";import{WordRecoveryGate}from"/src/WordRecoveryGate.tsx";import"/src/style.css";createRoot(document.getElementById("root")).render(React.createElement(I18nProvider,{initialLocale:"zh-CN"},React.createElement(WordRecoveryGate,{session:'+json.dumps(session)+'},React.createElement("main",{style:{padding:32}},"恢复选择已记录。草稿仍通过区域协作房间保存。"))));</script></html>')
    urls[person]=f'http://127.0.0.1:{ports[2]}/{page.name}'
   if args.nodes_fixture:urls['noCodec']=f'http://127.0.0.1:{ports[2]}/recovery-no-codec.html'
   children=[];logs=[]
   try:
    for command,label in ([(['python3',str(repo/'scripts/hcd-ai-fixture-server.py'),'--port',str(ports[3]),'--root',str(root)],'ai-fixture')] if args.ai_fixture else [])+[(['node','--import','tsx','sidecar.ts'],'sidecar'),([str(editor/'node_modules/.bin/vite'),'--config',str(preview_config)],'vite')]:
     output=open(root/(label+'-preview.log'),'w');logs.append(output);children.append(subprocess.Popen(command,cwd=editor,env={**env,'HCD_WORD_ROOMS':'1','HCD_API_URL':config['origin'],'HCD_COLLAB_PORT':str(ports[1]),'HCD_SIDECAR_STATE_DIR':str(root/'shared-sidecar')},stdout=output,stderr=output))
    deadline=time.monotonic()+45
    while True:
     assert all(child.poll() is None for child in children),'preview exited'
     try:urllib.request.urlopen(urls['bob'],timeout=1).close();break
     except OSError:assert time.monotonic()<deadline;time.sleep(.1)
    print(json.dumps({'root':str(root),**urls},ensure_ascii=False),flush=True)
    while all(child.poll() is None for child in children):time.sleep(.5)
   finally:
    for child in children:child.terminate()
    for child in children:
     try:child.wait(timeout=6)
     except subprocess.TimeoutExpired:child.kill();child.wait()
    for output in logs:output.close()
   return
  evidence=json.loads((root/'socket-evidence.json').read_text());head=evidence['head'];states={n:cli('editor-state',bundle,'--revision',n) for n in range(1,head+1)}
  if evidence.get('retainedSessionOwnHistory'):
   import shutil
   own=evidence['ownHistoryMarkers']['own'];peer=evidence['ownHistoryMarkers']['peer']
   for kind,key in [('undo','ownHistoryUndoRevision'),('redo','ownHistoryRedoRevision')]:
    saved=root/f'own-{kind}.docx';cli('export',bundle,'--revision',evidence[key],'--output',saved)
    with zipfile.ZipFile(saved) as z:
     body_text=''.join(ET.fromstring(z.read('word/document.xml')).itertext())
     assert peer in body_text and (own in body_text)==(kind=='redo')
    shutil.copy2(saved,assets/saved.name)
   evidence['retainedHistoryDocxRevisionsVerified']=True
  output=root/'regional-room.docx';cli('export',bundle,'--revision',head,'--output',output)
  with zipfile.ZipFile(output) as z:
   texts={name:''.join(ET.fromstring(z.read(name)).itertext()) for name in z.namelist() if name=='word/document.xml' or name.startswith(('word/header','word/footer')) and name.endswith('.xml')}
   assert evidence['expected']['body'] in texts['word/document.xml'];assert not args.layout or 'Late after unknown response' in texts['word/document.xml'];assert any(evidence['expected']['header'] in text for name,text in texts.items() if name.startswith('word/header'));assert any(evidence['expected']['footer'] in text for name,text in texts.items() if name.startswith('word/footer'))
   assert not any('hcdWordRegionBoundary' in text for text in texts.values())
   if args.active_layout:
    page=ET.fromstring(z.read('word/document.xml')).find('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}sectPr/{http://schemas.openxmlformats.org/wordprocessingml/2006/main}pgSz')
    assert page is not None and int(page.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}w'))==evidence['activePageWidthTwips']
    evidence['activeDocxPageSizeVerified']=True
   with zipfile.ZipFile(source) as original:
    original_media={hashlib.sha256(original.read(name)).hexdigest() for name in original.namelist() if name.startswith('word/media/')};exported_media={hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if name.startswith('word/media/')}
    media_retained=original_media<=exported_media
    if args.layout:assert evidence['replacementAssetHash'] in exported_media
    else:assert media_retained
  archive=root/'regional-room.hcdz';cli('pack',bundle,'--output',archive);offline=root/'offline.hcd';cli('unpack',archive,'--output',offline)
  for n,state in states.items():assert cli('editor-state',offline,'--revision',n)==state
  assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid']
  import shutil
  for file in [output,archive]:shutil.copy2(file,assets/file.name)
  evidence.update(fixture=str(root),nativeBinarySha256=hashlib.sha256(binary.read_bytes()).hexdigest(),actualDocxPlacement=True,originalMediaRetained=media_retained,offlineAllVersionsExact=list(states),nativeAndOfflineValidate=True)
  (assets/'socket-api-files.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(json.dumps(evidence,ensure_ascii=False))
 finally:
  if second is not None:
   second.terminate()
   try:second.wait(timeout=5)
   except subprocess.TimeoutExpired:second.kill();second.wait()
  if second_log:second_log.close()
  native.terminate()
  try:native.wait(timeout=5)
  except subprocess.TimeoutExpired:native.kill();native.wait()
  log.close()
if __name__=='__main__':main()
