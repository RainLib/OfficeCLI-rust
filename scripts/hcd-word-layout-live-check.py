#!/usr/bin/env python3
"""Verify a live coordinator layout transition on a disposable native bundle."""
import argparse, hashlib, json, os, secrets, shutil, socket, subprocess, tempfile, time, urllib.error, urllib.request, zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

repo=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();mode=parser.add_mutually_exclusive_group();mode.add_argument('--ws',action='store_true');mode.add_argument('--ws-reopen',action='store_true');mode.add_argument('--ws-room-save',action='store_true');mode.add_argument('--ws-room-clients',action='store_true');mode.add_argument('--ws-install',action='store_true');mode.add_argument('--ws-retire',action='store_true');mode.add_argument('--ws-switch',action='store_true');mode.add_argument('--ws-save',action='store_true');mode.add_argument('--ws-image-save',action='store_true');mode.add_argument('--ws-image-retry',action='store_true');mode.add_argument('--ws-image-crash',action='store_true');mode.add_argument('--ws-image-crash-before',action='store_true');mode.add_argument('--clean',action='store_true');mode.add_argument('--topology-recovery',action='store_true');parser.add_argument('--stopped-layout',action='store_true');parser.add_argument('--stopped-layout-browser',action='store_true');parser.add_argument('--stopped-layout-browser-lost',action='store_true');parser.add_argument('--margin',action='store_true');parser.add_argument('--page',action='store_true');parser.add_argument('--timeout',type=int,default=120);parser.add_argument('--live-save',action='store_true');parser.add_argument('--live-switch',action='store_true');parser.add_argument('--output',type=Path);args=parser.parse_args();image_mode=args.ws_image_save or args.ws_image_retry or args.ws_image_crash or args.ws_image_crash_before or args.live_save
if args.live_save and not args.ws_room_clients:parser.error('--live-save requires --ws-room-clients')
if args.live_switch and (not args.ws_switch or args.live_save):parser.error('--live-switch requires --ws-switch and excludes --live-save')
binary=repo/'target/debug/officecli'
archive=repo/'docs/assets/hcd-word-layout-receipt-2026-10-27/layout-r7.hcdz'
projection=json.loads((repo/'docs/assets/hcd-word-layout-transition-2026-10-27/projection-r7.json').read_text())
env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32),'NO_COLOR':'1'}
if args.live_save:env['HCD_TEST_WORD_LIVE_SAVE']='1'
if args.live_switch:env['HCD_TEST_WORD_LIVE_SWITCH']='1'
if args.ws_image_crash or args.ws_image_crash_before:env['HCD_TEST_CHECKPOINT_CRASH']='1'
if args.ws_image_crash_before:env['HCD_TEST_CHECKPOINT_DROP_BEFORE']='1'
for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
def cli(*args):
 return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
