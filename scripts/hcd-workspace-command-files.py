#!/usr/bin/env python3
"""Verify actual exports and offline archives after the documented CUA command flow."""
import hashlib,json,subprocess,sys,urllib.request,uuid,zipfile
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root']);assert root.name.startswith('hcd-workspace-command-')
 binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-workspace-commands-2026-10-25';assets.mkdir(exist_ok=True);work=root/('files-'+uuid.uuid4().hex[:8]);work.mkdir();opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 evidence={'scope':'Synthetic local native server, real saved files and offline archives; no production or Office application acceptance.','files':[]}
 for kind,expected in [('docx',2),('pptx',0),('pdf',0)]:
  doc=config['documents'][kind];bundle=root/(doc['documentId']+'.hcd');before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==expected
  query=f'?revision={expected}'+('' if kind=='docx' else '&source=true')
  request=urllib.request.Request(f'http://127.0.0.1:{config["ports"][0]}/v1/documents/'+doc['documentId']+'/export/'+kind+query,headers={'Authorization':'Bearer '+doc['reader']})
  response=opener.open(request,timeout=180);output=work/('export.'+kind);output.write_bytes(response.read());text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True)
  assert 'Original' in text and not any(name in text for name in ['Alice 王','Bob 李','Reader 访客','HOST-WRITE','正在跟随'])
  entry={'format':kind,'revision':expected,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'fidelity':response.headers.get('X-HCD-Fidelity-Level'),'presenceNotExported':True}
  if kind=='docx':
   assert '统一命令保存 · 保留原始图片与协同内容' in text
   with zipfile.ZipFile(output) as archive:
    pictures=[name for name in archive.namelist() if name.startswith('word/media/')];assert len(pictures)==1;entry['retainedImages']=len(pictures)
   entry['hostSavedTextPresent']=True
  elif kind=='pptx':
   # A regenerated ZIP may have different compression metadata. Compare every
   # actual OOXML part, including embedded image bytes and relationships.
   with zipfile.ZipFile(output) as actual,zipfile.ZipFile(root/'fixture.pptx') as source:
    assert set(actual.namelist())==set(source.namelist())
    assert all(actual.read(name)==source.read(name) for name in source.namelist())
   entry['unchangedOoxmlParts']=True
  else:assert output.read_bytes()==(root/('fixture.'+kind)).read_bytes();entry['unchangedSourceExact']=True
  archive=work/(kind+'.hcdz');cli('pack',bundle,'--output',archive);offline=work/(kind+'.hcd');cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert (offline/'manifest.json').read_bytes()==before
  offlineOutput=work/('offline.'+kind);cli('export',offline,'--output',offlineOutput)
  offlineText=subprocess.check_output([str(binary),'view',str(offlineOutput),'text'],text=True)
  if kind=='pdf':
   assert any(item['text']=='Original' for item in cli('extract-text',offline)['entries'])
   assert 'Original' in offlineText;entry['offlinePdfSearchable']=True;entry['offlineCanonicalTextPreserved']=True
   subprocess.run(['pdftoppm','-scale-to','800','-png','-singlefile',str(offlineOutput),str(assets/'offline-pdf-searchable')],check=True,capture_output=True)
  else:assert 'Original' in offlineText
  if kind=='docx':assert '统一命令保存 · 保留原始图片与协同内容' in offlineText
  assert (bundle/'manifest.json').read_bytes()==before;entry['offlineArchiveValid']=True;entry['offlineExportTextVerified']=True;entry['viewAndCancelledRestoreDidNotCreateRevision']=True;evidence['files'].append(entry)
 (assets/'workspace-command-files.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS saved Word text/image, unchanged PPT/PDF, all offline archives and text exports including searchable PDF; stable heads 2/0/0')
if __name__=='__main__':main()
