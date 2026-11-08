#!/usr/bin/env python3
"""Read-only native/file checks after the named CUA lazy-follow fixture.
PPT contains one explicitly saved Alice edit; PDF remains unmodified.
"""
import hashlib,json,subprocess,sys,urllib.request,uuid,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['root']);assert root.name.startswith('hcd-fixed-lazy-');binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-fixed-lazy-2026-10-25';assets.mkdir(exist_ok=True);work=root/('files-'+uuid.uuid4().hex[:8]);work.mkdir();opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 evidence={'scope':'Local native HTTP/CLI, actual Office/PDF files and native offline archive. No production/cross-platform acceptance.','root':str(root),'files':[]}
 for kind,expected in [('pptx',1),('pdf',0)]:
  doc=c['documents'][kind];bundle=root/(doc['documentId']+'.hcd');before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==expected
  req=urllib.request.Request(c['origin']+'/v1/documents/'+doc['documentId']+f'/export/{kind}?revision={expected}&source=true',headers={'Authorization':'Bearer '+doc['reader']});response=opener.open(req,timeout=180);output=work/(kind+'.'+kind);output.write_bytes(response.read());text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True)
  labels=['Alice 私有草稿 · Page 001']+[f'Page {i:03d} collaboration' for i in range(2,131)] if kind=='pptx' else [f'Page {i:03d} collaboration' for i in range(1,131)]
  assert all(text.count(label)==1 for label in labels);assert not any(name in text for name in ['Bob 李','Reader 访客','正在跟随']);entry={'format':kind,'revision':expected,'path':str(output),'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'all130PageTextsExactlyOnce':True,'presenceNotExported':True,'fidelity':response.headers.get('X-HCD-Fidelity-Level')}
  if kind=='pptx':
   with zipfile.ZipFile(root/'fixture.pptx') as source,zipfile.ZipFile(output) as office:
    assert set(source.namelist())==set(office.namelist());assert all(source.read(name)==office.read(name) for name in source.namelist() if name!='ppt/slides/slide1.xml');pictures=sum(1 for name in office.namelist() if name.startswith('ppt/slides/slide') and name.endswith('.xml') for element in ET.fromstring(office.read(name)).iter() if element.tag=='{http://schemas.openxmlformats.org/presentationml/2006/main}pic');assert pictures==130;entry['pictures']=pictures;entry['unchangedOtherOoxmlParts']=True
  archive=work/(kind+'.hcdz');cli('pack',bundle,'--output',archive);offline=work/(kind+'.hcd');cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert json.loads((offline/'manifest.json').read_text())==json.loads(before);assert not (offline/'assets/staged').exists();entry['offlineArchive']={'path':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'nativeValidated':True}
  assert (bundle/'manifest.json').read_bytes()==before;entry['readbackDidNotChangeHead']=True;evidence['files'].append(entry)
 requests=[json.loads(line) for line in (root/'requests.jsonl').read_text().splitlines()]
 summary={}
 for kind in ['pptx','pdf']:
  actor=[item for item in requests if item['actor']=='alice' and '/'+c['documents'][kind]['documentId']+'/' in item['url']];chunks=sorted({int(item['url'].split('/chunks/')[1].split('?')[0]) for item in actor if '/chunks/' in item['url']});assert 129 in chunks and len(chunks)<20,(kind,chunks);assert any('/index/1?' in item['url'] for item in actor);assert any('/text/' in item['url'] for item in actor);summary[kind]={'aliceBodyChunks':chunks,'distinctBodyChunks':len(chunks),'totalDocumentChunks':130,'indexPages':sorted({int(item['url'].split('/index/')[1].split('?')[0]) for item in actor if '/index/' in item['url']})}
 evidence['requestSummary']=summary;(assets/'fixed-lazy-file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS 130-page PPT/PDF actual files, saved PPT text + 130 pictures, unchanged other parts, offline archives, bounded client body requests and unchanged heads')
if __name__=='__main__':main()
