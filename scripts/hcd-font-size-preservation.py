#!/usr/bin/env python3
"""Verify partial font-size saves and native DOCX fidelity through public CLI commands."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile


def exercise(binary, root):
    root.mkdir(parents=True, exist_ok=True)
    source, bundle = root / 'source.docx', root / 'source-size.hcd'
    word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    parts = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        'word/styles.xml': f'<w:styles xmlns:w="{word}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Noto Sans CJK SC"/><w:sz w:val="28"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="AuditBody"><w:name w:val="Audit body"/><w:pPr><w:ind w:left="480"/><w:spacing w:after="180"/></w:pPr></w:style><w:style w:type="character" w:styleId="AuditRun"><w:name w:val="Audit character"/><w:rPr><w:color w:val="315EA8"/></w:rPr></w:style></w:styles>',
        'word/document.xml': f'<w:document xmlns:w="{word}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p><w:r><w:t>字号保存与原稿样式验证</w:t></w:r></w:p><w:p w14:paraId="A001"><w:pPr><w:pStyle w:val="AuditBody"/><w:keepNext/></w:pPr><w:bookmarkStart w:id="1" w:name="original"/><w:r w14:textId="B001"><w:rPr><w:rStyle w:val="AuditRun"/><w:rFonts w:ascii="Arial" w:eastAsia="Noto Sans CJK SC"/><w:b/><w:sz w:val="28"/><w:szCs w:val="32"/><w:spacing w:val="20"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr><w:t>A中😀 B</w:t><w:tab/><w:t>after</w:t><w:br/></w:r><w:bookmarkEnd w:id="1"/></w:p><w:p><w:r><w:t>未编辑段落 / untouched paragraph</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
    }
    with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)

    def command(*arguments, success=True):
        result = subprocess.run([str(binary), 'hdoc', *map(str, arguments), '--json'], capture_output=True, text=True)
        if not success:
            assert result.returncode, 'stale format unexpectedly accepted'
            return
        if result.returncode:
            raise RuntimeError(f'{arguments[0]} failed: {result.stderr or result.stdout}')
        return json.loads(result.stdout)['data']

    def patch(name, revision, operations, success=True):
        path = root / f'{name}.json'
        path.write_text(json.dumps({'schemaVersion': 'hcd-patch/5', 'documentId': 'source-size', 'patchId': name, 'baseRevision': revision, 'operations': operations}, ensure_ascii=False), encoding='utf-8')
        return command('apply', bundle, '--patch', path, '--expected-revision', revision, success=success)

    command('import', source, '--output', bundle, '--document-id', 'source-size')
    node = next(entry for entry in command('extract-text', bundle)['entries'] if entry['text'] == 'A中😀 B')
    original = command('get-node', bundle, node['nodeId'])
    runs = [{'chars': 1}, {'chars': 2, 'sizePt': 28.5}, {'chars': 2}]
    operation = {'op': 'text.runs', 'nodeId': node['nodeId'], 'text': node['text'], 'runs': runs,
                 'precondition': {'nodeHash': original['nodeHash'], 'formatHash': original['formatHash']}}
    saved = patch('partial-size', 0, [operation])
    assert saved['revision'] == 1
    changed = command('get-node', bundle, node['nodeId'])
    assert changed['nodeHash'] == original['nodeHash'] and changed['formatHash'] != original['formatHash']
    assert changed['source'] == original['source'] and changed['fontSizeRuns'] == runs
    patch('reject-stale-size', 1, [operation], success=False)
    patch('text-after-size', 1, [{'op': 'text.splice', 'nodeId': node['nodeId'], 'start': 1, 'deleteCount': 1,
                               'insertText': '中文', 'precondition': {'nodeHash': changed['nodeHash']}}])
    after = command('get-node', bundle, node['nodeId'])
    assert after['text'] == 'A中文😀 B' and after['fontSizeRuns'][1] == {'chars': 3, 'sizePt': 28.5}
    assert command('validate', bundle)['valid']
    command('render-html', bundle, '--output', root / 'preview.html')
    native = root / 'native.docx'
    report = command('export', bundle, '--source', source, '--output', native)
    with zipfile.ZipFile(source) as old, zipfile.ZipFile(native) as new:
        for name in old.namelist():
            if name != 'word/document.xml':
                assert old.read(name) == new.read(name), name
        doc = ET.fromstring(new.read('word/document.xml'))
    q = lambda name: f'{{{word}}}{name}'
    sized = [run for run in doc.iter(q('r')) if (size := run.find(f'{q("rPr")}/{q("sz")}')) is not None and size.get(q('val')) == '57']
    assert len(sized) == 1
    assert ''.join(node.text or '' for node in sized[0].iter(q('t'))) == '中文😀'
    assert sized[0].find(f'{q("rPr")}/{q("rStyle")}').get(q('val')) == 'AuditRun'
    assert sized[0].find(f'{q("rPr")}/{q("spacing")}').get(q('val')) == '20'
    assert len(list(doc.iter(q('tab')))) == 1 and len(list(doc.iter(q('br')))) == 1
    assert len(list(doc.iter(q('bookmarkStart')))) == 1
    historical = root / 'historical.docx'
    command('export', bundle, '--source', source, '--output', historical, '--revision', 0)
    with zipfile.ZipFile(historical) as old:
        assert old.read('word/document.xml') == parts['word/document.xml'].encode()
    semantic = root / 'semantic.docx'
    command('export', bundle, '--output', semantic)
    with zipfile.ZipFile(semantic) as archive:
        rebuilt = ET.fromstring(archive.read('word/document.xml'))
    assert any(''.join(text.text or '' for text in run.iter(q('t'))) == '中文😀' and (size := run.find(f'{q("rPr")}/{q("sz")}')) is not None and size.get(q('val')) == '57' for run in rebuilt.iter(q('r')))
    evidence = {'passed': True, 'revision': after['revision'], 'nodeId': node['nodeId'], 'sourcePreserved': True,
                'checks': ['partial Unicode size', 'format CAS', 'text edit after size', 'HCD validation', 'native and semantic size export', 'unmodified ZIP entries', 'named styles and spacing', 'nontext children once', 'immutable history'], 'nativeReport': report}
    (root / 'evidence.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(evidence, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--officecli', default='target/debug/officecli')
    parser.add_argument('--work-dir', type=Path, help='Keep the disposable fixture and exports in a new directory')
    args = parser.parse_args()
    binary = Path(args.officecli).resolve()
    if args.work_dir:
        assert not args.work_dir.exists(), 'work directory must be new'
        exercise(binary, args.work_dir)
    else:
        with tempfile.TemporaryDirectory(prefix='hcd-source-size-') as directory:
            exercise(binary, Path(directory))


if __name__ == '__main__':
    main()
