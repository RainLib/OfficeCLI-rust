#!/usr/bin/env python3
"""Isolated native people/reference API, socket preservation and real exports.
No organization service, browser @ menu or notification delivery is simulated.
"""
import hashlib,json,os,runpy,secrets,shutil,socket,subprocess,tempfile,time,urllib.request,urllib.error,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

def main():
    repo=Path(__file__).resolve().parents[1];binary=repo/'target/debug/officecli';root=Path(tempfile.mkdtemp(prefix='hcd-people-references-'))
    runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'))['fixtures'](root)
    env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
    def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,text=True,capture_output=True,check=True,timeout=120).stdout)['data']
    bundle=root/'doc.hcd';cli('import',root/'fixture.docx','--output',bundle,'--document-id','doc');cli('project-editor',bundle,'--expected-revision',0);(root/'sources').mkdir();shutil.copy(root/'fixture.docx',root/'sources/doc.docx')
    tokens={actor:cli('issue-token','--document-id','doc','--scope','write' if actor!='reader' else 'read','--user-id',actor,'--display-name',actor.title(),'--ttl-seconds',3600)['token'] for actor in ['alice','bob','reader']}
    ports=[]
    for _ in range(2):
        with socket.socket() as s:s.bind(('127.0.0.1',0));ports.append(s.getsockname()[1])
    origin='http://127.0.0.1:'+str(ports[0]);base=origin+'/v1/documents/doc';opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(path,body=None,actor='alice',method=None,expected=200):
        headers={'X-HCD-Node-Edits-Version':'4','Authorization':'Bearer '+tokens[actor],'X-HCD-Reference-Version':'1'}
        if body is not None:headers['Content-Type']='application/json'
        try:
            response=opener.open(urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method),timeout=90);raw=response.read();status=response.status
            if status==200 and (path.startswith('/mention-options') or path.startswith('/references')):assert response.headers.get('Cache-Control')=='no-store'
        except urllib.error.HTTPError as error:status=error.code;raw=error.read()
        assert status==expected,(path,status,raw[:500]);return json.loads(raw) if raw[:1] in [b'{',b'['] else raw
    log=open(root/'api.log','wb');process=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'],env=env,stdout=log,stderr=log)
    evidence={'version':'hcd-people-references-api/1','scope':'Local native API, configured document people directory, real structural socket save and actual exported files. No browser menu, live identity provider, PG or notification delivery acceptance.','validation':{},'files':[]}
    try:
        for _ in range(100):
            try:request('/auth');break
            except OSError:time.sleep(.1)
        else:raise RuntimeError('native service did not start')
        request('/mention-options?kind=person',expected=503)
        (root/'people').mkdir();directory={'schemaVersion':'hcd-people/1','generation':1,'people':[{'id':'person-a','label':'Same Name','detail':'Alpha','active':True,'visibleTo':['alice'],'mentionableBy':['alice']},{'id':'person-b','label':'Same Name','detail':'Beta','active':True,'visibleTo':['bob']},{'id':'offline','label':'Offline person','active':True}]};(root/'people/doc.json').write_text(json.dumps(directory))
        a=request('/mention-options?kind=person&q=Same');b=request('/mention-options?kind=person&q=Same',actor='bob');assert a['items'][0]['id']=='person-a' and b['items'][0]['id']=='person-b';assert a['items'][0]['label']==b['items'][0]['label'];evidence['validation']['homonymsAndViewerScope']=True
        resolved=request('/references/resolve',{'targets':[{'kind':'person','id':'person-b'},{'kind':'person','id':'unknown'}]});assert [v['status'] for v in resolved['items']]==['restricted','restricted'];assert all('label' not in item for item in resolved['items']);evidence['validation']['restrictedResolutionDoesNotLeakName']=True;evidence['validation']['privateReferenceResponsesNotCached']=True
        assert request('/references')['items']==[]
        def reference(number):return {'type':'hcd.mention','version':1,'mentionId':'m_'+format(number,'032x'),'target':{'kind':'person','id':'person-a'},'snapshot':{'label':'Same Name'}}
        def insert(number,revision,target='person-a'):
            ref=reference(number);ref['target']['id']=target
            first=request('/editor')['blocks'][0]['blockId']
            return {'schemaVersion':'hcd-patch/4','documentId':'doc','patchId':'mention-'+str(number)+'-'+str(revision)+'-'+target,'baseRevision':revision,'actor':{'userId':'forged-author','displayName':'Forged'},'operations':[{'op':'block.insert','afterBlockId':first,'block':{'kind':'paragraph','inlines':[{'text':'@Same Name','reference':ref}]}}]}
        first_patch=insert(1,1);first_patch['patchId']='restore-0-2';request('/patch',first_patch,expected=400);assert request('')['revision']==1;evidence['validation']['reservedRestoreIdRejectedBeforeCommit']=True;request('/patch',insert(1,1),expected=200);created=request('/references');assert created['revision']==2 and len(created['items'])==1;assert created['transition']['events'][0]['kind']=='reference.created';assert created==request('/references');assert created['transition']['events'][0]['context']['actorId']=='alice';assert created['transition']['source']=='content';evidence['validation']['sourceIsNotTrustedFromPatchId']=True;evidence['validation']['committedQueriesAndStableEventIds']=True;evidence['validation']['eventActorComesFromAuthentication']=True
        request('/patch',insert(1,2),expected=400);request('/patch',insert(2,2,'person-b'),expected=403);assert request('')['revision']==2
        request('/patch',insert(2,2));copied=request('/references');assert len(copied['items'])==2;assert len({v['reference']['mentionId'] for v in copied['items']})==2;evidence['validation']['duplicateIdsRejectedAndCopiesDistinct']=True
        request('/restore/1',{'expectedRevision':3});deleted=request('/references');assert deleted['revision']==4 and deleted['items']==[] and len(deleted['transition']['events'])==2 and deleted['transition']['source']=='restore'
        request('/restore/3',{'expectedRevision':4});restored=request('/references');assert restored['revision']==5 and len(restored['items'])==2;assert restored['reminders']=={'enabled':False,'delivery':'disabled'};evidence['validation']['restorePreservesOccurrencesWithoutNotifications']=True
        for at in [2,3,5]:
            indexed=request('/references?revision='+str(at)+'&locations=true')
            for item in indexed['items']:
                assert isinstance(item['chunkSequence'],int) and isinstance(item['indexPage'],int)
                chunk=request('/chunks/'+str(item['chunkSequence'])+'?revision='+str(at));assert chunk['revision']==at
                found=[json.loads(element.attrib['data-hcd-reference'])['mentionId'] for element in ET.fromstring(chunk['html']).iter('span') if 'data-hcd-reference' in element.attrib]
                assert item['reference']['mentionId'] in found
        evidence['validation']['immutableReferenceLocationsMatchOriginalChunks']=True
        (root/'people/doc.json').unlink();request('/mention-options?kind=person',expected=503);assert len(request('/references')['items'])==2
        config={'root':str(root),'origin':origin,'collabPort':ports[1],'secret':env['HCD_TOKEN_SECRET'],'alice':tokens['alice'],'bob':tokens['bob']};private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600)
        subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-people-references.mts'),str(private)],cwd=repo,check=True,timeout=120)
        evidence['validation'].update(json.loads((root/'socket-evidence.json').read_text()));revision=request('')['revision']
        collaboration=json.loads((root/'collaborative-reference-evidence.json').read_text())
        for fmt in ['docx','pdf','md']:
            path=root/('collaborative-mentions.'+fmt);text=path.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True,timeout=60)
            assert text.count('@Same Name')==4 and 'Alice unrelated input' in text,(fmt,text)
        collaboration['threeActualCollaborativeExportsReadBack']=True
        (repo/'docs/assets/hcd-mentions-2026-10-24/collaborative-reference-evidence.json').write_text(json.dumps(collaboration,indent=2)+'\n')

        for fmt in ['docx','pdf','md']:
            path=root/('mentions.'+fmt);path.write_bytes(request('/export/'+fmt+'?revision='+str(revision)));text=path.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True,timeout=60)
            assert text.count('@Same Name')==2 and 'Text saved with offline people directory' in text,(fmt,text)
            if fmt=='docx':
                with zipfile.ZipFile(path) as z:
                    images=[hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if name.startswith('word/media/')]
                with zipfile.ZipFile(root/'fixture.docx') as source:
                    expected_images=[hashlib.sha256(source.read(name)).hexdigest() for name in source.namelist() if name.startswith('word/media/')]
                assert images==expected_images,'source image bytes changed'
            evidence['files'].append({'name':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'requiredNamesVerified':True,'text':text})
        report=root/'fidelity.json';cli('export',bundle,'--output',root/'reported.docx','--revision',revision,'--fidelity-report',report);warnings=json.loads(report.read_text())['warnings'];assert sum(v['code']=='HCD_REFERENCE_FLATTENED' for v in warnings)==2;evidence['validation']['exportReportsFlattenedRelationships']=True
        # Native HCD is a directory bundle. This controlled test archive proves
        # metadata portability; it does not claim a CLI pack command exists.
        archive=root/'offline-fixture.zip'
        with zipfile.ZipFile(archive,'w') as z:
            for path in bundle.rglob('*'):
                if path.is_file():z.write(path,path.relative_to(bundle))
        offline=root/'offline.hcd';offline.mkdir()
        with zipfile.ZipFile(archive) as z:z.extractall(offline)
        projection=cli('editor-state',offline);refs=[inline['reference'] for block in projection['blocks'] for inline in block['content'].get('inlines',[]) if 'reference' in inline];assert sorted(v['mentionId'] for v in refs)==sorted(v['reference']['mentionId'] for v in restored['items']);evidence['validation']['offlineNativeBundleRetainsReferenceIdentities']=True
        evidence['validation'].update({'actualFilesReadBack':True,'notificationsDisabled':True,'browserMenu':False,'newMentionSidecarAuthorLedger':True})
    finally:
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        log.close()
        for port in ports:
            with socket.socket() as probe:probe.settimeout(.2);assert probe.connect_ex(('127.0.0.1',port))!=0,'owned service still listening'
    destination=repo/'docs/assets/hcd-mentions-2026-10-24/people-reference-api-evidence.json';destination.parent.mkdir(parents=True,exist_ok=True);evidence['validation']['ownedServicesStopped']=True;destination.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS native people/reference scopes, structural socket preservation, three exports and offline HCD identity readback; '+str(destination))

if __name__=='__main__':main()
