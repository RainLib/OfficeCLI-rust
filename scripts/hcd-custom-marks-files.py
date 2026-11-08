#!/usr/bin/env python3
"""Verify actual committed marks, own history, offline archives and exported files."""
import base64,hashlib,json,shutil,subprocess,sys,tempfile,urllib.request,zipfile,xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==10 and json.loads(before)['capabilities']['customMarks']==1
 binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-custom-marks-2026-10-26';work=Path(tempfile.mkdtemp(prefix='marks-files-',dir=root));records=[];opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 def state(revision,source=bundle):return cli('editor-state',source,'--revision',revision)
 projections={revision:state(revision) for revision in range(1,11)};initial=projections[1]['blocks']
 for revision in range(2,11):
  blocks=projections[revision]['blocks'];assert all(next(block for block in blocks if block['blockId']==old['blockId'])==old for old in initial)
  marked=[inline for block in blocks for inline in block['content']['inlines'] if inline.get('customMarks')];types=[] if revision==2 else ['example.review'] if revision==3 else ['example.project'] if revision in [5,7,9] else ['example.project','example.review'];assert len(marked)==int(bool(types))
  if marked:
   inline=marked[0];assert inline['text']=='共同文本中😀' and [mark['type'] for mark in inline['customMarks']]==types;assert not inline['bold'] and not inline.get('textColor') and not inline.get('backgroundColor')
   for mark in inline['customMarks']:assert mark['data']==({'ticket':'HCD-27'} if mark['type']=='example.review' else {'project':'HCD'})
  text=''.join(inline['text'] for block in blocks for inline in block['content']['inlines']);assert text.count('共同文本中😀')==1 and text.count('Bob 离线补充')==int(revision>=4)
  ids=[inline['nodeId'] for block in blocks for inline in block['content']['inlines']];assert len(ids)==len(set(ids))
  output=work/f'marks-r{revision}.docx';cli('export',bundle,'--revision',revision,'--to','docx','--output',output);shutil.copyfile(output,assets/output.name);records.append({'revision':revision,'types':types,'originalBlocksExact':True,'peerText':revision>=4})
 for left,right in [(4,6),(7,9),(8,10)]:assert projections[left]['blocks']==projections[right]['blocks'],(left,right)
 def verify(path,revision=10):
  value=path.read_text() if path.suffix in ['.md','.html'] else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  assert value.count('Original')==1 and value.count('共同文本中😀')==1 and value.count('标记协同：')==1 and value.count('Bob 离线补充')==int(revision>=4),(path,value)
  if path.suffix!='.html':assert 'HCD-27' not in value and '需复核' not in value,(path,value)
 for revision in range(2,11):verify(work/f'marks-r{revision}.docx',revision)
 archive=work/'marks-r10.hcdz';offline=work/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',10,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 for revision in range(1,11):assert state(revision,offline)==projections[revision]
 future=work/'future.hcd';shutil.copytree(offline,future);future_manifest=json.loads((future/'manifest.json').read_text());future_manifest['capabilities']['customMarks']=2;(future/'manifest.json').write_text(json.dumps(future_manifest));future_before=(future/'manifest.json').read_bytes();future_read=subprocess.run([str(binary),'hdoc','editor-state',str(future),'--json'],capture_output=True,text=True);assert future_read.returncode!=0 and 'unsupported custom text mark model' in future_read.stdout+future_read.stderr;assert (future/'manifest.json').read_bytes()==future_before
 with zipfile.ZipFile(archive) as package:assert not any('collaboration' in name or name.startswith('sources/') for name in package.namelist())
 files=[]
 for fmt in ['docx','pptx','pdf','md','html']:
  output=work/f'offline-r10.{fmt}';cli(*(['render-html',offline,'--revision',10,'--output',output] if fmt=='html' else ['export',offline,'--revision',10,'--to',fmt,'--output',output]));verify(output)
  if fmt!='html':shutil.copyfile(output,assets/output.name);files.append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
 class Html(HTMLParser):
  def __init__(self):super().__init__();self.marks=[];self.images=[]
  def handle_starttag(self,tag,attrs):
   attrs=dict(attrs)
   if 'data-hcd-custom-mark' in attrs:self.marks.append(json.loads(attrs['data-hcd-custom-mark']))
   if tag=='img':self.images.append(attrs['src'])
 inspection=Html();inspection.feed((work/'offline-r10.html').read_text());html=Html();html_path=Path(sys.argv[3]);html.feed(html_path.read_text());verify(html_path);assert html.marks==inspection.marks and len(html.marks)==2;assert len(html.images)==len(inspection.images)==1
 assert html.images[0].startswith('data:image/png;base64,');image=base64.b64decode(html.images[0].split(',',1)[1]);relative_image=(work/urllib.request.url2pathname(inspection.images[0])).resolve();assert relative_image.is_relative_to(offline);assert relative_image.read_bytes()==image
 shutil.copyfile(html_path,assets/'browser-r10.html');(assets/'offline-r10.html').unlink(missing_ok=True);files.append({'file':'browser-r10.html','sha256':hashlib.sha256(html_path.read_bytes()).hexdigest(),'embeddedImageBytesExact':True,'sourceFreeInspectionMetadataExact':True})
 download=Path(sys.argv[2]);verify(download);shutil.copyfile(download,assets/'browser-r10.docx');shutil.copyfile(archive,assets/archive.name)
 ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
 with zipfile.ZipFile(download) as package:
  xml=ET.fromstring(package.read('word/document.xml'));runs=[run for run in xml.findall('.//w:r',ns) if '共同文本中😀' in ''.join(run.itertext())];assert len(runs)==1
  properties=runs[0].find('w:rPr',ns);assert properties is not None and properties.find('w:b',ns) is not None and properties.find('w:u',ns) is not None
  color=properties.find('w:color',ns);assert color is not None and color.attrib['{'+ns['w']+'}val'].lower()=='246a4b'
  shading=properties.find('w:shd',ns);assert shading is not None and shading.attrib['{'+ns['w']+'}fill'].lower()=='fff2a8'
  assert not any(b'HCD-27' in package.read(name) for name in package.namelist())
 report=json.load(opener.open(urllib.request.Request(c['origin']+'/v1/documents/mentions-docx/export-capabilities?revision=10',headers={'Authorization':'Bearer '+c['reader']})));assert len(report['features'])==1;feature=report['features'][0];assert feature['kind']=='custom_mark' and feature['count']==2;assert feature['nativeBundle']=={'support':'native','dataRetention':'native'};assert feature['formats']['docx']['dataRetention']=='omitted' and feature['formats']['html']['dataRetention']=='embedded';assert 'HCD-27' in json.dumps(feature['examples'])
 probes=[json.loads(path.read_text()) for path in sorted((root/'checkpoint-probe').glob('*.json'))];assert len(probes)==9 and all(probe['status']==200 for probe in probes) and [probe['request']['expectedRevision'] for probe in probes]==list(range(1,10));assert (bundle/'manifest.json').read_bytes()==before
 (assets/'file-evidence.json').write_text(json.dumps({'scope':'Actual native r2-r10, exact canonical own history, browser DOCX/HTML, source-free all-revision HCD and exports. CLI render-html inspection uses relative unpacked HCD assets; browser HTML embeds the identical image bytes and mark payloads. Not real Office or production acceptance.','head':10,'revisions':records,'canonicalEqualities':[[4,6],[7,9],[8,10]],'sourceFreeAllRevisionsExact':list(range(1,11)),'futureModelRejectedWithoutMutation':True,'browserDocx':{'bold':True,'underline':True,'color':'246a4b','background':'fff2a8','businessPayloadOmitted':True},'capabilityReport':report,'firstNativeCheckpoints':9,'all200':True,'files':files,'headUnchanged':True},ensure_ascii=False,indent=2)+'\n');print('PASS actual r2-r10, exact canonical own history, original blocks, browser DOCX styles and self-contained HTML, source-free HCD/DOCX/PPTX/PDF/MD/inspection HTML; nine first checkpoints200; head10 unchanged')

if __name__=='__main__':main()
