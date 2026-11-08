#!/usr/bin/env python3
"""Actual immutable files and offline semantic state for the disposable ghost fixture."""
import argparse,hashlib,json,shutil,subprocess,urllib.request,zipfile
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('private');parser.add_argument('--phase',required=True);parser.add_argument('--expect',type=int,choices=[0,1],required=True);args=parser.parse_args();assert args.phase.isascii() and args.phase.replace('-','').isalpha()
repo=Path(__file__).resolve().parents[1];config=json.loads(Path(args.private).read_text());root=Path(config['root']);binary=repo/'target/debug/officecli';base=config['origin']+'/v1/documents/mentions-docx';headers={'Authorization':'Bearer '+config['reader'],'X-HCD-Node-Edits-Version':'4','X-HCD-Extension-Version':'2','X-HCD-Reference-Version':'1'}
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def get(path):return opener.open(urllib.request.Request(base+path,headers=headers),timeout=180).read()
revision=json.loads(get(''))['revision'];evidence={'boundary':'native API + actual files + offline semantic copy; synthetic model; browser steps recorded separately','phase':args.phase,'revision':revision,'expectedAcceptedCount':args.expect,'files':[]}
for fmt in ['docx','pdf','md']:
 raw=get(f'/export/{fmt}?revision={revision}');p=root/f'autocomplete-{args.phase}-r{revision}.{fmt}';p.write_bytes(raw);text=p.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(p),'text'],text=True)
 assert 'Originalab' in text and text.count('自动补全验证。')==args.expect,(fmt,text)
 if args.phase in ['accepted','undone','redone','final']:assert text.count('Bob 补全时输入')==1,(fmt,text)
 if args.phase in ['fixed-accepted','fixed-undone','fixed-redone','fixed-final','fixed-reopened']:
  assert all(text.count(label)==1 for label in ['First list item','Second list itemxy','Third list itemqwzrstuv','Bob 补全时输入']),(fmt,text)
 assert all(label not in text for label in ['Tab · Esc','AI 补全已就绪','接受 AI 补全','关闭 AI 补全建议','Alice 王','Bob 李']),(fmt,text)
 if fmt=='docx':
  def media(path):
   with zipfile.ZipFile(path) as z:return sorted(hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/'))
  assert media(p)==media(root/'fixture.docx');evidence['sourceDocxMediaBytesPreserved']=True
 evidence['files'].append({'format':fmt,'sha256':hashlib.sha256(raw).hexdigest(),'acceptedTextCountVerified':True,'privateControlsAndCaretNamesExcluded':True,**({'nestedListTextAndPeerRetained':True} if args.phase in ['fixed-accepted','fixed-undone','fixed-redone','fixed-final','fixed-reopened'] else {})})
bundle=root/'mentions-docx.hcd';offline=root/f'autocomplete-{args.phase}-offline.hcd';shutil.copytree(bundle,offline,dirs_exist_ok=True)
def state(path):return json.loads(subprocess.check_output([str(binary),'hdoc','editor-state',str(path),'--revision',str(revision),'--json']))['data']
assert state(offline)==state(bundle);evidence['offlineSemanticRevisionPreserved']=True;assert json.loads(get(''))['revision']==revision
folder=repo/'docs/assets/hcd-ai-2026-10-24';folder.mkdir(exist_ok=True);(folder/f'autocomplete-{args.phase}-file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(f'PASS {args.phase}: r{revision}, expected AI count {args.expect}, three actual files and offline state')
