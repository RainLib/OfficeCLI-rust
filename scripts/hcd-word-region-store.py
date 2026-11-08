#!/usr/bin/env python3
"""Owned real-native regional rich-text checkpoint and portable-file verification."""
import argparse,hashlib,json,os,secrets,socket,subprocess,tempfile,time,urllib.request,zipfile,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import xml.etree.ElementTree as ET


def main():
 repo=Path(__file__).resolve().parents[1];parser=argparse.ArgumentParser();parser.add_argument('--coordinator',action='store_true');parser.add_argument('--images',action='store_true');parser.add_argument('--uploads',action='store_true');args=parser.parse_args()
 if args.images and not args.coordinator:parser.error('--images requires --coordinator')
 if args.uploads and not args.images:parser.error('--uploads requires --images --coordinator')
 root=Path(tempfile.mkdtemp(prefix='word-rich-regions-',dir=repo/'target/hcd-preview-runtime'));assets=repo/('docs/assets/hcd-word-upload-lifecycle-2026-10-26' if args.uploads else 'docs/assets/hcd-word-regional-images-2026-10-26' if args.images else 'docs/assets/hcd-word-save-coordinator-2026-10-26' if args.coordinator else 'docs/assets/hcd-word-region-store-2026-10-26');assets.mkdir(exist_ok=True);binary=repo/'target/debug/officecli';env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':secrets.token_hex(32)}
 for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
 def cli(*args):
  result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],cwd=root,env=env,capture_output=True,text=True,check=True);return json.loads(result.stdout)['data']
 source=root/'source.docx'
 with zipfile.ZipFile(repo/'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx') as z,zipfile.ZipFile(source,'w') as out:
  for name in z.namelist():
   content=z.read(name)
   if name=='word/document.xml':content=content.decode().replace('<w:body>','<w:body><w:p><w:r><w:t>Intro paragraph for regional rich editing.</w:t></w:r></w:p>',1).encode()
   if name=='word/header1.xml':content=content.decode().replace('</w:hdr>','<w:p><w:r><w:t>Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>7</w:t></w:r></w:fldSimple></w:p></w:hdr>').encode()
   out.writestr(name,content)
 bundle=root/'rich.hcd';cli('import',source,'--word-regions','--document-id','rich','--output',bundle);cli('project-editor',bundle,'--word-regions','--expected-revision',0)
 with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
 config={'root':str(root),'secret':env['HCD_TOKEN_SECRET'],'apiUrl':f'http://127.0.0.1:{port}/v1/documents/rich','service':cli('issue-token','--document-id','rich','--scope','write','--user-id','hcd-collaboration','--ttl-seconds',3600)['token'],'reader':cli('issue-token','--document-id','rich','--scope','read','--user-id','reader','--ttl-seconds',3600)['token']}
 if args.coordinator:
  config['alice']=cli('issue-token','--document-id','rich','--scope','write','--user-id','alice','--display-name','Alice 王','--ttl-seconds',3600)['token'];config['bob']=cli('issue-token','--document-id','rich','--scope','write','--user-id','bob','--display-name','Bob 李','--ttl-seconds',3600)['token']
  (root/'people').mkdir();(root/'people/rich.json').write_text(json.dumps({'schemaVersion':'hcd-people/1','generation':1,'people':[{'id':'alice','label':'Alice 王','active':True,'visibleTo':['bob'],'mentionableBy':['bob']},{'id':'bob','label':'Bob 李','active':True,'visibleTo':['alice'],'mentionableBy':['alice']}]}))
 if args.images:
  import struct,zlib
  def png_chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
  replacement=b'\x89PNG\r\n\x1a\n'+png_chunk(b'IHDR',struct.pack('>IIBBBBB',2,1,8,2,0,0,0))+png_chunk(b'IDAT',zlib.compress(b'\x00\xff\x00\x00\x00\x80\xff'))+png_chunk(b'IEND',b'')
  (root/'replacement.png').write_bytes(replacement);config['images']=True;config['uploads']=args.uploads
 private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600)
 log=open(root/'native.log','w');process=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{port}'],env=env,stdout=log,stderr=log)
 try:
  deadline=time.monotonic()+30
  while True:
   assert process.poll() is None,'native process exited'
   try:urllib.request.urlopen(urllib.request.Request(config['apiUrl']+'/auth',headers={'Authorization':'Bearer '+config['reader']}),timeout=1).close();break
   except OSError:assert time.monotonic()<deadline,'native API not ready';time.sleep(.1)
  uploaded=threading.Event();release_upload=threading.Event()
  class DropResponse(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_GET(self):
    assert self.path=='/upload-state';body=json.dumps({'committed':uploaded.is_set()}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
   def do_POST(self):
    if self.path=='/release-upload':release_upload.set();self.send_response(200);self.send_header('Content-Length','0');self.end_headers();return
    length=int(self.headers.get('Content-Length','0'));assert 0<length<=8*1024*1024
    body=self.rfile.read(length);headers={key:value for key,value in self.headers.items() if key.lower() not in ['host','connection','content-length']}
    route='/staged-assets?extension=png' if self.path=='/upload-drop' else '/word/checkpoints'
    with urllib.request.urlopen(urllib.request.Request(config['apiUrl']+route,headers=headers,data=body),timeout=60) as upstream:upstream.read();assert upstream.status==200
    if self.path=='/upload-drop':uploaded.set();assert release_upload.wait(60),'upload release timed out'
    self.connection.shutdown(socket.SHUT_RDWR);self.connection.close()
  proxy=ThreadingHTTPServer(('127.0.0.1',0),DropResponse);thread=threading.Thread(target=proxy.serve_forever,daemon=True);thread.start()
  try:
   config['dropUrl']=f'http://127.0.0.1:{proxy.server_port}/drop';config['uploadProxy']=f'http://127.0.0.1:{proxy.server_port}';private.write_text(json.dumps(config))
   for phase in (['upload-prepare','upload-resume','prepare','resume'] if args.uploads else ['prepare','resume']):
    script='scripts/hcd-word-upload-lifecycle.mts' if phase.startswith('upload-') else 'scripts/hcd-word-save-coordinator.mts' if args.coordinator else 'scripts/hcd-word-region-store.mts'
    result=subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/script),str(private),phase],cwd=repo,capture_output=True,text=True,timeout=120)
    (root/(phase+'-test.log')).write_text(result.stdout+'\n'+result.stderr)
    if result.returncode:raise RuntimeError(result.stdout+'\n'+result.stderr)
    if phase=='upload-prepare':cli('gc',bundle,'--delete');config['gcAfterUpload']=True;private.write_text(json.dumps(config))
  finally:release_upload.set();proxy.shutdown();proxy.server_close();thread.join(timeout=5)
  evidence=json.loads((root/'model-api-evidence.json').read_text());states={n:cli('editor-state',bundle,'--revision',n) for n in [1,2,3]}
  if args.uploads:evidence['uploadRecovery']=json.loads((root/'upload-recovery.json').read_text())
  output=root/'regional-r3.docx';cli('export',bundle,'--revision',3,'--output',output)
  with zipfile.ZipFile(output) as z:
   parts={name:''.join(ET.fromstring(z.read(name)).itertext()) for name in z.namelist() if name=='word/document.xml' or name.startswith(('word/header','word/footer')) and name.endswith('.xml')}
   assert evidence['expected']['body'] in parts['word/document.xml'] and evidence['expected']['header'] not in parts['word/document.xml']
   if evidence['expected'].get('mention'):assert evidence['expected']['mention'] in parts['word/document.xml']
   assert any(evidence['expected']['header'] in text for name,text in parts.items() if name.startswith('word/header'))
   assert any(evidence['expected']['footer'] in text for name,text in parts.items() if name.startswith('word/footer'))
   assert any('Page ' in text and '7' in text for name,text in parts.items() if name.startswith('word/header'))
   assert not any('hcdWordRegionBoundary' in text for text in parts.values())
   assert any(node.attrib.get('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val')=='Heading2' for node in ET.fromstring(z.read('word/document.xml')).iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}pStyle'))
   assert any(name.startswith('word/media/') for name in z.namelist())
   if args.images:
    import posixpath
    image=evidence['regionalImage'];assert image['replacementHash']==hashlib.sha256((root/'replacement.png').read_bytes()).hexdigest()
    header=ET.fromstring(z.read('word/header1.xml'));rels=ET.fromstring(z.read('word/_rels/header1.xml.rels'));targets={rel.attrib['Id']:posixpath.normpath(posixpath.join('word',rel.attrib['Target'])) for rel in rels}
    embeds=[node.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed'] for node in header.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}blip')]
    assert any(hashlib.sha256(z.read(targets[embed])).hexdigest()==image['replacementHash'] for embed in embeds)
    assert any(int(node.attrib['cx'])==image['finalGeometry']['width'] and int(node.attrib['cy'])==image['finalGeometry']['height'] for node in header.iter('{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent'))
   else:
    with zipfile.ZipFile(source) as original:assert {hashlib.sha256(original.read(name)).hexdigest() for name in original.namelist() if name.startswith('word/media/')}<={hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if name.startswith('word/media/')}
  archive=root/'regional-history.hcdz';cli('pack',bundle,'--output',archive);offline=root/'offline.hcd';cli('unpack',archive,'--output',offline)
  for n in [1,2,3]:assert cli('editor-state',offline,'--revision',n)==states[n]
  assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid']
  import shutil
  for file in [output,archive]:shutil.copy2(file,assets/file.name)
  evidence.update(actualDocxStoryPlacement=True,opaquePageCacheAndImageRetained=True,**({'docxReplacementBytesAndGeometryVerified':True} if args.images else {'originalMediaBytesRetained':True}),nativeAndOfflineValidate=True,offlineRevisionsExact=[1,2,3],nativeBinarySha256=hashlib.sha256(binary.read_bytes()).hexdigest(),fixture=str(root))
  (assets/'model-api-and-files.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(json.dumps(evidence,ensure_ascii=False))
 finally:
  process.terminate()
  try:process.wait(timeout=5)
  except subprocess.TimeoutExpired:process.kill();process.wait()
  log.close()

if __name__=='__main__':main()
