#!/usr/bin/env python3
"""Read/export the owned browser fixture; never edits its document content."""
import argparse,hashlib,json,os,subprocess,tempfile,urllib.request,urllib.error,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET


def main():
    repo=Path(__file__).resolve().parents[1];parser=argparse.ArgumentParser();parser.add_argument('root',type=Path);args=parser.parse_args();root=args.root.resolve()
    assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('word-region-preview-')
    private=json.loads((root/'private.json').read_text());bundle=root/'region-ui.hcd';binary=repo/'target/debug/officecli';assets=repo/'docs/assets/hcd-word-region-ui-2026-10-26';work=Path(tempfile.mkdtemp(prefix='file-check-',dir=root))
    env={**os.environ,'NO_COLOR':'1','HCD_TOKEN_SECRET':private['secret']}
    sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
    def hashes(path):return {str(p.relative_to(path)):sha(p) for p in path.rglob('*') if p.is_file() and p.name!='.hcd-write-lock'}
    def cli(*args):
        result=subprocess.run([str(binary),'hdoc',*map(str,args),'--json'],cwd=work,env=env,capture_output=True,text=True,check=True);assert not result.stderr;return json.loads(result.stdout)['data']
    before=hashes(bundle);states={n:cli('editor-state',bundle,'--revision',n) for n in range(1,9)}
    def text_at(n):
        texts=[]
        def walk(content):
            for inline in content.get('inlines',[]):
                texts.append(inline.get('text',''))
                if inline.get('content'):walk(inline['content'])
            for child in content.get('children',[]):walk(child)
        for block in states[n]['blocks']:walk(block['content'])
        return texts
    for n in range(2,9):assert 'Alice 正文区域保存 😀' in text_at(n)
    for n in range(3,9):assert 'Bob 第二节独立修改 😀' in text_at(n)
    assert 'Default footer' in text_at(4) and 'Alice 页脚区域保存 😀' not in text_at(4)
    assert 'Alice 页脚区域保存 😀' in text_at(5)
    assert '空页脚新增内容 😀' in text_at(6)
    assert 'Bob 页眉更新 😀' in text_at(7) and 'Bob 页眉更新 😀 / Alice 审阅后合并' in text_at(8)
    field=next(e for e in cli('extract-text',bundle)['entries'] if e['text']=='7');assert field['source']['editable'] is False
    record=cli('get-revision',bundle,2);assert set(record['dirtySourceParts'])=={'word/document.xml','word/header1.xml','word/footer1.xml'}
    output=assets/'browser-regions-r8.docx';report=cli('export',bundle,'--output',output)
    w='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    with zipfile.ZipFile(output) as z:
        contents={name:''.join(ET.fromstring(z.read(name)).itertext()) for name in z.namelist() if name=='word/document.xml' or name.startswith(('word/header','word/footer')) and name.endswith('.xml')}
        body=contents['word/document.xml'];assert 'Alice 正文区域保存 😀' in body and 'Bob 第二节独立修改 😀' in body and 'Long section 140' in body
        assert sum('Bob 页眉更新 😀 / Alice 审阅后合并' in text for name,text in contents.items() if name.startswith('word/header'))==1
        assert 'Bob 页眉' not in body and any('空页脚新增内容 😀' in text for name,text in contents.items() if name.startswith('word/footer'))
        assert any('Page ' in text and '7' in text for name,text in contents.items() if name.startswith('word/header'))
    assert any('Word fields' in warning['message'] for warning in report['warnings'])
    archive=assets/'browser-regions-r8.hcdz';cli('pack',bundle,'--output',archive);reopened=work/'offline.hcd';cli('unpack',archive,'--output',reopened)
    for n in range(1,9):assert cli('editor-state',reopened,'--revision',n)==states[n]
    def request(route,model=None,scope='reader',data=None):
        headers={'Authorization':'Bearer '+private['tokens'][scope]}
        if model is not None:headers['X-HCD-Flow-Layout-Version']=str(model)
        if data is not None:headers['Content-Type']='application/json'
        req=urllib.request.Request(f"http://127.0.0.1:{private['ports'][0]}/v1/documents/region-ui"+route,headers=headers,data=None if data is None else json.dumps(data).encode())
        try:
            with urllib.request.urlopen(req,timeout=120) as response:return response.status,response.read()
        except urllib.error.HTTPError as error:return error.code,error.read()
    assert request('/word/layout')[0]==426 and request('/word/layout',1)[0]==426
    status,data=request('/word/layout',2);metadata=json.loads(data);assert status==200 and metadata['revision']==8 and metadata['layoutHash']==states[8]['flowLayoutHash']
    assert request('/word/layout?revision=0',1)[0]==200
    assert request('/edits',2,data={'schemaVersion':'hcd-patch/3','documentId':'region-ui','patchId':'read-denied','baseRevision':8,'actor':{},'metadata':{},'operations':[]})[0]==403
    status,data=request('/export/docx?revision=8',2);assert status==200
    (assets/'readonly-http-r8.docx').write_bytes(data)
    assert hashes(bundle)==before
    integration=json.loads((assets/'integration.json').read_text());original=repo/'target/hcd-preview-runtime/hcd-mention-preview-buxo9qtn/mentions-docx.hcd';assert hashes(original)==integration['before']
    result={'nativeBinarySha256':sha(binary),'scope':'Actual browser edits read from immutable native versions, source-free DOCX/HCDZ and authenticated read-only HTTP; no Office desktop/production claim','head':8,'browserJointSaveRevision':2,'jointDirtySourceParts':record['dirtySourceParts'],'peerBodyRevision':3,'personalFooterUndo':4,'personalFooterRedo':5,'emptyFooterAdded':6,'peerHeaderConflict':7,'reviewedMerge':8,'computedFieldReadOnly':True,'allOfflineRevisionsExact':list(range(1,9)),'sourceFreeDocxTextAndStoryPlacement':True,'wordLayoutReadOnlyCurrentAndHistorical':True,'missingAndWrongModelStatus':426,'readerWriteStatus':403,'readerDocxDownloadStatus':200,'fixtureCanonicalBytesUnchangedByVerification':True,'originalUserCanonicalBytesUnchanged':True,'originalUserDraftReadOnlyPreservedAfterExpiredFixtureCredentialRefresh':True,'limits':['mapped Word text/image editing only; rich structural regional CRDT room and slash menus are not activated','no creation/linking of stories or editable section settings','no page-number recalculation/automatic TOC/physical pagination','no original generic HTML document migration','no regional PDF export','management/reminders deferred']}
    (assets/'file-evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');(assets/'fidelity.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
