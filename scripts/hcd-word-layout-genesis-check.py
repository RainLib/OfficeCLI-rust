#!/usr/bin/env python3
"""Isolated fresh /2 stopped layout initialization and DOCX readback."""
import json, os, secrets, socket, subprocess, tempfile, time, urllib.error, urllib.request, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
repo=Path(__file__).resolve().parents[1]; binary=repo/'target/debug/officecli'; editor=repo/'examples/hdoc/editor'
env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32),'NO_COLOR':'1','HCD_WORD_ROOMS':'1'}
def cli(*args):
 p=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120)
 return json.loads(p.stdout)['data']
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def call(url,token,body):
 request=urllib.request.Request(url,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'})
 try:
  with urllib.request.urlopen(request,timeout=30) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.loads(e.read())
with tempfile.TemporaryDirectory(prefix='layout-genesis-',dir=repo/'target') as temp:
 root=Path(temp); bundle=root/'region-test.hcd'; cli('unpack',repo/'docs/assets/hcd-word-layout-receipt-2026-10-27/layout-r7.hcdz','--output',bundle)
 base=cli('editor-state',bundle)['revision'];alice=cli('issue-token','--document-id','region-test','--scope','write','--user-id','alice','--display-name','Alice')['token'];reader=cli('issue-token','--document-id','region-test','--scope','read','--user-id','reader','--display-name','Reader')['token']
 (root/'collaboration').mkdir();(root/'collaboration/region-test.epoch').write_text(json.dumps({'epoch':0,'protocol':'hcd-word-regions/2'}))
 native_port,sidecar_port=port(),port();origin=f'http://127.0.0.1:{native_port}';env.update(HCD_API_URL=origin,HCD_COLLAB_PORT=str(sidecar_port),HCD_SIDECAR_STATE_DIR=str(root/'journal'))
 native=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{native_port}'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 sidecar=subprocess.Popen(['node','--import','tsx','sidecar.ts'],cwd=editor,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  for process,url in [(native,origin),(sidecar,f'http://127.0.0.1:{sidecar_port}')]:
   deadline=time.monotonic()+60
   while True:
    assert process.poll() is None
    try:
     with urllib.request.urlopen(url,timeout=1):break
    except urllib.error.HTTPError:break
    except urllib.error.URLError:assert time.monotonic()<deadline;time.sleep(.1)
  endpoint=f'http://127.0.0.1:{sidecar_port}/v1/documents/region-test/collaboration/word-stopped-layout'
  assert call(endpoint,reader,{'operation':'inspect','epoch':0})[0]==403
  cancellation=endpoint.replace('word-stopped-layout','word-topology-cancel');cancel_request={'epoch':0,'transactionId':'9'*32}
  assert call(cancellation,reader,cancel_request)[0]==403
  assert call(cancellation,alice,cancel_request)==(200,{'transactionId':'9'*32,'status':'not-prepared'})
  assert (root/'collaboration/word-owners'/('region-test.0.'+'9'*32+'.cancel')).is_file()
  native.terminate();native.wait(timeout=10)
  native=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{native_port}'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  deadline=time.monotonic()+60
  while True:
   assert native.poll() is None
   try:
    with urllib.request.urlopen(origin,timeout=1):break
   except urllib.error.HTTPError:break
   except urllib.error.URLError:assert time.monotonic()<deadline;time.sleep(.1)
  assert call(cancellation,alice,cancel_request)==(200,{'transactionId':'9'*32,'status':'not-prepared'})
  status,view=call(endpoint,alice,{'operation':'inspect','epoch':0});assert status==200,(status,view);assert view['revision']==base
  sidecar.terminate();sidecar.wait(timeout=10)
  sidecar=subprocess.Popen(['node','--import','tsx','sidecar.ts'],cwd=editor,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  deadline=time.monotonic()+60
  while True:
   assert sidecar.poll() is None
   try:
    with urllib.request.urlopen(f'http://127.0.0.1:{sidecar_port}',timeout=1):break
   except urllib.error.HTTPError:break
   except urllib.error.URLError:assert time.monotonic()<deadline;time.sleep(.1)
  status,reopened=call(endpoint,alice,{'operation':'inspect','epoch':0});assert status==200,(status,reopened);assert reopened==view
  section=view['layout']['sections'][0];width=section['page']['widthTwips'];proposal={'operation':'apply','epoch':0,'revision':base,'reviewHash':view['reviewHash'],'transactionId':secrets.token_hex(16),'edits':{'schemaVersion':'hcd-word-layout-edits/1','baseLayoutHash':view['layoutHash'],'changes':[{'sectionId':section['id'],'field':'widthTwips','expected':width,'value':width+20}]}}
  assert call(endpoint,alice,{**proposal,'reviewHash':'0'*64})[0]==409
  status,result=call(endpoint,alice,proposal);assert status==200,(status,result);assert result['revision']==base+1
  status,after=call(endpoint,alice,{'operation':'inspect','epoch':0});assert status==200,(status,after);assert after['layout']['sections'][0]['page']['widthTwips']==width+20
  assert cli('validate',bundle)['valid'];out=root/'result.docx';cli('export',bundle,'--revision',base+1,'--output',out)
  with zipfile.ZipFile(out) as doc:
   ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'};sections=ET.fromstring(doc.read('word/document.xml')).findall('.//w:sectPr',ns);assert int(sections[0].find('w:pgSz',ns).get('{'+ns['w']+'}w'))==width+20
  sidecar.terminate();sidecar.wait(timeout=10)
  alternate={**env,'HCD_SIDECAR_STATE_DIR':str(root/'other-journal')}
  sidecar=subprocess.Popen(['node','--import','tsx','sidecar.ts'],cwd=editor,env=alternate,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  deadline=time.monotonic()+60
  while True:
   assert sidecar.poll() is None
   try:
    with urllib.request.urlopen(f'http://127.0.0.1:{sidecar_port}',timeout=1):break
   except urllib.error.HTTPError:break
   except urllib.error.URLError:assert time.monotonic()<deadline;time.sleep(.1)
  assert call(endpoint,alice,{'operation':'inspect','epoch':0})[0]==409
  assert cli('editor-state',bundle)['revision']==base+1
  print(json.dumps({'freshJournal':True,'cancelledWithEmptyJournal':True,'nativeRestartVerified':True,'sidecarRestartVerified':True,'otherStoreRejected':True,'readerRejected':True,'staleReviewRejected':True,'revision':base+1,'docxWidthVerified':True}))
 finally:
  for p in [sidecar,native]:p.terminate()
  for p in [sidecar,native]:
   try:p.wait(timeout=10)
   except subprocess.TimeoutExpired:p.kill();p.wait()
