#!/usr/bin/env python3
"""Read back the local SDK browser fixture and actual fixed-revision exports.
Run after the documented two-browser steps, with the fixture's private.json.
This verifies files/API; it does not fabricate browser interaction evidence.
"""
import hashlib,json,shutil,subprocess,sys,urllib.request,zipfile
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];config=json.loads(Path(sys.argv[1]).read_text());root=Path(config['root']);binary=repo/'target/debug/officecli';bundle=root/'mentions-docx.hcd'
 def state(revision,bundle=bundle):return json.loads(subprocess.check_output([str(binary),'hdoc','editor-state',str(bundle),'--revision',str(revision),'--json']))['data']
 def nodes(value):return [node for block in value['blocks'] for node in ([block['content']['extension']] if block['content'].get('extension') else [])+[inline['extension'] for inline in block['content']['inlines'] if inline.get('extension')]]
 old={n['instanceId']:n for n in nodes(state(2))};s5=state(5);current=state(6);n5={n['type']:n for n in nodes(s5) if n['type'].startswith('example.') and n['type']!='example.future_card'};all_nodes=nodes(current);assert len(all_nodes)==4;assert len({n['instanceId'] for n in all_nodes})==4
 current_by_id={n['instanceId']:n for n in all_nodes};assert all(current_by_id[key]==value for key,value in old.items())
 known={n['type']:n for n in all_nodes if n['type']!='example.future_card'};assert set(known)=={'example.task','example.notice'};assert known['example.task']['data']=={'title':'SDK 属性保存验证','done':True,'priority':2};assert known['example.notice']['data']=={'title':'SDK 块节点最终验证','done':True};assert all(known[key]['instanceId']==value['instanceId'] for key,value in n5.items());assert known['example.task']['fallback']==n5['example.task']['fallback'] and known['example.task']['data']!=n5['example.task']['data']
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}));base=config['origin']+'/v1/documents/mentions-docx';headers={'Authorization':'Bearer '+config['reader']}
 def get(path):return opener.open(urllib.request.Request(base+path,headers=headers),timeout=180).read()
 assert json.loads(get(''))['revision']==6
 evidence={'schemaVersion':'hcd-node-sdk-files/1','scope':'Local SDK browser fixture: authoritative revisions 2/5/6, native offline copy and actual fixed-r6 DOCX/PDF/Markdown. Browser steps are recorded separately; no production or visual-PDF claim.','revision':6,'validation':{'fourUniqueOccurrencesNoDuplicateRoots':True,'originalUnknownEnvelopesUnchanged':True,'knownInlineAndBlockDataRetained':True,'businessOnlyUpdateWithSameFallbackCommitted':True,'stableKnownOccurrenceIds':True},'files':[]}
 for fmt in ['docx','pdf','md']:
  raw=get(f'/export/{fmt}?revision=6');p=root/f'sdk-browser-r6.{fmt}';p.write_bytes(raw);text=p.read_text() if fmt=='md' else subprocess.check_output([str(binary),'view',str(p),'text'],text=True)
  for expected in ['SDK 属性保存验证','SDK 块节点最终验证','Bob 的正文应保留','关联项目 · 离线内容','提示：扩展未加载，原始业务数据已保留。']:assert text.count(expected)==1,(fmt,expected)
  assert 'Bob 李' not in text and '/任务' not in text and '/提示' not in text
  if fmt=='docx':
   def media(path):
    with zipfile.ZipFile(path) as z:return sorted(hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.startswith('word/media/'))
   assert media(p)==media(root/'fixture.docx');evidence['validation']['originalDocxMediaBytesRetained']=True
  evidence['files'].append({'format':fmt,'sha256':hashlib.sha256(raw).hexdigest(),'allFourFallbacksAndPeerInputOnce':True})
 offline=root/'sdk-offline-r6.hcd';shutil.copytree(bundle,offline,dirs_exist_ok=True);assert nodes(state(6,offline))==all_nodes;evidence['validation']['offlinePayloadsAndIdsRetained']=True
 report=root/'sdk-fidelity.json';subprocess.run([str(binary),'hdoc','export',str(bundle),'--output',str(root/'sdk-reported.docx'),'--revision','6','--fidelity-report',str(report),'--json'],stdout=subprocess.DEVNULL,check=True,timeout=180);assert sum(w['code']=='HCD_EXTENSION_FLATTENED' for w in json.loads(report.read_text())['warnings'])==4;evidence['validation']['flatteningReportedForFourNodes']=True
 assert json.loads(get(''))['revision']==6;evidence['validation']['readAndExportDidNotChangeHead']=True
 target=repo/'docs/assets/hcd-extensions-2026-10-24/sdk-file-evidence.json';target.write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS r6: known properties including business-only update, four unique nodes, offline copy and three actual exported files')
if __name__=='__main__':main()
