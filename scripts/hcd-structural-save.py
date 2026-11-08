#!/usr/bin/env python3
"""Verify structural binding -> real native API -> actual exported documents.
Uses in-process Yjs peers, not a browser or live Hocuspocus room migration.
"""
import hashlib,json,os,runpy,secrets,socket,subprocess,tempfile,time,urllib.request,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

def main():
    repo=Path(__file__).resolve().parents[1];binary=repo/'target/debug/officecli';root=Path(tempfile.mkdtemp(prefix='hcd-structural-save-'))
    runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'))['fixtures'](root)
    env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
    def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
    cli('import',root/'fixture.docx','--output',root/'doc.hcd','--document-id','doc');(root/'sources').mkdir();(root/'sources/doc.docx').write_bytes((root/'fixture.docx').read_bytes());cli('project-editor',root/'doc.hcd','--expected-revision',0)
    with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    config={'root':str(root),'apiUrl':f'http://127.0.0.1:{port}/v1/documents/doc','secret':env['HCD_TOKEN_SECRET']}
    for user in ['alice','bob','hcd-collaboration']:config[user]=cli('issue-token','--document-id','doc','--scope','write','--user-id',user,'--ttl-seconds',3600)['token']
    private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600)
    log=open(root/'api.log','wb');process=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{port}'],env=env,stdout=log,stderr=log)
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(100):
            try:opener.open(urllib.request.Request(config['apiUrl']+'/auth',headers={'Authorization':'Bearer '+config['alice']}),timeout=1).close();break
            except OSError:time.sleep(.1)
        else:raise RuntimeError('isolated native API did not start')
        subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-structural-save.mts'),str(private)],cwd=repo,check=True,timeout=180)
        evidence=json.loads((root/'structural-save-evidence.json').read_text())
        for phase in evidence['files']:
            path=root/phase['name']
            if path.suffix=='.md':
                bundle=root/(path.stem+'-markdown-roundtrip.hcd');cli('import',path,'--output',bundle,'--document-id','markdown-roundtrip')
                projection=cli('editor-state',bundle)
                def content_text(content):return ''.join(part['text'] for part in content.get('inlines',[]))+'\n'+''.join(content_text(child) for child in content.get('children',[]))
                text='\n'.join(content_text(block['content']) for block in projection['blocks']);phase['markdownReimportVerified']=True
            else:text=subprocess.check_output([str(binary),'view',str(path),'text'],text=True,timeout=60)
            expected=phase['order'];positions=[text.index(value) for value in expected];assert positions==sorted(positions),(path.name,text)
            if path.suffix=='.docx':
                with zipfile.ZipFile(path) as archive:
                    body=ET.fromstring(archive.read('word/document.xml'));ns={'a':'http://schemas.openxmlformats.org/drawingml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
                    blip=body.find('.//a:blip',ns);assert blip is not None,'source image missing'
                    relations={node.attrib['Id']:node.attrib['Target'] for node in ET.fromstring(archive.read('word/_rels/document.xml.rels'))};target=relations[blip.attrib['{'+ns['r']+'}embed']]
                    import posixpath
                    part=target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('word',target))
                    assert hashlib.sha256(archive.read(part)).hexdigest()==evidence['originalAssetHash']
            phase.update(actualFileVerified=True,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),text=text)
        evidence['validation']={'bindingAndNativeAPI':True,'actualFilesReadBack':True,'browser':False,'hocuspocusRoomMigration':False,'production':False}
        destination=repo/'docs/assets/hcd-workbench-2026-10-23/structural-save-api-evidence.json';destination.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
        print(f'PASS native structural saves and {len(evidence["files"])} actual exports; evidence: {destination}')
    finally:
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        log.close()
        with socket.socket() as probe:probe.settimeout(.2);assert probe.connect_ex(('127.0.0.1',port))!=0,'isolated API still running'
    evidence['validation']['isolatedAPIStopped']=True
    destination.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')

if __name__=='__main__':main()
