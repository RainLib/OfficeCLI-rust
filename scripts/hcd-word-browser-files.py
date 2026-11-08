#!/usr/bin/env python3
"""Verify actual browser-saved regional Word revisions, DOCX and offline HCDZ."""
import argparse,hashlib,json,os,re,shutil,subprocess,tempfile,urllib.request,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

def main():
 parser=argparse.ArgumentParser();parser.add_argument('fixture',type=Path);parser.add_argument('--browser-docx',type=Path);parser.add_argument('--browser-hcdz',type=Path);args=parser.parse_args();repo=Path(__file__).resolve().parents[1];root=args.fixture.resolve()
 if root.parent!=repo/'target/hcd-preview-runtime' or not root.name.startswith('word-room-'):raise ValueError('isolated fixture required')
 config=json.loads((root/'private.json').read_text());bundle=root/'rich.hcd';head=json.loads((bundle/'manifest.json').read_text())['revision'];binary=repo/'target/debug/officecli';env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':config['secret']};assets=repo/'docs/assets/hcd-word-browser-2026-10-26';assets.mkdir(exist_ok=True);work=Path(tempfile.mkdtemp(prefix='browser-files-',dir=root))
 def cli(*args):
  result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],cwd=root,env=env,capture_output=True,text=True,check=True);return json.loads(result.stdout)['data']
 states={n:cli('editor-state',bundle,'--revision',n) for n in range(head+1)};docx=work/f'word-browser-r{head}.docx';cli('export',bundle,'--revision',head,'--output',docx)
 with zipfile.ZipFile(docx) as exported:
  parts={name:''.join(ET.fromstring(exported.read(name)).itertext()) for name in exported.namelist() if name=='word/document.xml' or name.startswith(('word/header','word/footer')) and name.endswith('.xml')}
  body=parts['word/document.xml'];assert body.count('区域协作正文 A 😀')==1;assert body.count('Body one')==1;assert body.count('区域菜单标题')==1;assert body.count('@Bob 李')==1;assert 'hcdWordRegionBoundary' not in body
  assert 'https://example.com/regional' in exported.read('word/_rels/document.xml.rels').decode();assert any('cx="1016000"' in exported.read(name).decode() for name in exported.namelist() if name.startswith('word/header') and name.endswith('.xml'))
  assert any('协作页眉 Bob 😀' in text for name,text in parts.items() if name.startswith('word/header'));assert any('协作页脚 Bob' in text for name,text in parts.items() if name.startswith('word/footer'))
  with zipfile.ZipFile(root/'source.docx') as original:assert {hashlib.sha256(original.read(name)).hexdigest() for name in original.namelist() if name.startswith('word/media/')}<={hashlib.sha256(exported.read(name)).hexdigest() for name in exported.namelist() if name.startswith('word/media/')}
 archive=work/f'word-browser-r{head}.hcdz';offline=work/'offline.hcd';cli('pack',bundle,'--output',archive);cli('unpack',archive,'--output',offline)
 for revision,state in states.items():assert cli('editor-state',offline,'--revision',revision)==state
 assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid']
 headers={'Authorization':'Bearer '+config['reader'],'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7','X-HCD-Extension-Version':'2','X-HCD-Custom-Marks-Version':'1','X-HCD-Collaboration-Epoch':'1','X-HCD-Collaboration-Protocol':'hcd-word-regions/1'}
 with urllib.request.urlopen(urllib.request.Request(config['apiUrl']+'/references',headers=headers)) as response:references=json.load(response)
 assert len(references['items'])==1 and references['items'][0]['reference']['target']=={'id':'bob','kind':'person'};assert references['reminders']=={'delivery':'disabled','enabled':False}
 (assets/'references.json').write_text(json.dumps(references,ensure_ascii=False,indent=2)+'\n')
 for file in [docx,archive]:shutil.copy2(file,assets/file.name)
 report={'schemaVersion':'hcd-word-browser-evidence/1','fixture':str(root),'head':head,'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'actualDocxBodyHeaderFooter':True,'bodyParagraphAndHeadingNotDuplicated':True,'serverPersonMentionPreserved':True,'originalMediaRetained':True,'actualLinkRelationship':True,'actualHeaderImageWidth80pt':True,'offlineAllVersionsExact':list(states),'nativeAndOfflineValidate':True,'scope':'Local browser synthetic fixture, native API, real DOCX/HCDZ. No user document migration, remote DB/S3, live provider or notification delivery acceptance.'}
 if args.browser_docx:
  # Each export allocates fresh paragraph IDs; all other XML and bytes must match.
  def parts(z):return {name:re.sub(rb' w:paraId="[a-f0-9]{8}"',b'',z.read(name)) if name.endswith('.xml') else z.read(name) for name in z.namelist()}
  with zipfile.ZipFile(args.browser_docx) as a,zipfile.ZipFile(docx) as b:assert parts(a)==parts(b)
  shutil.copy2(args.browser_docx,assets/'browser-downloaded-r11.docx');report['browserDocxMatchesNativeExceptGeneratedParagraphIds']=True
 if args.browser_hcdz:
  downloaded=work/'downloaded-offline.hcd';cli('unpack',args.browser_hcdz.resolve(),'--output',downloaded)
  for revision,state in states.items():assert cli('editor-state',downloaded,'--revision',revision)==state
  assert cli('validate',downloaded)['valid'];shutil.copy2(args.browser_hcdz,assets/'browser-downloaded-r11.hcdz');report['browserArchiveDownloadAllVersionsExact']=True
 (assets/'browser-api-files.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
