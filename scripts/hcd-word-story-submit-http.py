#!/usr/bin/env python3
"""Stopped-room native HTTP submission and independent-process recovery."""
import json,os,secrets,shutil,socket,subprocess,sys,tempfile,time,urllib.error,urllib.request,zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
if '--inherited-draft-browser' in sys.argv:sys.argv.append('--inherited-draft')
if '--new-story-browser' in sys.argv:sys.argv.append('--new-story')
if '--inherited-draft' in sys.argv:sys.argv.append('--stopped-draft')
if '--checkpoint-cancel' in sys.argv:sys.argv.append('--stopped-draft')
if '--checkpoint-cancel-browser' in sys.argv:sys.argv.append('--stopped-draft-browser')
if '--historical-noop-journal-advance' in sys.argv:sys.argv.append('--historical-noop')
if '--historical-noop' in sys.argv:sys.argv.append('--topology-recovery')
if '--historical-noop-browser' in sys.argv:sys.argv.extend(['--historical-noop','--topology-recovery'])
if '--historical-noop-disjoint-browser' in sys.argv:sys.argv.extend(['--historical-noop-browser','--historical-noop','--topology-recovery'])
if '--historical-noop-rebase' in sys.argv:sys.argv.extend(['--historical-noop-disjoint-browser','--historical-noop-browser','--historical-noop','--topology-recovery'])
if '--historical-noop-sidecar-rebase' in sys.argv:sys.argv.extend(['--historical-noop-rebase','--historical-noop-disjoint-browser','--historical-noop-browser','--historical-noop','--topology-recovery'])
if '--historical-noop-ui-rebase' in sys.argv:sys.argv.extend(['--historical-noop-sidecar-rebase','--historical-noop-rebase','--historical-noop-disjoint-browser','--historical-noop-browser','--historical-noop','--topology-recovery'])
if '--historical-noop-ui-rebase-lost' in sys.argv:sys.argv.extend(['--historical-noop-ui-rebase','--historical-noop-sidecar-rebase','--historical-noop-rebase','--historical-noop-disjoint-browser','--historical-noop-browser','--historical-noop','--topology-recovery'])
if '--historical-noop-ui-full' in sys.argv:sys.argv.extend(['--historical-noop-ui-rebase','--historical-noop-sidecar-rebase','--historical-noop-rebase','--historical-noop-disjoint-browser','--historical-noop-browser','--historical-noop','--topology-recovery'])
if '--historical-noop-head-advance' in sys.argv:sys.argv.extend(['--historical-noop-ui-rebase','--historical-noop-sidecar-rebase','--historical-noop-rebase','--historical-noop-disjoint-browser','--historical-noop-browser','--historical-noop','--topology-recovery'])
if '--historical-noop-ui-advance' in sys.argv:sys.argv.extend(['--historical-noop-ui-rebase','--historical-noop-sidecar-rebase','--historical-noop-rebase','--historical-noop-disjoint-browser','--historical-noop-browser','--historical-noop','--topology-recovery'])
repo=Path(__file__).resolve().parents[1];editor=repo/'examples/hdoc/editor';binary=repo/'target/debug/officecli';source=repo/'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx';env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32),'CARGO_TARGET_DIR':str(repo/'target'),'NO_COLOR':'1'}
def cli(*args):
 p=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120);return json.loads(p.stdout)['data']
