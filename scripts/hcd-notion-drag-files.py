#!/usr/bin/env python3
"""Read-only exported-file verification for the owned Notion/drag UI fixture."""
import hashlib,json,shutil,subprocess,sys,tempfile
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];root=Path(sys.argv[1]).resolve();download=Path(sys.argv[2]);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-')
 binary=repo/'target/debug/officecli';bundle=root/'mentions-docx.hcd';before=(bundle/'manifest.json').read_bytes();revision=json.loads(before)['revision'];assert revision==7
 assets=repo/'docs/assets/hcd-notion-drag-2026-10-25';assets.mkdir(exist_ok=True);work=Path(tempfile.mkdtemp(prefix='notion-files-',dir=root))
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 def projection(rev,source=bundle):return cli('editor-state',source,'--revision',rev)
 def text(block):return ''.join(part['text'] for part in block['inlines'])+''.join(text(child) for child in block.get('children',[]))
 old=projection(2);moved=projection(3);final=projection(7)
 def rows(state):return [(item['blockId'],text(item['content'])) for item in state['blocks'] if text(item['content']).startswith('拖动')]
 assert [value for _,value in rows(old)]==['拖动验证甲','拖动验证乙','拖动验证丙']
 assert [value for _,value in rows(moved)]==['拖动验证丙','拖动验证甲','拖动验证乙']
 assert dict(rows(old))==dict(rows(moved))
 assert [value for _,value in rows(final)]==['拖动验证丙','拖动内验证甲（协作者补充）','拖动验证乙']
 assert next(item for item in final['blocks'] if text(item['content'])=='Notion 交互验证')['content']['kind']=='heading'
 def verify(path):
  value=path.read_text() if path.suffix=='.md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  ordered=['拖动验证丙','拖动内验证甲（协作者补充）','拖动验证乙','Notion 交互验证']
  positions=[value.index(item) for item in ordered];assert positions==sorted(positions)
  assert all(value.count(item)==1 for item in ordered)
  assert all(item not in value for item in ['AI 改写验证','AI 续写验证','添加一段说明','/AI','/标题'])
 archive=work/'notion-drag-r7.hcdz';cli('pack',bundle,'--revision',7,'--output',archive)
 offline=work/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('unpack',archive,'--output',offline)
 assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 assert projection(7,offline)==final
 evidence={'scope':'Owned localhost synthetic AI provider, actual native r2/r3/r7, browser DOCX, source-free archive and exports. No production or real model/Office acceptance.','head':revision,'stableMovedBlockIds':True,'orderBefore':[value for _,value in rows(old)],'orderAfter':[value for _,value in rows(moved)],'orderFinal':[value for _,value in rows(final)],'privateSuggestionsAbsent':True,'files':[]}
 for fmt in ['docx','pptx','pdf','md']:
  output=work/f'offline-r7.{fmt}';cli('export',offline,'--revision',7,'--to',fmt,'--output',output);verify(output);shutil.copyfile(output,assets/output.name);evidence['files'].append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
 shutil.copyfile(archive,assets/archive.name)
 verify(download);shutil.copyfile(download,assets/'browser-r7.docx');assert (bundle/'manifest.json').read_bytes()==before
 evidence.update(archiveValid=True,sourceFreeProjectionExact=True,browserDownloadVerified=True,headUnchanged=True)
 (assets/'file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print('PASS stable drag identities/order, heading, browser DOCX, private suggestions excluded, offline HCD/DOCX/PPTX/PDF/MD; head7 unchanged')

if __name__=='__main__':main()
