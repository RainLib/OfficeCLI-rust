#!/usr/bin/env python3
"""Native API and independent Office XML/PDF checks for conflict decision history."""
import argparse,hashlib,io,json,os,posixpath,runpy,secrets,socket,subprocess,tempfile,time,urllib.request,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

def verify(root,evidence):
    ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','wp':'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing','p':'http://schemas.openxmlformats.org/presentationml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
    for item in evidence:
        kind=item['format']
        for phase in item['phases']:
            data=(root/f"choice-{kind}-{phase['name']}.{kind}").read_bytes();geometry=phase['image']['geometry'];factor=12700 if geometry['unit']=='emu' else 1
            if kind!='pdf':
                part='word/document.xml' if kind=='docx' else 'ppt/slides/slide1.xml'
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    body=ET.fromstring(archive.read(part));assert phase['text'] in ''.join(body.itertext())
                    relations={node.attrib['Id']:node.attrib['Target'] for node in ET.fromstring(archive.read(posixpath.join(posixpath.dirname(part),'_rels',posixpath.basename(part)+'.rels')))}
                    target=relations[body.find('.//a:blip',ns).attrib['{'+ns['r']+'}embed']];path=target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(posixpath.dirname(part),target))
                    assert hashlib.sha256(archive.read(path)).hexdigest()==phase['image']['assetHash']
                    extent=body.find('.//wp:extent',ns) if kind=='docx' else body.find('.//p:pic/p:spPr/a:xfrm/a:ext',ns)
                    assert int(extent.attrib['cx'])==round(geometry['width']*12700/factor);assert int(extent.attrib['cy'])==round(geometry['height']*12700/factor)
                    if kind=='pptx':
                        offset=body.find('.//p:pic/p:spPr/a:xfrm/a:off',ns);assert int(offset.attrib['x'])==round(geometry['x']*12700/factor);assert int(offset.attrib['y'])==round(geometry['y']*12700/factor)
            else:
                from pypdf import PdfReader
                from pypdf.generic import ContentStream
                reader=PdfReader(io.BytesIO(data));page=reader.pages[0];assert phase['text'] in page.extract_text();matrix=(1.,0.,0.,1.,0.,0.);stack=[];draws=[]
                for operands,operator in ContentStream(page.get_contents(),reader).operations:
                    if operator==b'q':stack.append(matrix)
                    elif operator==b'Q':matrix=stack.pop()
                    elif operator==b'cm':
                        a,b,c,d,e,f=map(float,operands);A,B,C,D,E,F=matrix;matrix=(a*A+b*C,a*B+b*D,c*A+d*C,c*B+d*D,e*A+f*C+E,e*B+f*D+F)
                    elif operator==b'Do':draws.append((operands[0],matrix))
                assert len(draws)==1;name,ctm=draws[0];image=page['/Resources']['/XObject'][name].get_object();assert image.get_data()==({'red':bytes([255,0,0]),'green':bytes([0,255,0])}[phase['color']])
                assert abs(abs(ctm[0])-geometry['width'])<.001;assert abs(abs(ctm[3])-geometry['height'])<.001;assert abs(ctm[4]-geometry['x'])<.001;assert abs(ctm[5]-(float(page.mediabox.height)-geometry['y']-geometry['height']))<.001
            phase['actualFileVerified']=True;phase['positionVerified']=kind!='docx'
        print(f'PASS {kind}: independently verified all three exported files')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--binary',type=Path,default=Path('target/debug/officecli'));args=parser.parse_args();repo=Path(__file__).resolve().parents[1];binary=args.binary.resolve();root=Path(tempfile.mkdtemp(prefix='hcd-fixed-choice-'));helpers=runpy.run_path(str(repo/'scripts/hcd-fixed-image-transaction.py'));helpers['fixtures'](root)
    for name,rgb in [('red',[255,0,0]),('green',[0,255,0])]: (root/f'{name}.png').write_bytes(helpers['png'](rgb))
    (root/'sources').mkdir();env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
    def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
    with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
    config={'root':str(root),'apiUrl':f'http://127.0.0.1:{port}/v1/documents','documents':[]}
    for kind in ['docx','pptx','pdf']:
        doc='choice-'+kind;source=root/f'fixture.{kind}';bundle=root/f'{doc}.hcd';cli('import',source,'--output',bundle,'--document-id',doc);(root/f'sources/{doc}.{kind}').write_bytes(source.read_bytes())
        entry={'documentId':doc,'format':kind,'text':next(row for row in cli('extract-text',bundle)['entries'] if row['text'].strip())}
        for key,user in [('token','choice-writer'),('peerToken','choice-peer')]:entry[key]=cli('issue-token','--document-id',doc,'--scope','write','--user-id',user,'--ttl-seconds',3600)['token']
        config['documents'].append(entry)
    private=root/'private.json';private.write_text(json.dumps(config));private.chmod(0o600)
    with open(root/'api.log','wb') as log:server=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{port}'],env=env,stdout=log,stderr=log)
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for _ in range(100):
            try:opener.open(urllib.request.Request(config['apiUrl']+'/'+config['documents'][0]['documentId']+'/auth',headers={'Authorization':'Bearer '+config['documents'][0]['token']}),timeout=1).close();break
            except OSError:time.sleep(.05)
        else:raise RuntimeError('isolated API did not start')
        subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-fixed-choice-history.mts'),str(private)],cwd=repo,check=True,timeout=180)
        evidence=json.loads((root/'fixed-choice-evidence.json').read_text());verify(root,evidence);(root/'fixed-choice-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('Evidence:',root/'fixed-choice-evidence.json')
    finally:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:server.kill();server.wait()
if __name__=='__main__':main()
