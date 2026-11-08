#!/usr/bin/env python3
"""Verify actual local r5 files after the node conflict browser workflow."""
import hashlib,json,shutil,subprocess,sys,urllib.request,zipfile
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root']);binary=repo/'target/debug/officecli';bundle=root/'mentions-docx.hcd'
 def state(revision,bundle=bundle):return json.loads(subprocess.check_output([str(binary),'hdoc','editor-state',str(bundle),'--revision',str(revision),'--json']))['data']
 def nodes(p):return [n for b in p['blocks'] for n in ([b['content']['extension']] if b['content'].get('extension') else [])+[i['extension'] for i in b['content']['inlines'] if i.get('extension')]]
 before={n['instanceId']:n for n in nodes(state(3))};after={n['instanceId']:n for n in nodes(state(5))};assert len(before)==len(after)==4;assert set(before)==set(after)
 for key,value in before.items():
  if value['type']=='example.future_card':assert after[key]==value
 known={n['type']:n for n in after.values() if n['type']!='example.future_card'};assert known['example.task']['data']=={'title':'Bob 并发候选','done':False,'priority':1};assert known['example.notice']['data']=={'title':'并发合并提示','done':True,'priority':1}
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));base=config['origin']+'/v1/documents/mentions-docx'
 def get(path):return opener.open(urllib.request.Request(base+path,headers={'Authorization':'Bearer '+config['reader']}),timeout=180).read()
 assert json.loads(get(''))['revision']==5;evidence={'schemaVersion':'hcd-node-conflict-files/1','scope':'Actual immutable r3/r5 native envelopes, offline HCD, DOCX/PDF/Markdown and unchanged image bytes. No production or new PDF visual claim.','revision':5,'validation':{'fourStableOccurrenceIds':True,'unknownPayloadsUnchanged':True,'explicitChoiceAndMergedFieldsSaved':True},'files':[]}
 for fmt in ['docx','pdf','md']:
  raw=get(f'/export/{fmt}?revision=5');path=root/f'node-conflicts-r5.{fmt}';path.write_bytes(raw);text=path.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  for expected in ['Bob 并发候选','并发合并提示','冲突处理后仍可编辑','关联项目 · 离线内容','提示：扩展未加载，原始业务数据已保留。']:assert text.count(expected)==1,(fmt,expected)
  assert 'Alice 并发候选' not in text and '协同基线任务' not in text and '协同基线提示' not in text
  if fmt=='docx':
   def media(p):
    with zipfile.ZipFile(p) as z:return sorted(hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/'))
   assert media(path)==media(root/'fixture.docx');evidence['validation']['originalImageMediaBytesUnchanged']=True
  evidence['files'].append({'format':fmt,'sha256':hashlib.sha256(raw).hexdigest(),'choiceMergeAndContinuedInputExactlyOnce':True,'unacceptedCandidateNotExported':True})
 offline=root/'node-conflicts-offline-r5.hcd';shutil.copytree(bundle,offline,dirs_exist_ok=True);assert nodes(state(5,offline))==nodes(state(5));evidence['validation']['offlineAcceptedPayloadsAndIdentitiesRetained']=True;assert json.loads(get(''))['revision']==5;evidence['validation']['readExportDidNotChangeHead']=True
 (repo/'docs/assets/hcd-extensions-2026-10-24/node-conflict-file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS actual r5: selected/merged data, continued input, four stable nodes, original image bytes and three exported files')
if __name__=='__main__':main()
