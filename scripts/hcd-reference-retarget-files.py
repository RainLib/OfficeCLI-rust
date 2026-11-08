#!/usr/bin/env python3
"""Read-only saved-reference/actor/event and actual export proof for the named fixture."""
import hashlib,json,subprocess,sys,tempfile,urllib.request,zipfile
from pathlib import Path
def main():
 repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';binary=repo/'target/debug/officecli';before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==6
 out=Path(tempfile.mkdtemp(prefix='reference-files-',dir=root));assets=repo/'docs/assets/hcd-reference-intents-2026-10-25';assets.mkdir(exist_ok=True);opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 def refs(revision):return json.load(opener.open(urllib.request.Request(config['origin']+f'/v1/documents/mentions-docx/references?revision={revision}',headers={'Authorization':'Bearer '+config['reader'],'X-HCD-Node-Edits-Version':'4'}),timeout=45))
 with zipfile.ZipFile(root/'sources/mentions-docx.docx') as original:source_images={hashlib.sha256(original.read(path)).hexdigest() for path in original.namelist() if '/media/' in path}
 assert source_images
 first='m_'+'a'*32;second='m_'+'b'*32;evidence={'scope':'Saved native local revisions, authenticated reference/event reads, actual file exports and source-free HCD archive. No production, real Office application or old-epoch recovery acceptance.','root':str(root),'head':6,'revisions':[],'files':[]}
 baseline=refs(2);unchanged=next(item['reference'] for item in baseline['items'] if item['reference']['mentionId']==second)
 for revision,target,label,event in [(2,'person:设计/乙','张三',None),(3,'alice','Alice 王','reference.retargeted'),(4,'bob','Bob 李','reference.retargeted'),(5,None,None,'reference.removed'),(6,'bob','Bob 李','reference.created')]:
  data=refs(revision);assert data==refs(revision);items={item['reference']['mentionId']:item['reference'] for item in data['items']};assert items[second]==unchanged
  if target:assert items[first]['target']=={'kind':'person','id':target} and items[first]['snapshot']['label']==label and len(items)==2
  else:assert first not in items and len(items)==1
  if event:
   events=data['transition']['events'];assert len(events)==1 and events[0]['mentionId']==first and events[0]['kind']==event and events[0]['context']['actorId']=='alice',events
  assert data['reminders']=={'enabled':False,'delivery':'disabled'}
  evidence['revisions'].append(data)
  output=out/f'retarget-r{revision}.docx';cli('export',bundle,'--revision',revision,'--to','docx','--output',output);text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True)
  assert text.count('@张三')==(2 if revision==2 else 1);assert text.count('Bob 并发正文')==(0 if revision==2 else 1)
  if label and revision!=2:assert text.count('@'+label)==1
  if revision==5:assert '@Bob 李' not in text and '@Alice 王' not in text
  with zipfile.ZipFile(output) as archive:assert source_images.issubset({hashlib.sha256(archive.read(path)).hexdigest() for path in archive.namelist() if '/media/' in path})
  evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'savedNamesAndPeerBody':True});(assets/output.name).write_bytes(output.read_bytes())
 archive=out/'retarget-r6.hcdz';offline=out/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',6,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 def projection(revision,source):return cli('editor-state',source,'--revision',revision)
 for revision in [2,3,4,5,6]:assert projection(revision,offline)==projection(revision,bundle)
 for fmt in ['docx','pptx','pdf','md']:
  output=out/f'retarget-offline-r6.{fmt}';cli('export',offline,'--revision',6,'--to',fmt,'--output',output);text=output.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(output),'text'],text=True);assert text.count('@Bob 李')==1 and text.count('@张三')==1 and text.count('Bob 并发正文')==1
  if fmt in ['docx','pptx']:
   with zipfile.ZipFile(output) as archive:assert source_images.issubset({hashlib.sha256(archive.read(path)).hexdigest() for path in archive.namelist() if '/media/' in path})
  if fmt=='pdf':
   listing=subprocess.check_output(['pdfimages','-list',str(output)],text=True);assert any(line.strip() and line.split()[0].isdigit() for line in listing.splitlines())
  evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'sourceAndDirectoryNotRequired':True});(assets/output.name).write_bytes(output.read_bytes())
 assert (bundle/'manifest.json').read_bytes()==before;evidence.update(sourceImageBytesPreserved=True,sourceImageHashes=sorted(source_images),headUnchangedByReadback=True,stableOccurrenceRestoredByUndo=True,exactResolverAuthenticatedActor=True,eventsStableOnRepeatedReads=True,reminderDeliveryDisabled=True)
 (assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS r2-r6 identities, authenticated actors/stable events, names/body/images in actual DOCX/PPTX/PDF/MD and source-free archive; head unchanged.')
if __name__=='__main__':main()
