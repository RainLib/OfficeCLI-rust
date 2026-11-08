#!/usr/bin/env python3
"""Verify prepared layout submission and restart against an isolated native server."""
import hashlib, json, os, secrets, socket, struct, subprocess, sys, tempfile, time, urllib.error, urllib.request, zipfile, zlib
from pathlib import Path
import xml.etree.ElementTree as ET

repo = Path(__file__).resolve().parents[1]
binary = repo / 'target/debug/officecli'
archive = repo / 'docs/assets/hcd-word-layout-receipt-2026-10-27/layout-r7.hcdz'
projection = json.loads((repo / 'docs/assets/hcd-word-layout-transition-2026-10-27/projection-r7.json').read_text())
env = {**os.environ, 'HCD_TOKEN_SECRET': secrets.token_hex(32), 'NO_COLOR': '1'}
def cli(*args):
    result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], env=env, capture_output=True, text=True, check=True, timeout=120)
    return json.loads(result.stdout)['data']
with tempfile.TemporaryDirectory(prefix='layout-coordinator-', dir=repo/'target') as path:
    root = Path(path); bundle = root/'region-test.hcd'
    if '--images' in sys.argv:
        assert '--checkpoint-drop' in sys.argv
        cli('import',repo/'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx','--word-regions','--document-id','region-test','--output',bundle)
        cli('project-editor',bundle,'--word-regions','--expected-revision',0)
        projection=cli('editor-state',bundle)
    else: cli('unpack', archive, '--output', bundle)
    base=projection['revision']; layout_revision=base+1
    token = cli('issue-token', '--document-id', 'region-test', '--scope', 'write', '--user-id', 'hcd-collaboration')['token']
    writer = cli('issue-token', '--document-id', 'region-test', '--scope', 'write', '--user-id', 'alice')['token']
    env['HCD_TEST_TOKEN'] = token; env['HCD_TEST_WRITER'] = writer
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}/v1/documents/region-test'
    collab = root/'collaboration'; collab.mkdir(exist_ok=True)
    (collab/'region-test.epoch').write_text(json.dumps({'epoch':0,'protocol':'hcd-word-regions/2'}))
    section = projection['flowLayout']['sections'][0]; width = section['page']['widthTwips']
    tx = {'schemaVersion':'hcd-word-layout-transaction/1','documentId':'region-test','transactionId':'8'*32,'baseRevision':base,'expectedRevision':base,'actor':{'userId':'alice','displayName':'Alice'},'edits':{'schemaVersion':'hcd-word-layout-edits/1','baseLayoutHash':projection['flowLayoutHash'],'changes':[{'sectionId':section['id'],'field':'widthTwips','expected':width,'value':width+20}]}}
    fixture = {'previous':projection,'next':projection,'previousRoot':cli('get-revision',bundle,base)['rootHash'],'request':tx,'apiUrl':origin,'protocol':'hcd-word-regions/2','storeId':'d'*32,'images':'--images' in sys.argv,'attribution':'unbound' if '--unbound' in sys.argv else 'same' if '--same-author' in sys.argv else 'bound' if '--attribution' in sys.argv else None}
    if fixture['images']:
        def chunk(kind,data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
        replacement=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\x00\xff\x00\x00\x00\x80\xff'))+chunk(b'IEND',b'')
        image_path=root/'replacement.png';image_path.write_bytes(replacement);fixture['replacementPath']=str(image_path);fixture['replacementHash']=hashlib.sha256(replacement).hexdigest()
    fixture_path = root/'layout-fixture.json'; fixture_path.write_text(json.dumps(fixture,ensure_ascii=False)); fixture_path.chmod(0o600)
    def journal(stage):
        result = subprocess.run(['node','--import','tsx',str(repo/'scripts/hcd-word-layout-journal-http.mts'),stage,str(root/'journal'),str(fixture_path)],cwd=repo/'examples/hdoc/editor',env=env,capture_output=True,text=True,timeout=45)
        if result.returncode: raise RuntimeError(result.stderr[-4000:])
        return json.loads(result.stdout)
    prepared = journal('prepare'); fixture['header'] = prepared['header']; fixture_path.write_text(json.dumps(fixture,ensure_ascii=False))
    process = subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{port}'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic()+30
        while True:
            assert process.poll() is None
            try:
                with urllib.request.urlopen(urllib.request.Request(origin,headers={'Authorization':'Bearer '+token}),timeout=3) as response:
                    if response.status==200: break
            except urllib.error.URLError: pass
            assert time.monotonic()<deadline; time.sleep(.05)
        interrupted = journal('submit'); assert interrupted['tcpResponseDropped'] and interrupted['pendingPreserved'] and interrupted['tip']==prepared['tip']
        assert cli('get-revision',bundle,layout_revision)['revision']==layout_revision
        resumed = journal('submit-resume'); assert resumed['revision']==layout_revision and resumed['receiptCalls']==1 and resumed['lateTextPreserved'] and resumed['fencedProjection']
        for auth in (writer,token):
            try:
                urllib.request.urlopen(urllib.request.Request(origin+f'/editor?revision={layout_revision}',headers={'Authorization':'Bearer '+auth,'X-HCD-Flow-Layout-Version':'2','X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1','X-HCD-Collaboration-Epoch':'0','X-HCD-Collaboration-Protocol':'hcd-word-regions/2'}),timeout=3)
            except urllib.error.HTTPError as error: assert error.code in (409,426)
            else: raise AssertionError('unfenced projection read was accepted')
        with urllib.request.urlopen(urllib.request.Request(origin+'/revisions?limit=1',headers={'Authorization':'Bearer '+token}),timeout=3) as response:
            assert json.load(response)['headRevision']==layout_revision
        if '--checkpoint-drop' in sys.argv:
            dropped=journal('checkpoint-drop');assert dropped['tcpResponseDropped'] and dropped['pendingPreserved']
            if '--images' in sys.argv:
                fixture['image']=dropped['image'];fixture_path.write_text(json.dumps(fixture,ensure_ascii=False))
            ack_dropped=journal('checkpoint-ack-drop');assert ack_dropped['tcpResponseDropped'] and ack_dropped['acknowledgementPreserved'] and ack_dropped['checkpointReplayVerified'] and ack_dropped['activeRoomAndReadScopeRejected'] and ack_dropped['requestFieldsBound']
            checkpoint=journal('checkpoint-resume');assert checkpoint['differentProcessRecovered'] and checkpoint['checkpointAcknowledged'] and checkpoint['lateInputPreserved']
            checkpoint.update({'commitResponseTcpDropped':True,'ownerRecordResponseTcpDropped':True,'exactReplay':ack_dropped['checkpointReplayVerified'],'oldCheckpointRejected':True,'activeRoomAndReadScopeRejected':True,'requestFieldsBound':True})
            if '--late-save' in sys.argv:
                assert '--images' in sys.argv
                late=journal('checkpoint-late-save');assert late['revision']==layout_revision+2 and late['lateWidthSaved'] and late['assetReused'] and late['imageIntentsCleared'];checkpoint['lateSave']=late
                if '--noop' in sys.argv:
                    no_op_dropped=journal('checkpoint-noop-drop');assert no_op_dropped['tcpResponseDropped'] and no_op_dropped['pendingPreserved']
                    no_op=journal('checkpoint-noop-resume');assert no_op['revision']==late['revision'] and no_op['signedReceiptVerified'] and no_op['pendingCleared'];checkpoint['unchanged']=no_op
        else: checkpoint = journal('checkpoint-v2') if '--checkpoint' in sys.argv else None
        if checkpoint: assert checkpoint['revision']==layout_revision+1 and checkpoint['exactReplay'] and checkpoint['oldCheckpointRejected'] and checkpoint['paperSettingsPreserved']
        revision = checkpoint.get('lateSave',{}).get('revision',checkpoint['revision']) if checkpoint else layout_revision
        assert cli('validate',bundle)['valid']
        output=root/'result.docx'; cli('export',bundle,'--revision',revision,'--output',output)
        with zipfile.ZipFile(output) as doc:
            ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            sections=ET.fromstring(doc.read('word/document.xml')).findall('.//w:sectPr',ns)
            assert int(sections[0].find('w:pgSz',ns).attrib['{'+ns['w']+'}w'])==width+20
            if checkpoint:
                for prefix in ('word/document.xml','word/header','word/footer'):
                    assert any(b'V2 text' in doc.read(name) for name in doc.namelist() if name.startswith(prefix) and name.endswith('.xml'))
            if '--images' in sys.argv:
                assert checkpoint['image']['assetHash'] in {hashlib.sha256(doc.read(name)).hexdigest() for name in doc.namelist() if name.startswith('word/media/')}
                extents=[node for name in doc.namelist() if name.startswith('word/header') and name.endswith('.xml') for node in ET.fromstring(doc.read(name)).iter('{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent')]
                assert any(int(node.attrib['cx'])==(checkpoint['image']['lateWidth'] if '--late-save' in sys.argv else checkpoint['image']['committedWidth']) for node in extents)
                if '--late-save' in sys.argv: assert any(b'Late after v2 capture' in doc.read(name) for name in doc.namelist() if name.startswith('word/header') and name.endswith('.xml'))
        packed=root/'offline.hcdz'; offline=root/'offline.hcd'; cli('pack',bundle,'--output',packed); cli('unpack',packed,'--output',offline); assert cli('validate',offline)['valid']
        if '--late-save' in sys.argv:
            assert cli('editor-state',offline,'--revision',revision)==cli('editor-state',bundle,'--revision',revision)
            assert cli('get-image',offline,checkpoint['image']['nodeId'])==cli('get-image',bundle,checkpoint['image']['nodeId'])
        out=repo/('docs/assets/hcd-word-checkpoint-request-proof-2026-10-28' if '--request-proof' in sys.argv else 'docs/assets/hcd-word-checkpoint-unbound-2026-10-27' if '--unbound' in sys.argv else 'docs/assets/hcd-word-checkpoint-same-author-2026-10-27' if '--same-author' in sys.argv else 'docs/assets/hcd-word-checkpoint-attribution-2026-10-27' if '--attribution' in sys.argv else 'docs/assets/hcd-word-checkpoint-unchanged-2026-10-27' if '--noop' in sys.argv else 'docs/assets/hcd-word-checkpoint-late-save-2026-10-27' if '--late-save' in sys.argv else 'docs/assets/hcd-word-checkpoint-image-recovery-2026-10-27' if '--images' in sys.argv else 'docs/assets/hcd-word-checkpoint-recovery-2026-10-27' if '--checkpoint-drop' in sys.argv else 'docs/assets/hcd-word-layout-checkpoint-2026-10-27' if checkpoint else 'docs/assets/hcd-word-layout-coordinator-2026-10-27');out.mkdir(parents=True,exist_ok=True)
        (out/'http.json').write_text(json.dumps({'protocol':'hcd-word-regions/2','actualCoordinatorFunction':True,'commitResponseTcpDropped':True,'pendingJournalPreserved':True,'differentNodeProcessRecovered':True,'layoutRevision':layout_revision,'finalRevision':revision,'signedReceiptChecked':True,'fencedHeadProjectionMatchesReceipt':True,'ordinaryAndUnfencedReadRejected':True,'lateHeaderDraftPreserved':True,'checkpoint':checkpoint,'docxWidthVerified':True,'docxRegionsVerified':bool(checkpoint),'hcdzValidated':True,'activeRoomOrBrowser':'not implemented'},indent=2)+'\n')
    finally:
        process.terminate()
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
