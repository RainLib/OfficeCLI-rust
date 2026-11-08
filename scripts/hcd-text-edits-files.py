#!/usr/bin/env python3
"""Read/export the owned real-socket/browser multi-step fixture without mutating it."""
import hashlib,json,shutil,subprocess,tempfile
from pathlib import Path

def main():
 import sys
 c=json.loads(Path(sys.argv[1]).read_text());repo=Path(__file__).resolve().parents[1];root=Path(c['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-')
 binary=repo/'target/debug/officecli';bundle=root/'mentions-docx.hcd';assets=repo/'docs/assets/hcd-text-edits-2026-10-26';work=Path(tempfile.mkdtemp(prefix='text-edits-files-',dir=root));sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json'],text=True))['data']
 baseline={str(path.relative_to(bundle)):sha(path) for path in bundle.rglob('*') if path.is_file() and path.name!='.hcd-write-lock'};canonical={rev:cli('editor-state',bundle,'--revision',rev) for rev in range(1,9)}
 expected={1:['AAA😀AAA','BBB'],2:['AAAAA😀AAAAA','BBBBB'],3:['AAAPeerAA😀AAAAA','你😀BBBBB'],4:['APeerAA😀AAA','你😀BBB'],5:['AAAPeerAA😀AAAAA','你😀BBBBB'],6:['AAAAA😀AAAAA','BBBBB'],7:['AAAPeerAA😀AAAAA','你😀BBBBB'],8:['AAAPeerAA😀AAAAA','你😀CBBBBB']}
 for rev,projection in canonical.items():assert[''.join(inline['text'] for inline in block['content']['inlines']) for block in projection['blocks']]==expected[rev]
 equalities=[(2,6),(3,5),(3,7)]
 for a,b in equalities:assert canonical[a]['blocks']==canonical[b]['blocks']
 archive=work/'text-edits-r8.hcdz';cli('pack',bundle,'--output',archive);offline=work/'source-free.hcd';cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not(work/'sources').exists()
 for rev,projection in canonical.items():assert cli('editor-state',offline,'--revision',rev)==projection
 files=[]
 for fmt in ['docx','pptx','pdf','md']:
  output=work/f'text-edits-r8.{fmt}';cli('export',offline,'--to',fmt,'--output',output)
  if fmt=='md':
   parsed=work/'markdown-readback.hcd';cli('import',output,'--output',parsed,'--document-id','splice-md');text=''.join(item['text'] for item in cli('extract-text',parsed)['entries'])
  else:text=subprocess.check_output([str(binary),'view',str(output),'text'],text=True)
  assert text.count('AAAPeerAA😀AAAAA')==1 and text.count('你😀CBBBBB')==1,(fmt,text)
  shutil.copyfile(output,assets/output.name);files.append({'file':output.name,'bytes':output.stat().st_size,'sha256':sha(output),'textVerified':True})
 shutil.copyfile(archive,assets/archive.name);assert{str(path.relative_to(bundle)):sha(path) for path in bundle.rglob('*') if path.is_file() and path.name!='.hcd-write-lock'}==baseline
 probe=[]
 for path in sorted((root/'checkpoint-probe').glob('*.json')):
  value=json.loads(path.read_text());probe.append({'file':path.name,**{key:value[key] for key in ['status','requestBytes','responseBytes'] if key in value}})
 report={'scope':'Actual immutable native revisions, source-free HCDZ and four real exported files, read by native handlers. Not Office desktop or PDF visual acceptance.','head':8,'nativeBinarySha256':sha(binary),'nativeContentBytesUnchanged':True,'runtimeFileExcluded':['.hcd-write-lock'],'sourceFreeVersionsExact':list(canonical),'strictCanonicalEqualities':[list(pair) for pair in equalities],'canonicalRootCount':2,'identityOnlyBatch':'Same-visible delete/reinsert updates persisted Yjs item identities while retaining native semantic revision7; next peer input creates revision8.','exports':files,'checkpointProbeMetadataFiles':probe,'knownBoundaries':['Programmatic composition metadata, not actual OS IME acceptance','No active editable inline-container room/SDK activation','Management/reminder delivery deferred']}
 (assets/'file-evidence.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');(assets/'native-versions.json').write_text(json.dumps(canonical,ensure_ascii=False,indent=2)+'\n');print('PASS source-free revisions1-8, strict canonical equalities, DOCX/PPTX/PDF/MD text and unchanged native content')
if __name__=='__main__':main()
