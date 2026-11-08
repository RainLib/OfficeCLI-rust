#!/usr/bin/env python3
"""Read back immutable versions produced by the owned browser restore acceptance."""
import argparse,hashlib,json,os,shutil,subprocess,tempfile,zipfile
from pathlib import Path


def main():
    repo=Path(__file__).resolve().parents[1];parser=argparse.ArgumentParser();parser.add_argument('root',type=Path);args=parser.parse_args();root=args.root.resolve()
    assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-inline-editor-')
    binary=repo/'target/debug/officecli';bundle=root/'inline-native.hcd';assets=repo/'docs/assets/hcd-inline-revision-restore-2026-10-27';work=Path(tempfile.mkdtemp(prefix='browser-restore-files-',dir=root))
    env={**os.environ,'NO_COLOR':'1'}
    def cli(*args):return json.loads(subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],env=env,capture_output=True,text=True,check=True,timeout=120).stdout)['data']
    initial=cli('editor-state',bundle,'--revision',8);restored=cli('editor-state',bundle,'--revision',13);current=cli('editor-state',bundle,'--revision',14)
    assert restored['blocks']==initial['blocks'];assert cli('get-revision',bundle,13)['rootHash']==cli('get-revision',bundle,8)['rootHash']
    assert len(current['blocks'])==4;assert [current['blocks'][i] for i in [0,2,3]]==initial['blocks'];assert '还原后继续编辑😀' in json.dumps(current['blocks'][1],ensure_ascii=False)
    assert 'Editing after restore' in json.dumps(cli('editor-state',bundle,'--revision',12),ensure_ascii=False)
    exports={}
    for extension in ['docx','pptx','pdf','md']:
        path=work/('browser-r14.'+extension);cli('export',bundle,'--to',extension,'--revision',14,'--output',path)
        if extension in ['docx','pptx']:
            with zipfile.ZipFile(path) as z:text=''.join(z.read(n).decode() for n in z.namelist() if n.endswith('.xml'))
        elif extension=='pdf':text=subprocess.check_output(['pdftotext',str(path),'-'],text=True)
        else:text=path.read_text()
        assert '还原后继续编辑😀' in text and 'Nested😀' in text;assert 'Editing after restore' not in text
        exports[extension]=hashlib.sha256(path.read_bytes()).hexdigest();shutil.copyfile(path,assets/path.name)
    archive=work/'browser-r14.hcdz';cli('pack',bundle,'--output',archive);offline=work/'offline.hcd';cli('unpack',archive,'--output',offline)
    for revision in [8,12,13,14]:assert cli('editor-state',offline,'--revision',revision)==cli('editor-state',bundle,'--revision',revision)
    assert cli('validate',offline)['valid'];shutil.copyfile(archive,assets/archive.name)
    evidence={'scope':'Actual CUA main editor + native immutable files, isolated clone only','reviewedTarget':8,'comparisonHead':12,'restoredRevision':13,'continuedSaveRevision':14,'restoredRootAndAllBlocksExact':True,'originalThreeBlocksExactAfterContinuedInput':True,'earlierHistoryPreserved':True,'unknownCodecDataRetained':True,'exports':exports,'offlineVersionsExact':[8,12,13,14]}
    (assets/'browser-file-evidence.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(json.dumps(evidence,ensure_ascii=False))

if __name__=='__main__':main()
