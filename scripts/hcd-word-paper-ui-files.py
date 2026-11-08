#!/usr/bin/env python3
"""Read/export immutable revisions produced by the owned paper UI browser test."""
import argparse,hashlib,json,os,shutil,subprocess,tempfile,urllib.request,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET


def main():
 repo=Path(__file__).resolve().parents[1];parser=argparse.ArgumentParser();parser.add_argument('root',type=Path);args=parser.parse_args();root=args.root.resolve()
 assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-region-preview-')
 private=json.loads((root/'private.json').read_text());bundle=root/'region-ui.hcd';binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-word-paper-ui-2026-10-26';assets.mkdir(exist_ok=True);work=Path(tempfile.mkdtemp(prefix='paper-files-',dir=root))
 env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':private['secret']}
 def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
 def hashes(path):return {str(p.relative_to(path)):sha(p) for p in path.rglob('*') if p.is_file() and p.name!='.hcd-write-lock'}
 def cli(*args):
  completed=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],cwd=work,env=env,capture_output=True,text=True,check=True)
  return json.loads(completed.stdout)['data']
 before=hashes(bundle);states={n:cli('editor-state',bundle,'--revision',n) for n in range(1,4)}
 def text(n):return json.dumps(states[n],ensure_ascii=False)
 assert '项目周报 · 页眉验证 😀' in text(2) and '正文与页眉共同保存 😀' in text(2)
 assert '内部资料 · 页脚直接编辑' in text(3)
 record=cli('get-revision',bundle,2);assert set(record['dirtySourceParts'])=={'word/document.xml','word/parts/custom.xml'}
 footer=cli('get-revision',bundle,3);assert footer['dirtySourceParts']==['word/footer2.xml']
 output=work/'paper-r3.docx';report=cli('export',bundle,'--revision',3,'--output',output)
 with zipfile.ZipFile(output) as z:
  parts={name:''.join(ET.fromstring(z.read(name)).itertext()) for name in z.namelist() if name=='word/document.xml' or name.startswith(('word/header','word/footer')) and name.endswith('.xml')}
  assert '正文与页眉共同保存 😀' in parts['word/document.xml'] and 'Long section 140' in parts['word/document.xml']
  assert '项目周报 · 页眉验证 😀' not in parts['word/document.xml']
  assert any('项目周报 · 页眉验证 😀' in value for name,value in parts.items() if name.startswith('word/header'))
  assert any('内部资料 · 页脚直接编辑' in value for name,value in parts.items() if name.startswith('word/footer'))
 archive=work/'paper-history.hcdz';cli('pack',bundle,'--output',archive);offline=work/'offline.hcd';cli('unpack',archive,'--output',offline)
 for n in range(1,4):assert cli('editor-state',offline,'--revision',n)==states[n]
 req=urllib.request.Request(f"http://127.0.0.1:{private['ports'][0]}/v1/documents/region-ui/export/docx?revision=3",headers={'Authorization':'Bearer '+private['tokens']['reader'],'X-HCD-Flow-Layout-Version':'2'})
 with urllib.request.urlopen(req,timeout=120) as response:assert response.status==200;(assets/'reader-r3.docx').write_bytes(response.read())
 assert hashes(bundle)==before
 shutil.copy2(output,assets/output.name);shutil.copy2(archive,assets/archive.name)
 result={'scope':'Owned browser fixture and native immutable files; no Office desktop or production claim','jointBodyHeaderRevision':2,'jointDirtySourceParts':record['dirtySourceParts'],'peerFooterRevision':3,'footerDirtySourceParts':footer['dirtySourceParts'],'sourceFreeDocxStoryPlacement':True,'allOfflineRevisionsExact':[1,2,3],'readOnlyHttpDocxDownload':200,'verificationDidNotChangeBundle':True,'nativeBinarySha256':sha(binary)}
 (assets/'file-evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');(assets/'export-warnings.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
