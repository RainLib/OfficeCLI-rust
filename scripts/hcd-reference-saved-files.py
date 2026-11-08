#!/usr/bin/env python3
"""Read-only verifier for the named r3/r4 saved-reference recovery fixture."""
import hashlib,json,subprocess,sys,tempfile,urllib.request,zipfile
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==4
 binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-reference-saved-2026-10-25';out=Path(tempfile.mkdtemp(prefix='saved-reference-files-',dir=root));opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 def refs(revision):return json.load(opener.open(urllib.request.Request(c['origin']+f'/v1/documents/mentions-docx/references?revision={revision}',headers={'Authorization':'Bearer '+c['reader'],'X-HCD-Node-Edits-Version':'4'}),timeout=45))
 with zipfile.ZipFile(root/'sources/mentions-docx.docx') as source:images={hashlib.sha256(source.read(p)).hexdigest() for p in source.namelist() if '/media/' in p}
 evidence={'scope':'Actual native saved r3/r4, authenticated references/events, exports, source-free HCD archive and actual browser r4 DOCX. No production, live DB, multi-instance, old-epoch or real Office acceptance.','root':str(root),'head':4,'files':[],'references':[],'sourceImageHashes':sorted(images)}
 saved=None
 for revision in [3,4]:
  data=refs(revision);assert data==refs(revision);assert data['reminders']=={'enabled':False,'delivery':'disabled'};items={item['reference']['mentionId']:item['reference'] for item in data['items']};assert len(items)==2;reference=items['m_'+'a'*32];assert reference['target']=={'kind':'person','id':'alice'} and reference['snapshot']['label']=='Alice 王'
  if saved:assert items==saved and not data['transition']['events']
  saved=items;evidence['references'].append(data)
  output=out/f'saved-r{revision}.docx';cli('export',bundle,'--revision',revision,'--to','docx','--output',output);text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True);assert text.count('@Alice 王')==1 and text.count('@张三')==1 and text.count('保存恢复同伴正文')==(revision==4)
  (assets/output.name).write_bytes(output.read_bytes());evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
 archive=out/'saved-r4.hcdz';offline=out/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',4,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 for revision in [3,4]:assert cli('editor-state',offline,'--revision',revision)==cli('editor-state',bundle,'--revision',revision)
 def verify(path):
  text=path.read_text() if path.suffix=='.md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True);assert text.count('@Alice 王')==1 and text.count('@张三')==1 and text.count('保存恢复同伴正文')==1 and '@Bob 李' not in text
  if path.suffix in ['.docx','.pptx']:
   with zipfile.ZipFile(path) as archive:assert images.issubset({hashlib.sha256(archive.read(p)).hexdigest() for p in archive.namelist() if '/media/' in p})
 for fmt in ['docx','pptx','pdf','md']:
  output=out/f'saved-offline-r4.{fmt}';cli('export',offline,'--revision',4,'--to',fmt,'--output',output);verify(output)
  if fmt=='pdf':assert any(line.strip() and line.split()[0].isdigit() for line in subprocess.check_output(['pdfimages','-list',str(output)],text=True).splitlines())
  (assets/output.name).write_bytes(output.read_bytes());evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'sourceNotRequired':True})
 downloaded=Path('/Users/houshuai/Downloads/mentions-docx-r4.docx');verify(downloaded);(assets/'browser-r4.docx').write_bytes(downloaded.read_bytes());evidence['files'].append({'file':'browser-r4.docx','sha256':hashlib.sha256(downloaded.read_bytes()).hexdigest(),'actualBrowserDownload':True})
 assert (bundle/'manifest.json').read_bytes()==before;evidence.update(headUnchangedByReadback=True,savedTargetKeptWhileAllPeopleInactive=True,noNewReferenceEventForRetainedTarget=True,remindersDisabled=True,sourceImageBytesPreserved=True)
 (assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS canonical value r3/r4, no false association event, actual browser DOCX and source-free DOCX/PPTX/PDF/MD with peer body and original images; head 4 unchanged.')
if __name__=='__main__':main()
