#!/usr/bin/env python3
"""Own offline bundles, new native HTTP, actual CLI artifacts and no service state.
No private token/config is copied into the reviewable evidence directory.
"""
import argparse,base64,hashlib,json,os,random,shutil,socket,struct,subprocess,tempfile,time,urllib.request,zlib,runpy
from pathlib import Path
from html.parser import HTMLParser
class Page(HTMLParser):
 def __init__(self):super().__init__();self.text=[];self.images=[];self.nodes=[];self.skip=0
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if tag in ['style','script']:self.skip+=1
  if tag=='img':self.images.append(a.get('src',''))
  if 'data-hcd-extension' in a:self.nodes.append(json.loads(a['data-hcd-extension']))
 def handle_endtag(self,tag):
  if tag in ['style','script']:self.skip-=1
 def handle_data(self,data):
  if not self.skip:self.text.append(data)
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--preview',action='store_true');args=parser.parse_args();repo=Path(__file__).resolve().parents[1];binary=repo/'target/debug/officecli';root=Path(tempfile.mkdtemp(prefix='hcd-html-export-',dir=repo/'target/hcd-preview-runtime'));site=root/'site';site.mkdir();assets=repo/'docs/assets/hcd-html-export-2026-10-27';assets.mkdir(exist_ok=True);env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':os.urandom(32).hex()}
 for name in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(name,None)
 def cli(*args,ok=True):
  result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,cwd=root,capture_output=True,text=True);value=json.loads(result.stdout)
  if ok and result.returncode:raise RuntimeError(value)
  return value.get('data',value)
 source=repo/'docs/assets/hcd-semantic-node-resource-recovery-2026-10-27/browser-semantic-resource-r6.hcdz';bundle=root/'mentions-docx.hcd';cli('unpack',source,'--output',bundle)
 states={n:cli('editor-state',bundle,'--revision',n) for n in range(7)}
 def extensions(state):
  out=[]
  def walk(value):
   if isinstance(value,dict):
    if isinstance(value.get('extension'),dict):out.append(value['extension'])
    for child in value.values():walk(child)
   elif isinstance(value,list):
    for child in value:walk(child)
  walk(state['blocks']);return out
 exports={}
 for n in [2,3,4,5,6]:
  output=site/f'offline-r{n}.html';report=cli('export',bundle,'--revision',n,'--output',output,'--to','html','--fidelity-report',root/f'fidelity-r{n}.json');page=Page();page.feed(output.read_text());assert page.nodes==extensions(states[n]);label='导出资料：'+('项目资料' if n==2 else '同伴更新资料');assert ''.join(page.text).count(label)==1
  assert page.images and all(uri.startswith('data:image/') for uri in page.images);expected={entry['hash'] for entry in page.nodes[0].get('resources',[])};actual={hashlib.sha256(base64.b64decode(uri.split(',',1)[1])).hexdigest() for uri in page.images};assert expected<=actual
  exports[str(n)]={'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'inertPayloadExactlyPreserved':True,'allImagesEmbedded':True,'imageOccurrences':len(page.images),'report':report}
 # A real large PNG whose base64 expansion exceeds the old 8 MiB per-chunk
 # preview limit. Its bytes remain below the supported node-file size limit.
 def part(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
 width,height=2048,1024;raw=random.Random(42).randbytes(width*height*3);scan=b''.join(b'\0'+raw[y*width*3:(y+1)*width*3] for y in range(height));png=b'\x89PNG\r\n\x1a\n'+part(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+part(b'IDAT',zlib.compress(scan))+part(b'IEND',b'');assert len(png)<8*1024*1024 and len(base64.b64encode(png))>8*1024*1024
 sources=root/'large-source';sources.mkdir();runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'))['fixtures'](sources);large_source=sources/'fixture.docx';large=root/'large.hcd';cli('import',large_source,'--output',large,'--document-id','large')
 image=cli('list-images',large)['entries'][0];png_file=root/'large.png';png_file.write_bytes(png);staged=cli('put-asset',large,png_file);patch=root/'large-image-patch.json';patch.write_text(json.dumps({'schemaVersion':'hcd-patch/3','documentId':'large','patchId':'large-image-export','baseRevision':0,'operations':[{'op':'image.replace','nodeId':image['nodeId'],'assetHash':staged['hash'],'precondition':{'visualHash':image['visualHash']}}]}));cli('apply',large,'--patch',patch,'--expected-revision',0)
 large_output=site/'large.html';cli('export',large,'--output',large_output,'--to','html');page=Page();page.feed(large_output.read_text());assert len(page.images)==1 and base64.b64decode(page.images[0].split(',',1)[1])==png
 # Regional model 2 now has a section-aware standalone presentation.
 # Recheck the shared entry points instead of expecting the former guard.
 regional=root/'rich.hcd';cli('unpack',repo/'docs/assets/hcd-word-node-resource-recovery-2026-10-27/browser-node-resource-r7.hcdz','--output',regional);sentinel=site/'regional.html';sentinel.write_text('existing user output');regional_report=cli('export',regional,'--output',sentinel,'--to','html');assert 'hcd-word-export-plan' in sentinel.read_text() and any(item['code']=='HCD_WORD_HTML_BROWSER_PAGINATION' for item in regional_report['warnings'])
 native_port=port();native_log=open(root/'native.log','wb');native=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{native_port}'],env=env,cwd=root,stdout=native_log,stderr=subprocess.STDOUT)
 try:
  for _ in range(200):
   if native.poll() is not None:raise RuntimeError('native server stopped')
   try:urllib.request.urlopen(f'http://127.0.0.1:{native_port}/health',timeout=1).close();break
   except OSError:time.sleep(.1)
  else:raise RuntimeError('native did not listen')
  def get(document,revision=None,authorize=True):
   token=cli('issue-token','--document-id',document,'--scope','read','--user-id','html-reader','--ttl-seconds',600)['token'];headers={'X-HCD-Node-Edits-Version':'7','X-HCD-Extension-Version':'2','X-HCD-Flow-Layout-Version':'2','X-HCD-Custom-Marks-Version':'1'}
   if authorize:headers['Authorization']='Bearer '+token
   request=urllib.request.Request(f'http://127.0.0.1:{native_port}/v1/documents/{document}/export/html'+(f'?revision={revision}' if revision is not None else ''),headers=headers)
   return urllib.request.urlopen(request,timeout=120).read()
  for n in [2,3,4,5,6]:assert get('mentions-docx',n)==(site/f'offline-r{n}.html').read_bytes()
  assert get('large')==large_output.read_bytes()
  try:get('mentions-docx',6,False);raise AssertionError('anonymous HTML export accepted')
  except urllib.error.HTTPError as error:assert error.code==401
  assert get('rich')==sentinel.read_bytes()
 finally:native.terminate();native.wait(timeout=20);native_log.close()
 assert native.poll() is not None
 # Source files and the original DOCX are unnecessary after materialization.
 large_source.unlink();assert 'Original' in (site/'offline-r6.html').read_text();assert all(cli('editor-state',bundle,'--revision',n)==states[n] for n in range(7));assert cli('validate',bundle)['valid']
 result={'scope':'Local actual CLI, isolated authenticated HTTP and source-free HCDZ; native server stopped before standalone browser preview. No production or original Office pagination acceptance.','root':str(root),'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'revisions':exports,'cliHttpIdentical':True,'anonymousDenied':True,'regionalSectionAwareCliHttpIdentical':True,'canonicalVersionsUnchanged':True,'largePng':{'bytes':len(png),'width':width,'height':height,'sha256':hashlib.sha256(png).hexdigest(),'outputBytes':large_output.stat().st_size,'cliHttpIdentical':True},'nativeServerStoppedBeforeReview':True}
 for path in [site/'offline-r6.html',large_output,root/'fidelity-r6.json']:shutil.copy2(path,assets/path.name)
 (assets/'file-evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 if args.preview:
  preview_port=port();log=open(root/'static.log','wb');static=subprocess.Popen(['python3','-m','http.server',str(preview_port),'--bind','127.0.0.1','--directory',str(site)],cwd=root,stdout=log,stderr=subprocess.STDOUT)
  print(json.dumps({'root':str(root),'preview':f'http://127.0.0.1:{preview_port}/offline-r6.html','large':f'http://127.0.0.1:{preview_port}/large.html','evidence':str(assets/'file-evidence.json')},ensure_ascii=False),flush=True)
  try:
   while static.poll() is None:time.sleep(.5)
  except KeyboardInterrupt:pass
  finally:static.terminate();static.wait(timeout=10);log.close()
 else:print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
