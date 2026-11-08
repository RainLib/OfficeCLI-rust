#!/usr/bin/env python3
"""Exercise reserved v2 native layout submission on a disposable bundle."""
import http.client, http.server, json, os, secrets, socket, subprocess, tempfile, threading, time, urllib.error, urllib.parse, urllib.request, zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

repo = Path(__file__).resolve().parents[1]
binary = repo / 'target/debug/officecli'
archive = repo / 'docs/assets/hcd-word-layout-receipt-2026-10-27/layout-r7.hcdz'
projection = json.loads((repo / 'docs/assets/hcd-word-layout-transition-2026-10-27/projection-r7.json').read_text())
env = {**os.environ, 'HCD_TOKEN_SECRET': secrets.token_hex(32), 'NO_COLOR': '1'}
def cli(*args):
    return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
with tempfile.TemporaryDirectory(prefix='layout-submit-',dir=repo/'target') as path:
    root=Path(path);bundle=root/'region-test.hcd';cli('unpack',archive,'--output',bundle)
    token=cli('issue-token','--document-id','region-test','--scope','write','--user-id','hcd-collaboration')['token']
    writer=cli('issue-token','--document-id','region-test','--scope','write','--user-id','alice')['token']
    with socket.socket() as probe: probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    origin=f'http://127.0.0.1:{port}/v1/documents/region-test'
    process=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{port}'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    def request(route,body,auth=token,headers=None,target=None):
        h={'Authorization':'Bearer '+auth,'Content-Type':'application/json','X-HCD-Collaboration-Epoch':'0','X-HCD-Collaboration-Protocol':'hcd-word-regions/2','X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1',**(headers or {})}
        try:
            with urllib.request.urlopen(urllib.request.Request((target or origin)+route,data=json.dumps(body).encode(),headers=h),timeout=30) as response:return response.status,json.loads(response.read())
        except urllib.error.HTTPError as error:return error.code,error.read().decode()
    try:
        deadline=time.monotonic()+30
        while True:
            assert process.poll() is None
            try:
                with urllib.request.urlopen(urllib.request.Request(origin,headers={'Authorization':'Bearer '+token}),timeout=3) as response:
                    if response.status==200:break
            except urllib.error.URLError:pass
            assert time.monotonic()<deadline;time.sleep(.05)
        layout=projection['flowLayout'];section=layout['sections'][0];width=section['page']['widthTwips']
        tx={'schemaVersion':'hcd-word-layout-transaction/1','documentId':'region-test','transactionId':'9'*32,'baseRevision':7,'expectedRevision':7,'actor':{'userId':'alice','displayName':'Alice'},'edits':{'schemaVersion':'hcd-word-layout-edits/1','baseLayoutHash':projection['flowLayoutHash'],'changes':[{'sectionId':section['id'],'field':'widthTwips','expected':width,'value':width+20}]}}
        body={'coordinatorId':'e'*32,'transaction':tx}
        fixture_path=root/'layout-fixture.json'
        fixture={'previous':projection,'next':projection,'previousRoot':cli('get-revision',bundle,7)['rootHash'],'request':tx,'apiUrl':origin,'protocol':'hcd-word-regions/2','storeId':'c'*32}
        fixture_path.write_text(json.dumps(fixture,ensure_ascii=False));fixture_path.chmod(0o600);env['HCD_TEST_TOKEN']=token
        def journal(stage):
            result=subprocess.run(['node','--import','tsx',str(repo/'scripts/hcd-word-layout-journal-http.mts'),stage,str(root/'journal'),str(fixture_path)],cwd=repo/'examples/hdoc/editor',env=env,capture_output=True,text=True,timeout=30)
            if result.returncode:raise RuntimeError(result.stderr[-4000:])
            return json.loads(result.stdout)
        prepared=journal('prepare')
        collab=root/'collaboration';collab.mkdir(exist_ok=True);meta=collab/'region-test.epoch'
        meta.write_text(json.dumps({'epoch':0,'protocol':'hcd-word-regions/1'}))
        assert request('/word/layout-transactions',body,headers={'X-HCD-Collaboration-Protocol':'hcd-word-regions/1'})[0]==426
        meta.write_text(json.dumps({'epoch':0,'protocol':'hcd-word-regions/2'}))
        assert request('/word/layout-transactions',body,writer)[0]==426
        assert request('/word/layout-transactions',body)[0]==409
        owner={'version':1,'epoch':0,'ownerId':'b'*32,'storeId':'c'*32,'action':'acquire','journalHashes':['none']}
        status,lease=request('/collaboration/word-owner',owner,headers={'X-HCD-Coordinator-Version':'5'});assert status==200
        owner.update({'action':'record','leaseId':lease['leaseId'],'journalHashes':['none',prepared['tip']]})
        status,lease=request('/collaboration/word-owner',owner,headers={'X-HCD-Coordinator-Version':'5'});assert status==200
        fenced={'X-HCD-Word-Owner':lease['leaseId'],'X-HCD-Word-Owner-Id':lease['ownerId'],'X-HCD-Word-Journal-Hash':lease['journalHash']}
        observed={}
        class DropAfterCommit(http.server.BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_POST(self):
                data=self.rfile.read(int(self.headers['Content-Length']))
                upstream=http.client.HTTPConnection('127.0.0.1',port,timeout=30)
                try:
                    upstream.request('POST',self.path,body=data,headers={k:v for k,v in self.headers.items() if k.lower()!='host'})
                    response=upstream.getresponse();observed['status']=response.status;observed['body']=json.loads(response.read())
                    self.close_connection=True;self.connection.shutdown(socket.SHUT_RDWR);self.connection.close()
                finally:upstream.close()
        proxy=http.server.ThreadingHTTPServer(('127.0.0.1',0),DropAfterCommit);thread=threading.Thread(target=proxy.serve_forever,daemon=True);thread.start()
        try:
            try:request('/word/layout-transactions',body,headers=fenced,target=f'http://127.0.0.1:{proxy.server_port}'+urllib.parse.urlparse(origin).path)
            except (http.client.RemoteDisconnected,urllib.error.URLError,ConnectionResetError):pass
            else:raise AssertionError('client unexpectedly received the committed response')
        finally:proxy.shutdown();proxy.server_close();thread.join(timeout=5)
        assert observed.get('status')==200 and observed['body']['revision']==8 and observed['body']['idempotentReplay'] is False
        status,replay=request('/word/layout-transactions',body,headers=fenced);assert status==200 and replay['revision']==8 and replay['idempotentReplay'] is True
        forged=json.loads(json.dumps(body));forged['transaction']['edits']['changes'][0]['value']=width+40
        assert request('/word/layout-transactions',forged,headers=fenced)[0]>=400
        stale=json.loads(json.dumps(body));stale['transaction']['transactionId']='f'*32
        assert request('/word/layout-transactions',stale,headers=fenced)[0]==409
        status,receipt=request('/word/layout-receipt',body,headers=fenced);assert status==200 and receipt['revision']==8
        fixture.update({'next':receipt.pop('projection'),'receipt':receipt,'record':cli('get-revision',bundle,8),'header':prepared['header']});fixture_path.write_text(json.dumps(fixture,ensure_ascii=False))
        owner['action']='release';assert request('/collaboration/word-owner',owner,headers={'X-HCD-Coordinator-Version':'5'})[0]==200
        interrupted=journal('recover');assert interrupted['tcpResponseDropped'] and interrupted['receiptCalls']==1
        recovered=journal('resume');assert recovered['revision']==8 and recovered['tip']==interrupted['tip'] and recovered['receiptCalls']==0 and recovered['lateTextPreserved']
        final=journal('verify');assert final['revision']==8 and final['legacyReaderRejected'] and final['lateTextPreserved']
        assert cli('validate',bundle)['valid'];output=root/'result.docx';cli('export',bundle,'--revision',8,'--output',output)
        with zipfile.ZipFile(output) as doc:
            ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'};sections=ET.fromstring(doc.read('word/document.xml')).findall('.//w:sectPr',ns)
            assert int(sections[0].find('w:pgSz',ns).attrib['{'+ns['w']+'}w'])==width+20
        packed=root/'offline.hcdz';offline=root/'offline.hcd';cli('pack',bundle,'--output',packed);cli('unpack',packed,'--output',offline);assert cli('validate',offline)['valid']
        out=repo/'docs/assets/hcd-word-layout-submit-2026-10-27';out.mkdir(parents=True,exist_ok=True)
        (out/'http.json').write_text(json.dumps({'protocol':'hcd-word-regions/2','oldRoomRejected':True,'noOwnerRejected':True,'ordinaryWriterRejected':True,'revision':8,'layoutCommitResponseTcpDropped':True,'replaySameRevision':True,'alteredRequestRejected':True,'staleHeadRejected':True,'signedReceipt':True,'actualSignedJournal':True,'ownerRecordResponseTcpDropped':interrupted['tcpResponseDropped'],'recoveredWithoutReceiptRetry':recovered['receiptCalls']==0,'lateHeaderDraftPreserved':final['lateTextPreserved'],'docxWidthVerified':True,'hcdzValidated':True,'browserMigration':'not implemented'},indent=2)+'\n')
    finally:
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait()
