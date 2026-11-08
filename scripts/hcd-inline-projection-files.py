#!/usr/bin/env python3
"""Exercise the internal frontend codec against an owned source-free HCD archive.
Does not start a server, open rooms, or change the original native fixture.
"""
import hashlib,json,shutil,subprocess,tempfile,zipfile,xml.etree.ElementTree as ET
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];editor=repo/'examples/hdoc/editor';binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-inline-projection-2026-10-26';assets.mkdir(parents=True,exist_ok=True)
 archive=repo/'docs/assets/hcd-inline-content-native-2026-10-26/inline-native-r8.hcdz';runtime=repo/'target/hcd-preview-runtime';runtime.mkdir(parents=True,exist_ok=True);work=Path(tempfile.mkdtemp(prefix='hcd-inline-projection-',dir=runtime))
 sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
 original=sha(archive)
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json'],text=True))['data']
 def bridge(stage,path):subprocess.run(['node','--import','tsx','fixtures/inlineProjectionFiles.ts',stage,str(path),str(work)],cwd=editor,check=True)
 bundle=work/'inline-native.hcd';cli('unpack',archive,'--output',bundle);assert cli('validate',bundle)['valid'];assert not (work/'sources').exists()
 before=cli('editor-state',bundle);assert before['revision']==8
 (work/'projection-r8.json').write_text(json.dumps(before,ensure_ascii=False,indent=2)+'\n')
 bridge('prepare',work/'projection-r8.json')
 result=cli('apply',bundle,'--patch',work/'patch.json','--expected-revision',8)
 after=cli('editor-state',bundle);assert after['revision']==9;assert cli('validate',bundle)['valid']
 (work/'projection-r9.json').write_text(json.dumps(after,ensure_ascii=False,indent=2)+'\n');bridge('receipt',work/'projection-r9.json')
 # The original archive remains byte-exact; the new canonical version packs and
 # reopens without any source document or browser-local state.
 packed=work/'inline-projection-r9.hcdz';cli('pack',bundle,'--output',packed);reopened=work/'reopened.hcd';cli('unpack',packed,'--output',reopened);assert cli('editor-state',reopened)==after
 resource=next(part['content']['extension']['resources'][0] for block in after['blocks'] for part in block['content']['inlines'] if part.get('content',{}).get('extension',{}).get('resources'))
 image=work/'badge.png';cli('get-asset',reopened,resource['hash'],'--output',image);assert sha(image)==resource['hash'] and image.stat().st_size==resource['byteLength']
 files=[]
 for fmt in ['docx','pptx','pdf','md']:
  output=work/f'inline-projection-r9.{fmt}';cli('export',reopened,'--to',fmt,'--output',output)
  if fmt=='md':
   imported=work/'markdown-readback.hcd';cli('import',output,'--output',imported,'--document-id','inline-projection-md');text=''.join(item['text'] for item in cli('extract-text',imported)['entries'])
  else:text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True)
  for needle,count in [('Edited中😀',2),('Nested😀',2),('@Alice 王',4),('新内容',0),('已回读',1)]:assert text.count(needle)==count,(fmt,needle,text)
  assert text.count('[项目]')==2 and 'Field label' not in text
  files.append({'format':fmt,'name':output.name,'sha256':sha(output),'bytes':output.stat().st_size,'bodyAndMentionCountsVerified':True});shutil.copyfile(output,assets/output.name)
 ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
 with zipfile.ZipFile(work/'inline-projection-r9.docx') as package:
  tree=ET.fromstring(package.read('word/document.xml'))
  for text,flag in [('Edited中😀','b'),('Nested😀','i')]:
   runs=[run for run in tree.findall('.//w:r',ns) if text in ''.join(run.itertext())];assert len(runs)==2
   for run in runs:assert run.find('w:rPr/w:'+flag,ns) is not None
 assert sha(archive)==original
 for name in ['projection-r8.json','projection-r9.json','initial.yjs','prepared.yjs','receipted.yjs','captures.json','snapshot.json','postreceipt.json','roots.json','patch.json','prepare-evidence.json','receipt-evidence.json','inline-projection-r9.hcdz']:
  shutil.copyfile(work/name,assets/name)
 report={'scope':'Actual native file application of frontend internal DTO + Yjs file reopens and source receipts. No active room/socket/browser inline-container or signed coordinator acceptance.','inputArchiveSha256':original,'originalArchiveUnchanged':True,'nativeBinarySha256':sha(binary),'inputRevision':8,'savedRevision':9,'sourceFreePackedReopenExact':True,'resourceBytesExact':True,'docxBoldItalicXmlVerified':True,'exports':files,'frontendReceipt':json.loads((work/'receipt-evidence.json').read_text()),'knownBoundaries':['MD/PPTX baseline rich-run styles remain flattened/static','No browser/IME/Office desktop acceptance','No signed coordinator checkpoint or live wire upgrade','Management platform/reminder delivery deferred'],'runtime':str(work)}
 (assets/'file-evidence.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'savedRevision':9,'exports':[item['format'] for item in files],'report':str(assets/'file-evidence.json')},ensure_ascii=False))
if __name__=='__main__':main()