with tempfile.TemporaryDirectory(prefix='layout-live-',dir=repo/'target') as path:
 root=Path(path);bundle=root/'region-test.hcd'
 if image_mode:
  cli('import',repo/'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx','--word-regions','--document-id','region-test','--output',bundle);cli('project-editor',bundle,'--word-regions','--expected-revision',0);projection=cli('editor-state',bundle)
 else:cli('unpack',archive,'--output',bundle)
 token=cli('issue-token','--document-id','region-test','--scope','write','--user-id','hcd-collaboration')['token'];env['HCD_TEST_TOKEN']=token
 if args.topology_recovery or args.stopped_layout or args.stopped_layout_browser or args.stopped_layout_browser_lost:
  env['HCD_TEST_LAYOUT_RECOVERY']='1'
  if args.stopped_layout:env['HCD_TEST_STOPPED_LAYOUT']='1'
  if args.stopped_layout_browser or args.stopped_layout_browser_lost:env['HCD_TEST_STOPPED_LAYOUT_BROWSER']='1'
  if args.stopped_layout_browser_lost:env['HCD_TEST_STOPPED_LAYOUT_BROWSER_LOST']='1'
  env['HCD_TEST_READER']=cli('issue-token','--document-id','region-test','--scope','read','--user-id','reader','--display-name','Reader')['token'];env['HCD_TEST_ALICE']=cli('issue-token','--document-id','region-test','--scope','write','--user-id','alice','--display-name','Alice')['token'];env['HCD_TEST_BOB']=cli('issue-token','--document-id','region-test','--scope','write','--user-id','bob','--display-name','Bob')['token']
 with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
 origin=f'http://127.0.0.1:{port}';collab=root/'collaboration';collab.mkdir();(collab/'region-test.epoch').write_text(json.dumps({'epoch':0,'protocol':'hcd-word-regions/2'}))
 section=projection['flowLayout']['sections'][0];width=section['page']['widthTwips']
 base=projection['revision'];request={'schemaVersion':'hcd-word-layout-transaction/1','documentId':'region-test','transactionId':secrets.token_hex(16),'baseRevision':base,'expectedRevision':base,'actor':{'userId':'alice','displayName':'Alice'},'edits':{'schemaVersion':'hcd-word-layout-edits/1','baseLayoutHash':projection['flowLayoutHash'],'changes':[{'sectionId':section['id'],'field':'widthTwips','expected':width,'value':width+20}]}}
 if args.margin or args.page:
  projection_file=root/'projection.json';projection_file.write_text(json.dumps(projection))
  plans=json.loads(subprocess.run(['node','--import','tsx',str(repo/'scripts/hcd-word-paper-intent-check.mts'),str(projection_file)],cwd=repo/'examples/hdoc/editor',capture_output=True,text=True,check=True,timeout=60).stdout)
  request['edits']=plans['pageSection' if args.page else 'marginSection']['intent']
 fixture=root/'fixture.json';fixture.write_text(json.dumps({'request':request,'projection':projection,'rootHash':cli('get-revision',bundle,base)['rootHash']}));fixture.chmod(0o600)
 process=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{port}'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  deadline=time.monotonic()+30
  while True:
   assert process.poll() is None
   try:
    with urllib.request.urlopen(urllib.request.Request(origin+'/v1/documents/region-test',headers={'Authorization':'Bearer '+token}),timeout=2):break
   except urllib.error.URLError:assert time.monotonic()<deadline;time.sleep(.05)
  try:
   result=subprocess.run(['node','--import','tsx',str(repo/'scripts/hcd-word-layout-live-check.mts'),str(root/'journal'),str(fixture),origin,*(['ws-image-retry'] if args.ws_image_retry or args.ws_image_crash or args.ws_image_crash_before else ['ws-image-save'] if args.ws_image_save else ['ws-save'] if args.ws_save else ['ws-switch'] if args.ws_switch else ['ws-retire'] if args.ws_retire else ['ws-install'] if args.ws_install else ['ws-room-clients'] if args.ws_room_clients else ['ws-room-save'] if args.ws_room_save else ['ws-reopen'] if args.ws_reopen else ['ws'] if args.ws else ['clean'] if args.clean else [])],cwd=repo/'examples/hdoc/editor',env=env,capture_output=True,text=True,timeout=args.timeout)
  except subprocess.TimeoutExpired as error:
   detail=(error.stderr or b'').decode(errors='replace') if isinstance(error.stderr,bytes) else (error.stderr or '')
   raise RuntimeError('layout fixture timed out; last stages: '+detail[-4000:]) from error
  if args.ws_image_crash or args.ws_image_crash_before:
   assert result.returncode == -9, result.stderr[-4000:]
   marker=json.loads((root/'checkpoint-crash-ready.json').read_text())
   recover_env={**env,'HCD_TEST_OWNER_EXPIRED_RETRY':'1'};recover_env.pop('HCD_TEST_CHECKPOINT_CRASH',None)
   recovered=subprocess.run(['node','--import','tsx',str(repo/'scripts/hcd-word-checkpoint-initiator-process.mts'),str(root/'journal'),origin,'recover'],cwd=repo/'examples/hdoc/editor',env=recover_env,capture_output=True,text=True,timeout=60,check=True)
   receipt=json.loads(recovered.stdout);assert receipt['recovered'] and receipt['wrongMemberRejected'] and receipt['tip']==marker['journalTip'] and receipt['checkpointId']==marker['checkpointId'] and receipt['revision']==marker['revision'] and receipt['leaseRetries']>0
   assert marker['dropBeforeNativeCommit']==args.ws_image_crash_before
   evidence={**marker,'ownerProcessKilled':True,'leaseExpiryTakeover':True,'leaseAcquireRetries':receipt['leaseRetries'],'differentProcessRecovered':True,'wrongMemberRejected':True,'exactCheckpointRecovered':True,'checkpointResponseTcpDropped':not args.ws_image_crash_before,'checkpointRequestDroppedBeforeCommit':args.ws_image_crash_before}
  else:
   if result.returncode:raise RuntimeError(result.stderr[-4000:])
   evidence=json.loads(result.stdout)
  assert evidence['revision']==base+(5 if args.live_save else 2 if args.live_switch or args.ws_save or args.ws_room_save or args.ws_room_clients or image_mode or args.stopped_layout or args.stopped_layout_browser or args.stopped_layout_browser_lost else 1) and evidence['submissions']==1
  assert cli('validate',bundle)['valid'];assert cli('editor-state',bundle)['revision']==evidence['revision'];out=root/'result.docx';cli('export',bundle,'--revision',evidence['revision'],'--output',out)
  with zipfile.ZipFile(out) as doc:
   ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'};sections=ET.fromstring(doc.read('word/document.xml')).findall('.//w:sectPr',ns)
   assert int(sections[0].find('w:pgSz',ns).attrib['{'+ns['w']+'}w'])==(width+40 if args.stopped_layout else 11906 if args.page else width if args.margin else width+20)
   if args.stopped_layout_browser or args.stopped_layout_browser_lost:assert int(sections[0].find('w:pgMar',ns).attrib['{'+ns['w']+'}top'])==1134
   if args.margin or args.page:
    margins=sections[0].find('w:pgMar',ns);assert int(margins.attrib['{'+ns['w']+'}top'])==875 and int(margins.attrib['{'+ns['w']+'}left'])==1250
    assert '{'+ns['w']+'}header' not in margins.attrib and int(margins.attrib['{'+ns['w']+'}footer'])==720
   if (args.ws_save or image_mode) and not args.live_save:assert 'Bob admitted websocket draft' in ''.join(ET.fromstring(doc.read('word/document.xml')).itertext())
   if args.ws_room_clients:
    text=''.join(ET.fromstring(doc.read('word/document.xml')).itertext());assert (evidence['finalBody'] if args.live_save else 'New room Bob admitted edit') in text and 'New room rejected late edit' not in text
    if args.live_save:
     assert any(evidence['finalHeader'] in ''.join(ET.fromstring(doc.read(name)).itertext()) for name in doc.namelist() if name.startswith('word/header') and name.endswith('.xml'))
     assert any(evidence['finalFooter'] in ''.join(ET.fromstring(doc.read(name)).itertext()) for name in doc.namelist() if name.startswith('word/footer') and name.endswith('.xml'));evidence['docxLiveBodyHeaderFooterVerified']=True
   if args.live_switch:assert 'After retirement draft' in ''.join(ET.fromstring(doc.read('word/document.xml')).itertext())
   if args.ws_room_save:assert 'Reopened coordinator draft' in ''.join(ET.fromstring(doc.read('word/document.xml')).itertext())
   if image_mode:
    extents=[node for name in doc.namelist() if name.startswith('word/header') and name.endswith('.xml') for node in ET.fromstring(doc.read(name)).iter('{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent')];assert any(int(node.attrib['cx'])==evidence['imageWidth'] for node in extents);assert evidence['imageAssetHash'] in {hashlib.sha256(doc.read(name)).hexdigest() for name in doc.namelist() if name.startswith('word/media/')}
  if args.live_switch or image_mode or args.margin or args.page or args.stopped_layout or args.stopped_layout_browser or args.stopped_layout_browser_lost:
   packed=root/'offline.hcdz';unpacked=root/'offline.hcd';cli('pack',bundle,'--output',packed);cli('unpack',packed,'--output',unpacked);assert cli('validate',unpacked)['valid'];assert cli('editor-state',unpacked,'--revision',evidence['revision'])==cli('editor-state',bundle,'--revision',evidence['revision'])
   if image_mode:assert cli('get-image',unpacked,evidence['imageNodeId'])==cli('get-image',bundle,evidence['imageNodeId'])
   evidence['offlineBundleVerified']=True
  evidence.update({'scope':'isolated native service with real sidecar recovery and simulated admitted packet' if args.topology_recovery or args.stopped_layout or args.stopped_layout_browser or args.stopped_layout_browser_lost else 'isolated native service and test Hocuspocus room' if args.ws or args.ws_reopen or args.ws_room_save or args.ws_room_clients or args.ws_install or args.ws_retire or args.ws_switch or args.ws_save or image_mode else 'isolated native service with live coordinator and simulated admitted packet','docxPageWidthVerified':True,'nativeBundleValidated':True,'realSidecar':bool(args.topology_recovery or args.stopped_layout or args.stopped_layout_browser or args.stopped_layout_browser_lost),'browser':bool(args.stopped_layout_browser or args.stopped_layout_browser_lost),'production':False})
  if args.output is None and not args.topology_recovery and not args.margin and not args.page and not args.stopped_layout and not args.stopped_layout_browser and not args.stopped_layout_browser_lost:
   target=repo/'docs/assets/hcd-word-layout-live-2026-10-28';target.mkdir(parents=True,exist_ok=True);(target/('checkpoint-process-crash-before.json' if args.ws_image_crash_before else 'checkpoint-process-crash.json' if args.ws_image_crash else 'websocket-image-retry.json' if args.ws_image_retry else 'websocket-image-saved.json' if args.ws_image_save else 'websocket-saved.json' if args.ws_save else 'websocket-switch.json' if args.ws_switch else 'websocket-retire.json' if args.ws_retire else 'websocket-install.json' if args.ws_install else 'websocket-room-clients.json' if args.ws_room_clients else 'websocket-room-save.json' if args.ws_room_save else 'websocket-reopen.json' if args.ws_reopen else 'websocket.json' if args.ws else 'clean.json' if args.clean else 'native.json')).write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
  if args.margin or args.page:evidence.update({'docxMarginsVerified':True,'frontendMarginIntent':True,'combinedPageIntent':args.page})
  if args.output:
   args.output.parent.mkdir(parents=True,exist_ok=True)
   docx_file=args.output.with_suffix('.docx');shutil.copyfile(out,docx_file);evidence['docxFile']=docx_file.name;evidence['docxSha256']=hashlib.sha256(docx_file.read_bytes()).hexdigest()
   if (root/'offline.hcdz').is_file():
    hcdz_file=args.output.with_suffix('.hcdz');shutil.copyfile(root/'offline.hcdz',hcdz_file);evidence['hcdzFile']=hcdz_file.name;evidence['hcdzSha256']=hashlib.sha256(hcdz_file.read_bytes()).hexdigest()
   evidence['nativeBinarySha256']=hashlib.sha256(binary.read_bytes()).hexdigest();args.output.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
  print(json.dumps(evidence))
 finally:
  process.terminate()
  try:process.wait(timeout=10)
  except subprocess.TimeoutExpired:process.kill();process.wait()
