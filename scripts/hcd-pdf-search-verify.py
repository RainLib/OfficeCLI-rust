#!/usr/bin/env python3
"""Synthetic real-file/HTTP verification of source-free searchable PDF export.
Requires local reportlab, pypdf, Pillow and Poppler; no provider or production data.
"""
import hashlib,json,os,secrets,shutil,socket,subprocess,tempfile,time,urllib.request,urllib.error,xml.etree.ElementTree as ET
from pathlib import Path
from PIL import Image,ImageChops
from pypdf import PdfReader,PdfWriter
from pypdf.generic import ArrayObject,NameObject
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader

def main():
 repo=Path(__file__).resolve().parents[1];binary=repo/'target/debug/officecli';runtime=repo/'target/hcd-preview-runtime';runtime.mkdir(exist_ok=True)
 root=Path(tempfile.mkdtemp(prefix='hcd-pdf-search-',dir=runtime));root.chmod(0o700);assets=repo/'docs/assets/hcd-pdf-search-2026-10-25';assets.mkdir(exist_ok=True)
 env={**os.environ,'HCD_TOKEN_SECRET':secrets.token_hex(32)}
 for key in ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_S3_ENDPOINT']:env.pop(key,None)
 def cli(*args):
  result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,timeout=180)
  if result.returncode:raise RuntimeError((result.stdout+result.stderr)[-2000:])
  return json.loads(result.stdout)['data']
 font=repo/'crates/pdf-handler/assets/NotoSansSC-Regular.ttf';pdfmetrics.registerFont(TTFont('FixtureSC',str(font)))
 raw=root/'unrotated.pdf';c=canvas.Canvas(str(raw),pagesize=(360,260),pageCompression=1)
 for rotation in [0,90,180,270]:
  c.setFont('FixtureSC',14);c.drawString(40,190,f'Rotation {rotation:03d} canonical');c.drawString(40,150,'离线中文搜索');c.setFillColorRGB(.1,.2,.9);c.rect(50,40,60,40,fill=1);c.showPage()
 scan=Image.new('RGB',(320,220),'white');scan.paste((210,40,70),(20,20,120,90));c.drawImage(ImageReader(scan),10,15,300,200);c.showPage();c.save()
 writer=PdfWriter();reader=PdfReader(raw)
 for index,page in enumerate(reader.pages):
  if index<4:page.rotate(index*90)
  page.cropbox.lower_left=(10,15);page.cropbox.upper_right=(310,215);writer.add_page(page)
 source=root/'source.pdf'
 with source.open('wb') as file:writer.write(file)
 source_hash=hashlib.sha256(source.read_bytes()).hexdigest()
 bundle=root/'search-pdf.hcd';cli('import',source,'--output',bundle,'--document-id','search-pdf','--chunk-blocks',1)
 (root/'sources').mkdir();shutil.copyfile(source,root/'sources/search-pdf.pdf')
 entries=cli('extract-text',bundle)['entries'];node=next(entry for entry in entries if 'Rotation 000' in entry['text'])
 patch={'schemaVersion':'hcd-patch/5','documentId':'search-pdf','patchId':'searchable-saved-text','baseRevision':0,'operations':[{'op':'text.splice','nodeId':node['nodeId'],'start':0,'deleteCount':len(node['text']),'insertText':'已保存 offline r1 😀','precondition':{'nodeHash':node['nodeHash']}}]}
 patch_path=root/'patch.json';patch_path.write_text(json.dumps(patch,ensure_ascii=False));cli('apply',bundle,'--patch',patch_path,'--expected-revision',0)
 before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==1
 archive=root/'offline.hcdz';cli('pack',bundle,'--output',archive);offline=root/'offline-only/search-pdf.hcd';offline.parent.mkdir();cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 filters=[list(page.raw_get('/Contents').get_object().get('/Filter',[])) for page in PdfReader(source).pages]
 assert all(value==['/ASCII85Decode','/FlateDecode'] for value in filters)
 evidence={'sourceContentFilters':filters,'scope':'Synthetic local CLI/HTTP and actual Poppler extraction/pixels; no production or Office acceptance.','pages':5,'rotations':[0,90,180,270],'files':[],'root':str(root)}
 for revision in [0,1]:
  output=root/f'offline-r{revision}.pdf';report=root/f'offline-r{revision}.json';cli('export',offline,'--revision',revision,'--output',output,'--fidelity-report',report)
  text=subprocess.check_output(['pdftotext','-raw',str(output),'-'],text=True);assert text.count('离线中文搜索')==4,text
  assert ('已保存 offline r1 😀' in text)==(revision==1),repr(text)
  assert ('Rotation 000 canonical' in text)==(revision==0),repr(text)
  pdf=PdfReader(output);assert len(pdf.pages)==5;assert not pdf.pages[4].extract_text().strip(),'scan-only page must not acquire fabricated text'
  boxes={index:[] for index in range(1,6)}
  for sequence in range(json.loads(before)['chunkCount']):
   chunk=cli('get-chunk',offline,sequence,'--revision',revision);section=ET.fromstring(chunk['html']);number=int(section.get('data-hcd-page'))
   for paragraph in section.findall('.//p'):
    if not paragraph.get('data-hcd-text-node'):continue
    style=dict(part.split(':',1) for part in paragraph.get('style').split(';') if ':' in part)
    x,y,w,h=[float(style[key].strip().removesuffix('pt')) for key in ['left','top','width','height']];boxes[number].append((x,y,x+w,y+h))
  bbox=root/f'bbox-r{revision}.xml';subprocess.run(['pdftotext','-bbox-layout',str(output),str(bbox)],check=True,capture_output=True)
  ns={'h':'http://www.w3.org/1999/xhtml'}
  for number,page in enumerate(ET.parse(bbox).findall('.//h:page',ns),1):
   for word in page.findall('.//h:word',ns):
    x,y,right,bottom=[float(word.get(key)) for key in ['xMin','yMin','xMax','yMax']]
    assert any(x>=a-.02 and y>=b-.02 and right<=c+.02 and bottom<=d+.02 for a,b,c,d in boxes[number]),(number,word.text,word.attrib,boxes[number])
  for page in pdf.pages:
   contents=page['/Contents']
   for stream in contents if isinstance(contents,ArrayObject) else [contents]:
    data=stream.get_object().get_data()
    if b' Tj' in data:assert b'3 Tr' in data
  # Remove only the added text streams to create an image-only visual baseline.
  baseline=PdfWriter()
  for page in pdf.pages:
   baseline.add_page(page)
   contents=baseline.pages[-1]['/Contents']
   if isinstance(contents,ArrayObject):baseline.pages[-1][NameObject('/Contents')]=ArrayObject([contents[0]])
  baseline_path=root/f'image-only-r{revision}.pdf'
  with baseline_path.open('wb') as file:baseline.write(file)
  for label,path in [('actual',output),('baseline',baseline_path)]:subprocess.run(['pdftoppm','-r','96','-png',str(path),str(root/f'{label}-{revision}')],check=True,capture_output=True)
  for number in range(1,6):
   a=Image.open(root/f'actual-{revision}-{number}.png').convert('RGB');b=Image.open(root/f'baseline-{revision}-{number}.png').convert('RGB');assert a.size==b.size and ImageChops.difference(a,b).getbbox() is None
  fidelity=json.loads(report.read_text());assert fidelity['level']=='VISUAL';assert fidelity['warnings'][0]['code']=='HCD_PDF_RASTER_TEXT_EXPORT'
  evidence['files'].append({'revision':revision,'unicodeSearchable':True,'canonicalSavedTextOnly':True,'selectionBoundsWithinCanonicalBoxes':True,'scanPageNoFabricatedText':True,'pixelsIdenticalToImageOnly':True,'fidelity':fidelity['level']})
  shutil.copyfile(output,assets/f'offline-r{revision}.pdf');shutil.copyfile(root/f'actual-{revision}-1.png',assets/f'offline-r{revision}-page1.png')
 native=root/'source-backed-r1.pdf';cli('export',bundle,'--source',source,'--revision',1,'--output',native)
 native_text=subprocess.check_output(['pdftotext','-raw',str(native),'-'],text=True);assert '已保存 offline r1 😀' in native_text,repr(native_text)
 for label,path in [('original-source',source),('native-source',native)]:subprocess.run(['pdftoppm','-r','96','-png',str(path),str(root/label)],check=True,capture_output=True)
 for number in range(1,6):
  a=Image.open(root/f'original-source-{number}.png').convert('RGB');b=Image.open(root/f'native-source-{number}.png').convert('RGB');assert a.size==b.size
  changed=ImageChops.difference(a,b).getbbox() is not None
  assert changed==(number==1),(number,changed)
 assert hashlib.sha256(source.read_bytes()).hexdigest()==source_hash;evidence['sourceBackedNewChineseAndEmoji']=True;evidence['unchangedOtherPagesPixelExact']=True
 # Compare actual extracted word bounds, not just internal layout metadata.
 bounds={};word_bounds={}
 for label,path in [('sourceBacked',native),('offline',root/'offline-r1.pdf')]:
  bbox=root/(label+'-bounds.xml');subprocess.run(['pdftotext','-bbox-layout',str(path),str(bbox)],check=True,capture_output=True)
  page=PdfReader(path).pages[0];left=float(page.cropbox.left);top=float(page.mediabox.top-page.cropbox.top)
  words=ET.parse(bbox).find('.//h:page',ns).findall('.//h:word',ns)[:4]
  assert [word.text for word in words]==['已保存','offline','r1','😀']
  word_bounds[label]=[[float(word.get(key))-offset for key,offset in [('xMin',left),('yMin',top),('xMax',left),('yMax',top)]] for word in words]
  bounds[label]=[min(float(word.get('xMin')) for word in words)-left,min(float(word.get('yMin')) for word in words)-top,max(float(word.get('xMax')) for word in words)-left,max(float(word.get('yMax')) for word in words)-top]
 max_error=max(abs(a-b) for source_word,offline_word in zip(word_bounds['sourceBacked'],word_bounds['offline']) for a,b in zip(source_word,offline_word));assert max_error<=.02,(bounds,word_bounds,max_error)
 evidence['savedFontReplacementGeometry']={'viewportFirstLineBounds':bounds,'actualWordBoundsMatch':True,'maxWordErrorPt':max_error,'tolerancePt':.02}
 # Isolate rotated replacements from the two-author HTTP history below.
 rotated=root/'rotated-cases';rotated.mkdir();rotated_bundle=rotated/'search-pdf.hcd';cli('unpack',archive,'--output',rotated_bundle);(rotated/'sources').mkdir();shutil.copyfile(source,rotated/'sources/search-pdf.pdf')
 rotated_evidence=[]
 for revision,rotation in enumerate([90,180,270],2):
  target=next(entry for entry in cli('extract-text',rotated_bundle)['entries'] if f'Rotation {rotation:03d}' in entry['text'])
  replacement=f'旋转{rotation}😀';body={'schemaVersion':'hcd-patch/5','documentId':'search-pdf','patchId':f'rotated-{rotation}','baseRevision':revision-1,'operations':[{'op':'text.splice','nodeId':target['nodeId'],'start':0,'deleteCount':len(target['text']),'insertText':replacement,'precondition':{'nodeHash':target['nodeHash']}}]}
  path=rotated/f'patch-{rotation}.json';path.write_text(json.dumps(body,ensure_ascii=False));cli('apply',rotated_bundle,'--patch',path,'--expected-revision',revision-1)
  rotated_bounds={}
  for label in ['source','offline']:
   output=rotated/f'{label}-{rotation}.pdf';extra=['--source',source] if label=='source' else [];cli('export',rotated_bundle,'--revision',revision,'--output',output,*extra)
   copied=subprocess.check_output(['pdftotext','-raw',str(output),'-'],text=True);assert replacement in ''.join(copied.split()),repr(copied)
   bbox=rotated/f'{label}-{rotation}.xml';subprocess.run(['pdftotext','-cropbox','-bbox-layout',str(output),str(bbox)],check=True,capture_output=True)
   page=ET.parse(bbox).findall('.//h:page',ns)[rotation//90];words=[word for word in page.findall('.//h:word',ns) if word.text!='离线中文搜索'];assert ''.join(word.text or '' for word in words)==replacement
   rotated_bounds[label]=[min(float(word.get('xMin')) for word in words),min(float(word.get('yMin')) for word in words),max(float(word.get('xMax')) for word in words),max(float(word.get('yMax')) for word in words)]
   shutil.copyfile(output,assets/f'rotated-{label}-{rotation}.pdf')
  error=max(abs(a-b) for a,b in zip(rotated_bounds['source'],rotated_bounds['offline']));assert error<=.02,(rotation,rotated_bounds,error)
  rotated_evidence.append({'rotation':rotation,'revision':revision,'unicodePreserved':True,'bounds':rotated_bounds,'maxBoundsErrorPt':error})
 evidence['rotatedFontReplacements']=rotated_evidence
 latest=next(entry for entry in cli('extract-text',bundle)['entries'] if entry['nodeId']==node['nodeId'])
 bad=json.loads(json.dumps(patch));bad.update(patchId='unsupported-glyph',baseRevision=1);bad['operations'][0].update(deleteCount=len(latest['text']),insertText='Unsupported \U0010ffff',precondition={'nodeHash':latest['nodeHash']})
 bad_path=root/'unsupported.json';bad_path.write_text(json.dumps(bad));result=subprocess.run([str(binary),'hdoc','apply',str(bundle),'--patch',str(bad_path),'--expected-revision','1','--json'],env=env,capture_output=True,text=True,timeout=120)
 assert result.returncode and 'U+10FFFF' in result.stdout and (bundle/'manifest.json').read_bytes()==before;evidence['unsupportedGlyphRejectedWithoutHeadChange']=True
 shutil.copyfile(native,assets/'source-backed-r1.pdf')
 token=cli('issue-token','--document-id','search-pdf','--scope','read','--user-id','reader','--display-name','Reader','--ttl-seconds',600)['token']
 with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
 log=open(root/'api.log','wb');server=subprocess.Popen([str(binary),'hdoc','serve','--root',str(root),'--bind',f'127.0.0.1:{port}'],env=env,stdout=log,stderr=log)
 try:
  for _ in range(200):
   with socket.socket() as probe:
    if probe.connect_ex(('127.0.0.1',port))==0:break
   assert server.poll() is None;time.sleep(.1)
  opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));request=urllib.request.Request(f'http://127.0.0.1:{port}/v1/documents/search-pdf/export/pdf?revision=1',headers={'Authorization':'Bearer '+token})
  response=opener.open(request,timeout=120);http=root/'http-r1.pdf';http.write_bytes(response.read());assert '已保存 offline r1 😀' in subprocess.check_output(['pdftotext','-raw',str(http),'-'],text=True)
  assert response.headers['X-HCD-Fidelity-Level']=='VISUAL';evidence['authenticatedHttpExportSearchable']=True
  assert (bundle/'manifest.json').read_bytes()==before;evidence['readbackDidNotChangeHead']=True
  writers={name:cli('issue-token','--document-id','search-pdf','--scope','write','--user-id',name,'--display-name',name.title(),'--ttl-seconds',600)['token'] for name in ['alice','bob']}
  def api(path,actor='alice',body=None):
   req=urllib.request.Request(f'http://127.0.0.1:{port}/v1/documents/search-pdf'+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+writers[actor],'Content-Type':'application/json'})
   return json.loads(opener.open(req,timeout=120).read())
  bodies={}
  def save_text(identifier,text,patch_id,actor):
   current=api('/text/'+identifier,actor);head=api('',actor)['revision']
   body={'schemaVersion':'hcd-patch/5','documentId':'search-pdf','patchId':patch_id,'baseRevision':head,'operations':[{'op':'text.splice','nodeId':identifier,'start':0,'deleteCount':len(current['text']),'insertText':text,'precondition':{'nodeHash':current['nodeHash']}}]};bodies[patch_id]=body
   return api('/edits',actor,body)
  second=next(entry for entry in entries if entry['text']=='离线中文搜索')
  assert save_text(node['nodeId'],'HTTP 保存新字 😀','http-alice','alice')['revision']==2
  assert save_text(second['nodeId'],'Bob 另一段 🧭','http-bob','bob')['revision']==3
  assert api('/edits','alice',bodies['http-alice'])['revision']==2 and api('')['revision']==3
  assert api('/text/'+second['nodeId'])['text']=='Bob 另一段 🧭'
  assert save_text(node['nodeId'],'已保存 offline r1 😀','http-alice-inverse','alice')['revision']==4
  assert api('/text/'+second['nodeId'])['text']=='Bob 另一段 🧭'
  stable=(bundle/'manifest.json').read_bytes()
  try:save_text(node['nodeId'],'Unsupported \U0010ffff','http-unsupported','alice');raise AssertionError('unsupported glyph was accepted')
  except urllib.error.HTTPError as error:assert 400<=error.code<500
  assert (bundle/'manifest.json').read_bytes()==stable
  for source_mode in ['', '&source=true']:
   req=urllib.request.Request(f'http://127.0.0.1:{port}/v1/documents/search-pdf/export/pdf?revision=4'+source_mode,headers={'Authorization':'Bearer '+token})
   output=root/('http-r4-source.pdf' if source_mode else 'http-r4-offline.pdf');output.write_bytes(opener.open(req,timeout=120).read())
   text=subprocess.check_output(['pdftotext','-raw',str(output),'-'],text=True);assert '已保存 offline r1 😀' in text and 'Bob 另一段 🧭' in text,repr(text)
   shutil.copyfile(output,assets/output.name)
  evidence['httpWrites']={'head':4,'twoAuthenticatedActors':True,'newChineseAndEmojiSaved':True,'lateIdempotentReceiptKeptOtherActorText':True,'inversePatchKeptOtherActorText':True,'failedGlyphKeptHead':True,'sourceAndSourceFreeExportTextVerified':True}
 finally:
  server.terminate()
  try:server.wait(timeout=5)
  except subprocess.TimeoutExpired:server.kill();server.wait()
  log.close()
 assert hashlib.sha256(source.read_bytes()).hexdigest()==source_hash
 (assets/'pdf-search-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS ASCII85+Flate import, new Chinese/emoji saved with source fonts retained, unknown glyph rejected atomically, historical/offline/HTTP text, rotation/crop/continuation, scan-only and unchanged other pages.')
if __name__=='__main__':main()
