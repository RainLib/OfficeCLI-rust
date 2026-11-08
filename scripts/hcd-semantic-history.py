#!/usr/bin/env python3
"""Verify the real Word history adapter and exported DOCX active relationships."""
import argparse,hashlib,io,json,os,posixpath,runpy,secrets,socket,subprocess,tempfile,time,urllib.request,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

def verify(root,evidence):
    namespaces={'a':'http://schemas.openxmlformats.org/drawingml/2006/main','wp':'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships','w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    for phase in evidence['phases']:
        with zipfile.ZipFile(root/(phase['name']+'.docx')) as archive:
            body=ET.fromstring(archive.read('word/document.xml'));text=''.join(node.text or '' for node in body.findall('.//w:t',namespaces))
            assert 'Peer!' in text
            if phase['name']=='undo-text':assert 'Original' in text and 'Own' not in text
            if phase['name'].startswith('redo-'):assert 'Own' in text
            blip=body.find('.//a:blip',namespaces);relations={node.attrib['Id']:node.attrib['Target'] for node in ET.fromstring(archive.read('word/_rels/document.xml.rels'))}
            target=relations[blip.attrib['{'+namespaces['r']+'}embed']];path=target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('word',target))
            assert hashlib.sha256(archive.read(path)).hexdigest()==phase['image']['assetHash']
            extent=body.find('.//wp:extent',namespaces);assert int(extent.attrib['cx'])==round(phase['image']['geometry']['width']);assert int(extent.attrib['cy'])==round(phase['image']['geometry']['height'])
        phase['actualFileVerified']=True
    print(f"PASS all {len(evidence['phases'])} DOCX exports: real text, active image bytes, own width and peer height")

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--binary',type=Path,default=Path('target/debug/officecli'));args=parser.parse_args();repo=Path(__file__).resolve().parents[1];binary=args.binary.resolve();root=Path(tempfile.mkdtemp(prefix='hcd-semantic-history-'))
    helpers=runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'));helpers['fixtures'](root);(root/'red.png').write_bytes(helpers['png']([255,0,0]));(root/'green.png').write_bytes(helpers['png']([0,255,0]))
    env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
    def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
    cli('import',root/'fixture.docx','--output',root/'doc.hcd','--document-id','doc');(root/'sources').mkdir();(root/'sources/doc.docx').write_bytes((root/'fixture.docx').read_bytes());cli('project-editor',root/'doc.hcd','--expected-revision',0)
    ports=[]
    for _ in range(2):
        with socket.socket() as probe:probe.bind(('127.0.0.1',0));ports.append(probe.getsockname()[1])
    config={'root':str(root),'apiUrl':f'http://127.0.0.1:{ports[0]}/v1/documents','collabUrl':f'ws://127.0.0.1:{ports[1]}'}
    for user in ['alice','bob']:config[user]=cli('issue-token','--document-id','doc','--scope','write','--user-id',user,'--ttl-seconds',3600)['token']
    private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600);processes=[];logs=[]
    try:
        for name,command,extra in [('api',[str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{ports[0]}'],{}),('sidecar',['node','--import','tsx','sidecar.ts'],{'HCD_API_URL':f'http://127.0.0.1:{ports[0]}','HCD_COLLAB_PORT':str(ports[1])})]:
            log=open(root/f'{name}.log','wb');logs.append(log);processes.append(subprocess.Popen(command,cwd=repo/'examples/hdoc/editor',env={**env,**extra},stdout=log,stderr=log))
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(100):
            try:
                opener.open(urllib.request.Request(config['apiUrl']+'/doc/auth',headers={'Authorization':'Bearer '+config['alice']}),timeout=1).close()
                with socket.create_connection(('127.0.0.1',ports[1]),timeout=1):pass
                break
            except OSError:time.sleep(.1)
        else:raise RuntimeError('isolated services did not start')
        subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-semantic-history.mts'),str(private)],cwd=repo,check=True,timeout=180)
        evidence=json.loads((root/'semantic-history-evidence.json').read_text());verify(root,evidence);(root/'semantic-history-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('Evidence:',root/'semantic-history-evidence.json')
    finally:
        for process in reversed(processes):
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        for log in logs:log.close()
if __name__=='__main__':main()
