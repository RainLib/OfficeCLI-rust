#!/usr/bin/env python3
"""Export and verify the exact isolated document chosen in browser QA."""
import hashlib,json,os,subprocess,sys,zipfile,tempfile,shutil
from pathlib import Path
import xml.etree.ElementTree as ET
repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();config=json.loads((root/'private.json').read_text());binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-word-recovery-2026-10-26';env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':config['secret']}
if '--verify-saved' not in sys.argv:
 result=subprocess.run(['node','--import',str(repo/'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/hcd-word-recovery-browser-files.mts'),str(root/'private.json')],capture_output=True,text=True,timeout=90)
 if result.returncode:raise RuntimeError(result.stdout+'\n'+result.stderr)
report=json.loads((root/'browser-saved.json').read_text())
def cli(*args):
 result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],cwd=root,env=env,capture_output=True,text=True,check=True);return json.loads(result.stdout)['data']
work=Path(tempfile.mkdtemp(prefix='browser-recovered-files-',dir=root));bundle=root/'rich.hcd';states={n:cli('editor-state',bundle,'--revision',n) for n in [1,2]};docx=work/'browser-recovered-r2.docx';cli('export',bundle,'--revision',2,'--output',docx)
with zipfile.ZipFile(docx) as z:
 parts={name:''.join(ET.fromstring(z.read(name)).itertext()) for name in z.namelist() if name=='word/document.xml' or name.startswith(('word/header','word/footer')) and name.endswith('.xml')}
 assert report['exactBody'] in parts['word/document.xml'];assert parts['word/document.xml'].count('Body one')==1
 assert any(report['header'] in text for name,text in parts.items() if name.startswith('word/header'));assert any(report['footer'] in text for name,text in parts.items() if name.startswith('word/footer'))
 with zipfile.ZipFile(root/'source.docx') as original:assert {hashlib.sha256(original.read(name)).hexdigest() for name in original.namelist() if name.startswith('word/media/')}<={hashlib.sha256(z.read(name)).hexdigest() for name in z.namelist() if name.startswith('word/media/')}
archive=work/'browser-recovered-r2.hcdz';cli('pack',bundle,'--output',archive);offline=work/'browser-offline.hcd';cli('unpack',archive,'--output',offline)
for n,state in states.items():assert cli('editor-state',offline,'--revision',n)==state
assert cli('validate',bundle)['valid'] and cli('validate',offline)['valid']
for file in [docx,archive]:shutil.copy2(file,assets/file.name)
report.update(nativeBinarySha256=hashlib.sha256(binary.read_bytes()).hexdigest(),actualDocxBodyAndStories=True,peerAndRecoveredTextExact=True,unchangedSecondParagraphNotDuplicated=True,originalMediaRetained=True,offlineAllVersionsExact=[1,2],nativeAndOfflineValidate=True,fixture=str(root))
(assets/'browser-api-files.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False))
