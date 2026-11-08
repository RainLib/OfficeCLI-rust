#!/usr/bin/env python3
"""Read real immutable AI fixture revisions and DOCX/PDF/MD output, never fake UI evidence."""
import argparse,hashlib,json,shutil,subprocess,urllib.request,zipfile
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('private');parser.add_argument('--phase',choices=['before','accepted','undone','continued'],required=True);args=parser.parse_args()
repo=Path(__file__).resolve().parents[1];config=json.loads(Path(args.private).read_text());root=Path(config['root']);binary=repo/'target/debug/officecli';base=config['origin']+'/v1/documents/mentions-docx';headers={'Authorization':'Bearer '+config['reader'],'X-HCD-Reference-Version':'1','X-HCD-Extension-Version':'2','X-HCD-Node-Edits-Version':'4'}
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def get(path):return opener.open(urllib.request.Request(base+path,headers=headers),timeout=180).read()
revision=json.loads(get(''))['revision'];evidence={'phase':args.phase,'revision':revision,'boundary':'isolated native API, actual files and offline copy; model output is synthetic; browser checks recorded separately','files':[]}
rewrite='AI 改写验证：内容更清晰。';continuation='AI 续写验证：新增说明。'
for fmt in ['docx','pdf','md']:
 raw=get(f'/export/{fmt}?revision={revision}');path=root/f'ai-{args.phase}-r{revision}.{fmt}';path.write_bytes(raw);text=path.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
 assert 'Alice 王' not in text and 'Bob 李' not in text,(fmt,text)
 if args.phase in ['before','undone']:assert 'Original' in text and rewrite not in text and continuation not in text,(fmt,text)
 else:assert text.count(rewrite)==1 and 'Original' not in text,(fmt,text)
 if args.phase in ['accepted','undone','continued']:assert text.count('Bob 保留输入')==1,(fmt,text)
 if args.phase=='continued':assert text.count(continuation)==1,(fmt,text)
 if fmt=='docx':
  def media(p):
   with zipfile.ZipFile(p) as archive:return sorted(hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist() if name.startswith('word/media/'))
  assert media(path)==media(root/'fixture.docx');evidence['sourceImageBytesRetained']=True
 evidence['files'].append({'format':fmt,'sha256':hashlib.sha256(raw).hexdigest(),'textVerified':True})
bundle=root/'mentions-docx.hcd';offline=root/f'ai-{args.phase}-offline.hcd';shutil.copytree(bundle,offline,dirs_exist_ok=True)
def state(path):return json.loads(subprocess.check_output([str(binary),'hdoc','editor-state',str(path),'--revision',str(revision),'--json']))['data']
assert state(offline)==state(bundle);evidence['offlineRevisionPreserved']=True;evidence['runtimeOnlyNamesExcludedFromAllFiles']=True;assert json.loads(get(''))['revision']==revision
folder=repo/'docs/assets/hcd-ai-2026-10-24';folder.mkdir(exist_ok=True);(folder/f'{args.phase}-file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(f'PASS {args.phase}: r{revision}, three actual files, offline revision and original image bytes')