with tempfile.TemporaryDirectory(prefix='word-story-submit-',dir=repo/'target') as temp:
 root=Path(temp)
 if '--historical-noop-disjoint-browser' in sys.argv:
  import re
  clean_source=root/'plain-source.docx'
  with zipfile.ZipFile(source) as original,zipfile.ZipFile(clean_source,'w') as cleaned:
   for entry in original.infolist():
    data=original.read(entry.filename)
    if entry.filename=='word/header1.xml':data=re.sub(rb'<w:drawing\b[^>]*>.*?</w:drawing>',b'',data,flags=re.DOTALL)
    cleaned.writestr(entry,data)
  source=clean_source
 project=root/'generator';(project/'src').mkdir(parents=True);(project/'src/main.rs').write_text((repo/'scripts/hcd-word-story-real-fixture.rs').read_text());(project/'Cargo.toml').write_text('[package]\nname="word-story-real-fixture"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nhcd-core={path='+json.dumps(str(repo/'crates/hcd-core'))+'}\nhcd-docx={path='+json.dumps(str(repo/'crates/hcd-docx'))+'}\nserde_json="1"\n[workspace]\n')
 generator=os.environ.get('HCD_TEST_STORY_GENERATOR')
 command=[generator,str(source),str(root/'doc.hcd'),'prepared'] if generator else ['cargo','run','--offline','--manifest-path',str(project/'Cargo.toml'),'--',str(source),str(root/'doc.hcd'),'prepared']
 p=subprocess.run(command,env=env,capture_output=True,text=True,timeout=300)
 if p.returncode:raise RuntimeError(p.stderr[-6000:])
 fixture=json.loads(p.stdout);assert fixture['revision']==1;fixture_path=root/'fixture.json';fixture_path.write_text(json.dumps(fixture,ensure_ascii=False));(root/'sources').mkdir();shutil.copyfile(source,root/'sources/doc.docx');(root/'collaboration').mkdir();(root/'collaboration/doc.epoch').write_text(json.dumps({'epoch':0,'protocol':'hcd-word-regions/2'}))
 token=cli('issue-token','--document-id','doc','--scope','write','--user-id','hcd-collaboration')['token']
 if ('--stopped-draft' in sys.argv or '--story-layout' in sys.argv or '--new-story' in sys.argv) or '--stopped-draft-browser' in sys.argv or '--stopped-draft-long' in sys.argv:env['HCD_TEST_STOPPED_DRAFT']='1'
 if '--preflight' in sys.argv:
  env['HCD_TEST_STORY_PREFLIGHT']='1';env['HCD_TEST_PREFLIGHT_READER']=cli('issue-token','--document-id','doc','--scope','read','--user-id','reader','--display-name','Reader')['token']
 if '--inherited-draft' in sys.argv:env['HCD_TEST_INHERITED_DRAFT']='1'
 if '--checkpoint-cancel' in sys.argv:env['HCD_TEST_CHECKPOINT_CANCEL']='1'
 if '--checkpoint-cancel-browser' in sys.argv:env['HCD_TEST_CHECKPOINT_CANCEL_BROWSER']='1'
 if '--inherited-draft-browser' in sys.argv:env['HCD_TEST_INHERITED_DRAFT_BROWSER']='1'
 if '--new-story' in sys.argv:env['HCD_TEST_NEW_STORY']='1'
 if '--new-story-browser' in sys.argv:env['HCD_TEST_NEW_STORY_BROWSER']='1'
 if '--story-layout' in sys.argv:env['HCD_TEST_STORY_LAYOUT']='1'
 if '--historical-noop' in sys.argv:env['HCD_TEST_HISTORICAL_NOOP']='1'
 if '--historical-noop-journal-advance' in sys.argv:env['HCD_TEST_NOOP_JOURNAL_ADVANCE']='1'
 if '--historical-noop-browser' in sys.argv:env['HCD_TEST_HISTORICAL_NOOP_BROWSER']='1'
 if '--historical-noop-disjoint-browser' in sys.argv:env['HCD_TEST_STALE_DISJOINT']='1';env['HCD_TEST_STOPPED_DRAFT']='1'
 if '--historical-noop-rebase' in sys.argv:env['HCD_TEST_STALE_REBASE']='1'
 if '--historical-noop-sidecar-rebase' in sys.argv:env['HCD_TEST_STALE_SIDECAR_REBASE']='1'
 if '--historical-noop-ui-rebase' in sys.argv:env['HCD_TEST_STALE_UI_REBASE']='1'
 if '--historical-noop-ui-rebase-lost' in sys.argv:env['HCD_TEST_STALE_UI_REBASE_LOST']='1'
 if '--historical-noop-ui-full' in sys.argv:env['HCD_TEST_STALE_UI_FULL']='1'
 if '--historical-noop-head-advance' in sys.argv:env['HCD_TEST_STALE_HEAD_ADVANCE']='1'
 if '--historical-noop-ui-advance' in sys.argv:env['HCD_TEST_STALE_UI_ADVANCE']='1'
 if '--stopped-draft-long' in sys.argv:env['HCD_TEST_STOPPED_DRAFT_LONG']='1'
 if '--stopped-draft-browser' in sys.argv:env['HCD_TEST_STOPPED_DRAFT_BROWSER']='1'
 if '--sidecar-recovery' in sys.argv or '--browser-recovery' in sys.argv or '--topology-recovery' in sys.argv or '--topology-browser-recovery' in sys.argv or ('--stopped-draft' in sys.argv or '--story-layout' in sys.argv or '--new-story' in sys.argv) or '--stopped-draft-browser' in sys.argv or '--stopped-draft-long' in sys.argv:
  env['HCD_TEST_ALICE']=cli('issue-token','--document-id','doc','--scope','write','--user-id','alice','--display-name','Alice')['token'];env['HCD_TEST_BOB']=cli('issue-token','--document-id','doc','--scope','write','--user-id','bob','--display-name','Bob')['token'];env['HCD_TEST_SIDECAR_RECOVERY']='1'
  env['HCD_TEST_READER']=cli('issue-token','--document-id','doc','--scope','read','--user-id','reader','--display-name','Reader')['token']
  if '--browser-recovery' in sys.argv or '--topology-browser-recovery' in sys.argv:env['HCD_TEST_BROWSER_RECOVERY']='1'
  if '--topology-browser-recovery' in sys.argv:env['HCD_TEST_TOPOLOGY_BROWSER']='1'
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 api=f'http://127.0.0.1:{port}';native=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{port}'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  deadline=time.monotonic()+30
  while True:
   assert native.poll() is None
   try:
    with urllib.request.urlopen(urllib.request.Request(api+'/v1/documents/doc/auth',headers={'Authorization':'Bearer '+token}),timeout=1) as response:
     if response.status==200:break
   except urllib.error.URLError:pass
   assert time.monotonic()<deadline;time.sleep(.05)
  def stage(name):
   try:p=subprocess.run(['node','--import','tsx',str(repo/'scripts/hcd-word-story-submit-http.mts'),name,str(root/'journal'),str(fixture_path),api,token],cwd=editor,env=env,capture_output=True,text=True,timeout=600 if '--historical-noop-browser' in sys.argv or '--inherited-draft-browser' in sys.argv or '--new-story-browser' in sys.argv or '--browser-recovery' in sys.argv or '--topology-browser-recovery' in sys.argv or '--stopped-draft-browser' in sys.argv else 180 if '--new-story' in sys.argv or '--inherited-draft' in sys.argv or '--checkpoint-cancel' in sys.argv or '--historical-noop' in sys.argv else 60)
   except subprocess.TimeoutExpired:raise RuntimeError('isolated Word fixture worker timed out') from None
   if p.returncode:raise RuntimeError(p.stderr[-6000:])
   return json.loads(p.stdout)
  clean='--clean' in sys.argv;before='--before' in sys.argv;ws='--ws' in sys.argv or '--sidecar-recovery' in sys.argv or '--browser-recovery' in sys.argv;active='--active' in sys.argv or ws
  if active:
   recovered=stage('ws' if ws else 'active');assert recovered['admittedPacketDrained'] and recovered['tcpResponseDropped'];assert recovered['oldRoomHeld'] if ws else recovered['activeOwnerHeld']
  else:
   prepared=stage('prepare-clean' if clean else 'prepare');submitted=stage('submit-before' if before else 'submit');assert submitted['lostResponse'] and submitted['tcpResponseDropped'] and submitted['tip']==prepared['tip'];assert submitted['preflightChecked'] if '--preflight' in sys.argv else True
   with urllib.request.urlopen(urllib.request.Request(api+'/v1/documents/doc/revisions?limit=1',headers={'Authorization':'Bearer '+token}),timeout=5) as response:assert json.load(response)['headRevision']==(1 if before else 2)
   recovered=stage('sidecar-story' if '--topology-recovery' in sys.argv or '--topology-browser-recovery' in sys.argv or ('--stopped-draft' in sys.argv or '--story-layout' in sys.argv or '--new-story' in sys.argv) or '--stopped-draft-browser' in sys.argv or '--stopped-draft-long' in sys.argv else 'resume-clean' if clean else 'resume')
  expected=5 if '--historical-noop-head-advance' in sys.argv or '--historical-noop-ui-advance' in sys.argv else 4 if '--historical-noop-rebase' in sys.argv or '--story-layout' in sys.argv or '--new-story' in sys.argv or '--inherited-draft' in sys.argv else 3 if ws or '--historical-noop' in sys.argv or ('--stopped-draft' in sys.argv or '--story-layout' in sys.argv or '--new-story' in sys.argv) or '--stopped-draft-browser' in sys.argv or '--stopped-draft-long' in sys.argv else 2
  assert recovered['revision']==expected and (recovered['cleanActors'] if clean else recovered['lateDraftPreserved']) and recovered['actualNativeReceipt'];assert cli('validate',root/'doc.hcd')['valid']
  with urllib.request.urlopen(urllib.request.Request(api+'/v1/documents/doc/revisions?limit=1',headers={'Authorization':'Bearer '+token}),timeout=5) as response:assert json.load(response)['headRevision']==expected
  output=root/'result.docx';cli('export',root/'doc.hcd','--revision',expected,'--output',output)
  with zipfile.ZipFile(output) as doc:
   ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
   sections=ET.fromstring(doc.read('word/document.xml')).findall('.//w:sectPr',ns)
   first=[section.find("w:headerReference[@w:type='first']",ns) for section in sections];assert len(first)>=2 and all(item is not None for item in first[:2]);assert first[0].get('{'+ns['r']+'}id')!=first[1].get('{'+ns['r']+'}id')
   if '--historical-noop' in sys.argv:assert b'Competing newer version' in doc.read('word/document.xml') and (b'Submitted draft' in doc.read('word/document.xml'))==('--historical-noop-rebase' in sys.argv)
   if '--historical-noop-ui-advance' in sys.argv:assert b'Competing newer version again' in doc.read('word/document.xml')
   if ('--stopped-draft' in sys.argv or '--story-layout' in sys.argv or '--new-story' in sys.argv) or '--stopped-draft-browser' in sys.argv or '--stopped-draft-long' in sys.argv:assert b'Submitted draft' in doc.read('word/document.xml')
   if '--story-layout' in sys.argv:assert int(sections[0].find('w:pgSz',ns).get('{'+ns['w']+'}w'))==fixture['previous']['flowLayout']['sections'][0]['page']['widthTwips']+20
   if '--stopped-draft-long' in sys.argv:assert ('长'*2500).encode() in doc.read('word/document.xml')
   if '--new-story' in sys.argv:assert sections[1].find("w:footerReference[@w:type='even']",ns) is not None
   if '--inherited-draft' in sys.argv:
    refs=[section.find("w:footerReference[@w:type='default']",ns) for section in sections[:2]];assert all(ref is not None for ref in refs) and refs[0].get('{'+ns['r']+'}id')!=refs[1].get('{'+ns['r']+'}id')
    assert sum(b'Unsaved footer' in doc.read(name) for name in doc.namelist() if name.startswith('word/footer') and name.endswith('.xml'))>=2
   if ws:
    assert b'New room Bob admitted draft' in doc.read('word/document.xml')
    assert b'New room rejected late edit' not in doc.read('word/document.xml')
    assert any(b'Edited new header' in doc.read(name) for name in doc.namelist() if name.startswith('word/header') and name.endswith('.xml'))
  cli('pack',root/'doc.hcd','--output',root/'offline.hcdz');cli('unpack',root/'offline.hcdz','--output',root/'offline.hcd');assert cli('validate',root/'offline.hcd')['valid']
  print(json.dumps({'actualNativeHttp':True,'stoppedCoordinator':True,'tcpDroppedBeforeCommit':before,'tcpResponseDroppedAfterNativeCommit':not before,'differentNodeProcessRecovered':not active,'semanticDocxReferencesDistinct':True,'offlineBundleValidated':True,'storyPreflightChecked':'--preflight' in sys.argv,**recovered}))
 finally:
  native.terminate()
  try:native.wait(timeout=10)
  except subprocess.TimeoutExpired:native.kill();native.wait()
