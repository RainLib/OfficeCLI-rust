#!/usr/bin/env python3
"""Read actual regional AI browser revisions, native exports and offline history.
The provider in this fixture is deterministic loopback NDJSON, not a live model.
"""
import argparse,hashlib,json,os,re,shutil,subprocess,tempfile,urllib.request,urllib.error,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

def main():
 parser=argparse.ArgumentParser();parser.add_argument('fixture',type=Path);parser.add_argument('--browser-docx',type=Path);parser.add_argument('--browser-hcdz',type=Path);args=parser.parse_args()
 repo=Path(__file__).resolve().parents[1];root=args.fixture.resolve()
 if root.parent!=repo/'target/hcd-preview-runtime' or not root.name.startswith('word-room-'):raise ValueError('isolated fixture required')
 config=json.loads((root/'private.json').read_text());assert config.get('aiFixture')
 binary=repo/'target/debug/officecli';bundle=root/'rich.hcd';head=json.loads((bundle/'manifest.json').read_text())['revision'];assert head>=9
 env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':config['secret']};work=Path(tempfile.mkdtemp(prefix='ai-files-',dir=root));assets=repo/'docs/assets/hcd-word-ai-regional-2026-10-27';assets.mkdir(exist_ok=True)
 def cli(*args):
  result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],cwd=work,env=env,capture_output=True,text=True,check=True);return json.loads(result.stdout)['data']
 def http(path):
  req=urllib.request.Request(config['apiUrl']+path,headers={'Authorization':'Bearer '+config['reader'],'X-HCD-Node-Edits-Version':'7','X-HCD-Flow-Layout-Version':'2'})
  with urllib.request.urlopen(req,timeout=180) as response:return response.read()
 states={n:cli('editor-state',bundle,'--revision',n) for n in range(head+1)}
 def text(n):return json.dumps(states[n],ensure_ascii=False)
 assert 'AI 改写验证：内容更清晰。' not in text(1)
 assert 'AI 改写验证：内容更清晰。' in text(2) and 'Body one，同伴保留 😀' in text(2)
 assert 'Default footer AI 续写验证：新增说明。' in text(4)
 assert '自动补全前缀' in text(5) and '自动补全验证。' not in text(5)
 assert '自动补全验证。' in text(6)
 assert 'AI 改写验证：同伴内容更清晰。' in text(head) and 'Body one，同伴保留 😀' in text(head)
 final_docx=None;docx_reports=[]
 for revision in [2,3,4,5,6,head]:
  path=work/f'ai-r{revision}.docx';cli('export',bundle,'--revision',revision,'--output',path)
  with zipfile.ZipFile(path) as z:
   parts={name:''.join(ET.fromstring(z.read(name)).itertext()) for name in z.namelist() if name=='word/document.xml' or name.startswith(('word/header','word/footer')) and name.endswith('.xml')}
   assert parts['word/document.xml'].count('Body one，同伴保留 😀')==1
   assert any('First header' in value for name,value in parts.items() if name.startswith('word/header'))
   if revision>=3:assert any('AI 改写验证：内容更清晰。' in value for name,value in parts.items() if name.startswith('word/header'))
   if revision>=4:assert any('Default footer AI 续写验证：新增说明。' in value for name,value in parts.items() if name.startswith('word/footer'))
   if revision==5:assert all('自动补全验证。' not in value for value in parts.values())
   if revision>=6:assert sum(value.count('自动补全验证。') for value in parts.values())==1
   with zipfile.ZipFile(root/'source.docx') as original:
    media=lambda archive:{hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist() if name.startswith('word/media/')}
    assert media(original)<=media(z)
  docx_reports.append({'revision':revision,'partsAndOriginalMediaVerified':True});shutil.copy2(path,assets/path.name)
  if revision==head:final_docx=path
 # Ask real native routes. Regional formats that cannot preserve stories must
 # explicitly reject instead of exporting a partial body under a success claim.
 exports=[]
 for fmt in ['pdf','md','html']:
  path=work/f'ai-r{head}.{fmt}'
  try:path.write_bytes(http(f'/export/{fmt}?revision={head}'))
  except urllib.error.HTTPError as error:
   message=json.loads(error.read())['error'];assert error.code==422 and message.startswith('This Word region format is not supported yet.'),(fmt,error.code,message)
   exports.append({'format':fmt,'supported':False,'status':422,'description':message});continue
  if fmt=='pdf':rendered=subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  else:rendered=path.read_text()
  compact=lambda value:re.sub(r'\s+','',value)
  assert compact('AI 改写验证：同伴内容更清晰。') in compact(rendered),(fmt,rendered[:1000])
  assert compact('Body one，同伴保留 😀') in compact(rendered),(fmt,rendered[:1000])
  shutil.copy2(path,assets/path.name);exports.append({'format':fmt,'bodyAndPeerText':True,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
 archive=work/'ai-history.hcdz';offline=work/'offline.hcd';cli('pack',bundle,'--output',archive);cli('unpack',archive,'--output',offline)
 for n,state in states.items():assert cli('editor-state',offline,'--revision',n)==state
 assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid'];shutil.copy2(archive,assets/archive.name)
 requests=[json.loads(p.read_text()) for p in root.glob('ai-request-*.json')]
 assert any(d['action']=='hcd.autocomplete' for d in requests)
 assert all(not any(k in d for k in ['token','anchor','user','userId','target']) for d in requests)
 result={'scope':'Actual local synthetic browser/native/API/files/offline verification; loopback deterministic provider only. No external-model, remote-store or production claim.','fixture':str(root),'head':head,'privateGhostExcludedAtRevision':5,'acceptedGhostAtRevision':6,'acceptedBodyAndHeaderAndFooter':True,'peerTextRetained':True,'sourceMediaRetained':True,'docx':docx_reports,'otherFormats':exports,'offlineAllVersionsExact':list(states),'nativeAndOfflineValidate':True,'providerRequests':len(requests),'providerPayloadsContainNoTokensOrBookmarks':True,'nativeBinarySha256':hashlib.sha256(binary.read_bytes()).hexdigest()}
 if args.browser_docx:
  def parts(z):return {name:re.sub(rb' w:paraId="[a-f0-9]{8}"',b'',z.read(name)) if name.endswith('.xml') else z.read(name) for name in z.namelist()}
  with zipfile.ZipFile(args.browser_docx) as a,zipfile.ZipFile(final_docx) as b:assert parts(a)==parts(b)
  shutil.copy2(args.browser_docx,assets/f'browser-ai-r{head}.docx');result['browserDocxEqualsNativeExceptGeneratedParagraphIds']=True
 if args.browser_hcdz:
  downloaded=work/'browser-offline.hcd';cli('unpack',args.browser_hcdz.resolve(),'--output',downloaded)
  for n,state in states.items():assert cli('editor-state',downloaded,'--revision',n)==state
  assert cli('validate',downloaded)['valid'];shutil.copy2(args.browser_hcdz,assets/f'browser-ai-r{head}.hcdz');result['browserArchiveAllVersionsExact']=True
 assert json.loads((bundle/'manifest.json').read_text())['revision']==head
 (assets/'file-evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
