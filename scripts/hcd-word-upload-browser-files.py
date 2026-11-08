#!/usr/bin/env python3
"""Verify the real browser upload/restart/undo chain and portable resources."""
import argparse,hashlib,json,os,re,shutil,subprocess,tempfile,urllib.request,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

def main():
 parser=argparse.ArgumentParser();parser.add_argument('fixture',type=Path);parser.add_argument('--browser-docx',type=Path);parser.add_argument('--browser-hcdz',type=Path);args=parser.parse_args();repo=Path(__file__).resolve().parents[1];root=args.fixture.resolve()
 if root.parent!=repo/'target/hcd-preview-runtime' or not root.name.startswith('word-room-'):raise ValueError('isolated fixture required')
 config=json.loads((root/'private.json').read_text());http=json.loads((root/'upload-http-evidence.json').read_text());gate=json.loads((root/'browser-gate-evidence.json').read_text());bundle=root/'rich.hcd';head=json.loads((bundle/'manifest.json').read_text())['revision'];assert head>=5;work=Path(tempfile.mkdtemp(prefix='upload-files-',dir=root));assets=repo/'docs/assets/hcd-word-upload-browser-2026-10-27';assets.mkdir(exist_ok=True);binary=repo/'target/debug/officecli';env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':config['secret']}
 def cli(*args):
  result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],cwd=root,env=env,capture_output=True,text=True,check=True);return json.loads(result.stdout)['data']
 def native(route):
  with urllib.request.urlopen(urllib.request.Request(config['apiUrl']+route,headers={'Authorization':'Bearer '+config['reader'],'X-HCD-Node-Edits-Version':'7','X-HCD-Flow-Layout-Version':'2'})) as response:return json.load(response)
 states={n:cli('editor-state',bundle,'--revision',n) for n in range(head+1)};images={revision:native('/images/'+http['imageId']+'?revision='+str(revision))['image'] for revision in range(1,head+1)};wanted=gate['heldBrowserChoice'][0]['assetHash'];assert images[2]['assetHash']==http['replacementHash'];assert images[3]['assetHash']==http['pendingForBrowser']['assetHash'];assert images[4]['assetHash']==images[3]['assetHash'];assert images[5]['assetHash']==wanted;assert images[head]['assetHash']==wanted
 expected='上传期间正文 Alice 😀，换图恢复中仍可编辑，断线恢复验证';projection=native('/editor?revision='+str(head));assert expected in json.dumps(projection,ensure_ascii=False)
 docx=work/f'upload-r{head}.docx';cli('export',bundle,'--revision',head,'--output',docx)
 with zipfile.ZipFile(docx) as z:
  parts={name:''.join(ET.fromstring(z.read(name)).itertext()) for name in z.namelist() if name=='word/document.xml' or name.startswith(('word/header','word/footer')) and name.endswith('.xml')};assert parts['word/document.xml'].count(expected)==1;assert parts['word/document.xml'].count('Body one')==1;assert any('Header image text' in text for name,text in parts.items() if name.startswith('word/header'));assert any('上传期间页脚 Bob' in text for name,text in parts.items() if name.startswith('word/footer'));assert wanted in {hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if name.startswith('word/media/')}
 archive=work/'upload-history.hcdz';offline=work/'offline.hcd';cli('pack',bundle,'--output',archive);cli('unpack',archive,'--output',offline)
 for revision,state in states.items():assert cli('editor-state',offline,'--revision',revision)==state
 assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid']
 hashes={hashlib.sha256(path.read_bytes()).hexdigest() for path in (offline/'assets').rglob('*') if path.is_file()};expected_assets={http['originalHash'],http['replacementHash'],http['pendingForBrowser']['assetHash'],wanted};assert expected_assets<=hashes
 report={'schemaVersion':'hcd-word-upload-browser-files/1','fixture':str(root),'head':head,'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'realHttp':http,'browserRestartAndUndo':gate,'imageHashesByRevision':{revision:value['assetHash'] for revision,value in images.items()},'peerBodyAndFooterRetained':True,'docxReferencesNewImageBytes':True,'originalAndEveryReplacementArchived':sorted(expected_assets),'offlineAllVersionsExact':list(states),'nativeAndOfflineValidate':True,'scope':'Owned local synthetic browser/API/Socket/native and actual DOCX/HCDZ only. No old-document migration, remote DB/S3 or notification acceptance.'}
 if args.browser_docx:
  def parts(z):return {name:re.sub(rb' w:paraId="[a-f0-9]{8}"',b'',z.read(name)) if name.endswith('.xml') else z.read(name) for name in z.namelist()}
  with zipfile.ZipFile(args.browser_docx) as a,zipfile.ZipFile(docx) as b:assert parts(a)==parts(b)
  shutil.copy2(args.browser_docx,assets/f'browser-upload-r{head}.docx');report['browserDocxEqualsNativeExceptGeneratedParagraphIds']=True
 if args.browser_hcdz:
  downloaded=work/'browser-offline.hcd';cli('unpack',args.browser_hcdz.resolve(),'--output',downloaded)
  for revision,state in states.items():assert cli('editor-state',downloaded,'--revision',revision)==state
  assert cli('validate',downloaded)['valid'];browser_assets={hashlib.sha256(path.read_bytes()).hexdigest() for path in (downloaded/'assets').rglob('*') if path.is_file()};assert expected_assets<=browser_assets
  shutil.copy2(args.browser_hcdz,assets/f'browser-upload-r{head}.hcdz');report['browserArchiveAllVersionsAndAssetsExact']=True
 for file in [docx,archive]:shutil.copy2(file,assets/file.name)
 for name in ['upload-http-evidence.json','browser-gate-evidence.json']:shutil.copy2(root/name,assets/name)
 (assets/'browser-api-files.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
