#!/usr/bin/env python3
"""Real native API + sidecar sockets, packet gate, restart and file readback."""
import hashlib,json,os,posixpath,runpy,secrets,socket,subprocess,tempfile,time,urllib.request,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

def main():
    repo=Path(__file__).resolve().parents[1];binary=repo/'target/debug/officecli';root=Path(tempfile.mkdtemp(prefix='hcd-sidecar-migration-'))
    helpers=runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'));helpers['fixtures'](root);(root/'red.png').write_bytes(helpers['png']([255,0,0]))
    env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
    def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
    cli('import',root/'fixture.docx','--output',root/'doc.hcd','--document-id','doc');(root/'sources').mkdir();(root/'sources/doc.docx').write_bytes((root/'fixture.docx').read_bytes());cli('project-editor',root/'doc.hcd','--expected-revision',0)
    ports=[]
    for _ in range(2):
        with socket.socket() as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
    config={'root':str(root),'apiUrl':f'http://127.0.0.1:{ports[0]}/v1/documents/doc','collabPort':ports[1],'collabUrl':f'ws://127.0.0.1:{ports[1]}','secret':env['HCD_TOKEN_SECRET']}
    for user in ['alice','bob']:config[user]=cli('issue-token','--document-id','doc','--scope','write','--user-id',user,'--ttl-seconds',3600)['token']
    cli('import',root/'fixture.docx','--output',root/'unknown.hcd','--document-id','unknown');(root/'sources/unknown.docx').write_bytes((root/'fixture.docx').read_bytes());cli('project-editor',root/'unknown.hcd','--expected-revision',0)
    config['unknownToken']=cli('issue-token','--document-id','unknown','--scope','write','--user-id','alice','--ttl-seconds',3600)['token']
    private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600)
    log=open(root/'api.log','wb');process=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'],env=env,stdout=log,stderr=log)
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(100):
            try:opener.open(urllib.request.Request(config['apiUrl']+'/auth',headers={'Authorization':'Bearer '+config['alice']}),timeout=1).close();break
            except OSError:time.sleep(.1)
        else:raise RuntimeError('native API did not start')
        subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-sidecar-migration.mts'),str(private)],cwd=repo,check=True,timeout=180)
        evidence=json.loads((root/'sidecar-migration-evidence.json').read_text())
        for item in evidence['files']:
            path=root/item['name']
            if path.suffix=='.md':
                bundle=root/'markdown-roundtrip.hcd';cli('import',path,'--output',bundle,'--document-id','roundtrip');projection=cli('editor-state',bundle)
                def text_of(content):return ''.join(part['text'] for part in content.get('inlines',[]))+'\n'+''.join(text_of(child) for child in content.get('children',[]))
                text='\n'.join(text_of(block['content']) for block in projection['blocks']);item['markdownReimportVerified']=True
            else:text=subprocess.check_output([str(binary),'view',str(path),'text'],text=True,timeout=60)
            for required in item.get('requiredText',['Held input!','Peer!']):assert required in text,(path.name,text)
            for forbidden in item.get('forbiddenText',[]):assert forbidden not in text,(path.name,text)
            if item.get('onceText'):assert text.count(item['onceText'])==1,(path.name,text)
            assert 'Wrong protocol' not in text and 'hcdTextBoundary' not in text
            if path.suffix=='.docx':
                with zipfile.ZipFile(path) as archive:
                    ns={'a':'http://schemas.openxmlformats.org/drawingml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
                    body=ET.fromstring(archive.read('word/document.xml'));blip=body.find('.//a:blip',ns);assert blip is not None
                    relationships={node.attrib['Id']:node.attrib['Target'] for node in ET.fromstring(archive.read('word/_rels/document.xml.rels'))};target=relationships[blip.attrib['{'+ns['r']+'}embed']]
                    part=target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('word',target))
                    assert hashlib.sha256(archive.read(part)).hexdigest()==item.get('expectedAsset',evidence['replacementAsset'])
            item.update(actualFileVerified=True,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),text=text)
        evidence['validation'].update(actualFilesReadBack=True)
        destination=repo/'docs/assets/hcd-workbench-2026-10-23/sidecar-migration-api-evidence.json';destination.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
        print(f'PASS sidecar migration, socket peers and {len(evidence["files"])} real exports; evidence: {destination}')
    finally:
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        log.close()
        for port in ports:
            with socket.socket() as probe:probe.settimeout(.2);assert probe.connect_ex(('127.0.0.1',port))!=0,'owned service still listening'
    evidence['validation']['isolatedServicesStopped']=True;destination.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__':main()
