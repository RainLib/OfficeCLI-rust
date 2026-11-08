#!/usr/bin/env python3
"""Read actual joined/split revisions and source-free exports of the owned fixture."""
import hashlib,json,shutil,subprocess,sys,tempfile,zipfile
from pathlib import Path

def main():
 repo=Path(__file__).resolve().parents[1];c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['root']);assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-');bundle=root/'mentions-docx.hcd';before=(bundle/'manifest.json').read_bytes();assert json.loads(before)['revision']==7
 binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-source-retention-2026-10-26';work=Path(tempfile.mkdtemp(prefix='transfer-files-',dir=root));identity=json.loads((root/'transfer-identities.json').read_text());records=[]
 def cli(*args):return json.loads(subprocess.check_output([str(binary),'hdoc',*map(str,args),'--json']))['data']
 def state(revision,source=bundle):return cli('editor-state',source,'--revision',revision)
 projections={revision:state(revision) for revision in range(1,8)}
 def leaves(content):return content['inlines']+sum([leaves(child) for child in content.get('children',[])],[])
 for revision in range(2,8):
  blocks=projections[revision]['blocks'];assert all(next(block for block in blocks if block['blockId']==old['blockId'])==old for old in identity['originalBlocks'])
  sources=[inline for block in blocks for inline in leaves(block['content']) if inline['nodeId'] in identity['initialSourceIds']];assert len(sources)==2
  assert [inline['nodeId'] for inline in sources]==identity['initialSourceIds'];assert [inline['text'] for inline in sources]==['Alpha 中😀','Beta'+(' · Bob late' if revision>=4 else '')]
  joined=revision in [3,4,6];assert len(blocks)==(3 if joined else 4)
  ids=[inline['nodeId'] for block in blocks for inline in leaves(block['content'])];assert len(ids)==len(set(ids))
  output=work/f'transfer-r{revision}.docx';cli('export',bundle,'--revision',revision,'--to','docx','--output',output);shutil.copyfile(output,assets/output.name);records.append({'revision':revision,'joined':joined,'sources':sources,'originalBlocksExact':True})
 def verify(path,revision=7):
  text=path.read_text() if path.suffix=='.md' else subprocess.check_output([str(binary),'view',str(path),'text'],text=True)
  for token in ['Original','Alpha 中😀','Beta']:assert text.count(token)==1,(path,text)
  assert text.count(' · Bob late')==int(revision>=4),(path,text)
 for revision in range(2,8):verify(work/f'transfer-r{revision}.docx',revision)
 archive=work/'transfer-r7.hcdz';offline=work/'offline/mentions-docx.hcd';offline.parent.mkdir();cli('pack',bundle,'--revision',7,'--output',archive);cli('unpack',archive,'--output',offline);assert cli('validate',offline)['valid'];assert not (offline.parent/'sources').exists()
 for revision in range(1,8):assert state(revision,offline)==projections[revision]
 with zipfile.ZipFile(archive) as package:assert not any('collaboration' in name or name.startswith('sources/') for name in package.namelist())
 files=[]
 for fmt in ['docx','pptx','pdf','md']:
  output=work/f'transfer-offline-r7.{fmt}';cli('export',offline,'--revision',7,'--to',fmt,'--output',output);verify(output);shutil.copyfile(output,assets/output.name);files.append({'file':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
 shutil.copyfile(archive,assets/archive.name)
 probes=[json.loads(path.read_text()) for path in sorted((root/'checkpoint-probe').glob('*.json'))];assert len(probes)==6 and all(probe['status']==200 for probe in probes) and [probe['request']['expectedRevision'] for probe in probes]==list(range(1,7))
 assert (bundle/'manifest.json').read_bytes()==before
 (assets/'transfer-file-evidence.json').write_text(json.dumps({'scope':'Actual native revisions, unchanged original blocks, stable inline IDs, source-free pack/unpack and DOCX/PPTX/PDF/MD. Retired paragraph root IDs are allowed to change on later split; not original OOXML fidelity or production acceptance.','head':7,'revisions':records,'sourceFreeAllRevisionsExact':list(range(1,8)),'firstNativeCheckpoints':6,'all200':True,'files':files,'headUnchanged':True},ensure_ascii=False,indent=2)+'\n');print('PASS actual join/split r2-r7 source identities and peer text, original blocks, all-revision source-free archive and DOCX/PPTX/PDF/MD; six first checkpoints200; head7 unchanged')

if __name__=='__main__':main()
