#!/usr/bin/env python3
"""Verify actual browser/native HTML mark round trips in an owned fixture."""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def main():
    repo = Path(__file__).resolve().parents[1]
    config = json.loads(Path(sys.argv[1]).read_text())
    root = Path(config['root'])
    assert root.parent == repo / 'target/hcd-preview-runtime' and root.name.startswith('hcd-mention-preview-')
    bundle = root / 'mentions-docx.hcd'
    before = (bundle / 'manifest.json').read_bytes()
    assert json.loads(before)['revision'] == 6
    assets = repo / 'docs/assets/hcd-mark-html-roundtrip-2026-10-26'
    work = Path(tempfile.mkdtemp(prefix='html-files-', dir=root))
    binary = repo / 'target/debug/officecli'

    def cli(*args):
        return json.loads(subprocess.check_output([str(binary), 'hdoc', *map(str, args), '--json']))['data']

    def state(revision, path=bundle):
        return cli('editor-state', path, '--revision', revision)

    def inlines(value):
        return [inline for block in value['blocks'] for inline in block['content']['inlines']]

    def text(value):
        return ''.join(inline['text'] for inline in inlines(value))

    projections = {revision: state(revision) for revision in range(1, 7)}
    final = projections[6]
    payloads = json.loads((assets / 'payloads.json').read_text())
    for revision, value in projections.items():
        marked = [inline for inline in inlines(value) if inline.get('customMarks')]
        for inline in marked:
            assert not inline.get('bold') and not inline.get('underline')
            assert inline['customMarks'] == payloads['unknown' if inline['text'] == '未来业务中😀' else 'known']
            if inline['text'] != '未来业务中😀':
                assert inline['textColor'] == '#123456'
                # Text-only native edits retain a zero-length source carrier
                # after deletion. It is archival formatting, not visible text.
                if not inline['text']:
                    assert revision == 4
                    assert inline['nodeId'] == projections[3]['blocks'][3]['content']['inlines'][1]['nodeId']
                assert inline.get('backgroundColor') == ('#dcebfa' if inline['text'] in ['', '粘贴标记中😀'] else None)
        assert text(value).count('Bob 保留') == int(revision >= 3)
        assert text(value).count('粘贴标记中😀') == (2 if revision == 6 else int(revision in [2, 3, 5]))
        assert '不得出现' not in text(value)
        ids = [inline['nodeId'] for inline in inlines(value)]
        assert len(ids) == len(set(ids)) and 'n_' + 'a' * 32 not in ids
        for original in projections[1]['blocks'][:3]:
            current = next(block for block in value['blocks'] if block['blockId'] == original['blockId'])
            for old in original['content']['inlines']:
                if old.get('customMarks'):
                    assert next(inline for inline in current['content']['inlines'] if inline['nodeId'] == old['nodeId']) == old
    assert projections[3]['blocks'] == projections[5]['blocks']
    archive = work / 'marked-html-r6.hcdz'
    cli('pack', bundle, '--output', archive)
    offline = work / 'source-free/marked.hcd'
    offline.parent.mkdir()
    cli('unpack', archive, '--output', offline)
    assert cli('validate', offline)['valid']
    assert not (offline.parent / 'sources').exists()
    for revision in projections:
        assert state(revision, offline) == projections[revision]
    shutil.copyfile(archive, assets / archive.name)

    def clean(content):
        if isinstance(content, list):
            return [clean(item) for item in content]
        if isinstance(content, dict):
            return {key: clean(value) for key, value in content.items() if key != 'nodeId'}
        return content

    browser_html = Path(sys.argv[2])
    reimported = work / 'reimported.hcd'
    cli('import', browser_html, '--output', reimported, '--document-id', 'html-reimport')
    assert cli('validate', reimported)['valid']
    reread = state(0, reimported)
    assert clean([block['content'] for block in reread['blocks']]) == clean([block['content'] for block in final['blocks']])
    shutil.copyfile(browser_html, assets / 'browser-r6.html')

    original = work / 'original-r1.html'
    cli('export', bundle, '--source', root / 'fixture.html', '--revision', 1, '--to', 'html', '--output', original)
    assert original.read_bytes() == (root / 'fixture.html').read_bytes()
    files = []
    for fmt in ['docx', 'pptx', 'pdf', 'md']:
        output = work / f'offline-r6.{fmt}'
        cli('export', offline, '--to', fmt, '--output', output)
        visible = output.read_text() if fmt == 'md' else subprocess.check_output([str(binary), 'view', str(output), 'text'], text=True)
        for needle in ['共同文本中😀', '未来业务中😀', 'Bob 保留']:
            assert visible.count(needle) == 1, (fmt, needle)
        assert visible.count('粘贴标记中😀') == 2
        assert '不得出现' not in visible
        shutil.copyfile(output, assets / output.name)
        files.append({'file': output.name, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()})

    downloaded = Path(sys.argv[3])
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    with zipfile.ZipFile(downloaded) as package:
        xml = ET.fromstring(package.read('word/document.xml'))
        for needle, count, background in [('共同文本中😀', 1, 'fff2a8'), ('粘贴标记中😀', 2, 'dcebfa')]:
            runs = [run for run in xml.findall('.//w:r', ns) if needle in ''.join(run.itertext())]
            assert len(runs) == count
            for run in runs:
                properties = run.find('w:rPr', ns)
                assert properties.find('w:b', ns) is not None and properties.find('w:u', ns) is not None
                assert properties.find('w:color', ns).attrib['{' + ns['w'] + '}val'].lower() == '123456'
                assert properties.find('w:shd', ns).attrib['{' + ns['w'] + '}fill'].lower() == background
        assert not any(b'HCD-27' in package.read(name) for name in package.namelist())
    shutil.copyfile(downloaded, assets / 'browser-r6.docx')
    probes = [json.loads(path.read_text()) for path in sorted((root / 'checkpoint-probe').glob('*.json'))]
    assert len(probes) == 5 and all(probe['status'] == 200 for probe in probes)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(config['origin'] + '/v1/documents/mentions-docx/export-capabilities?revision=6', headers={'Authorization': 'Bearer ' + config['reader']})
    report = json.load(opener.open(request))
    feature = next(item for item in report['features'] if item['kind'] == 'custom_mark')
    assert feature['count'] == 7 and feature['formats']['html']['dataRetention'] == 'embedded' and feature['formats']['docx']['dataRetention'] == 'omitted'
    assert (bundle / 'manifest.json').read_bytes() == before
    (assets / 'file-evidence.json').write_text(json.dumps({
        'scope': 'Owned text-only HTML fixture, real browser paste/copy/undo/peer save/downloads, native/source-free files. Not images, full HTML/CSS fidelity, real Office, production or restart acceptance.',
        'head': 6, 'canonicalEquality': [3, 5], 'sourceIdsPreservedAndCopiesDistinct': True,
        'htmlReimportContentExactIgnoringNewSourceIds': True, 'unknownBusinessVersionPreserved': 17,
        'fallbackDoesNotPolluteOrdinaryFormatting': True, 'sourceFreeVersionsExact': list(projections),
        'r4RetainsZeroLengthSourceCarrierWithoutVisibleText': True,
        'sourceBackedUneditedHtmlExact': True, 'browserDocxStylesVerified': True,
        'firstNativeCheckpoints': 5, 'all200': True, 'headUnchanged': True, 'capabilities': report, 'files': files,
    }, ensure_ascii=False, indent=2) + '\n')
    print('PASS r1-r6, own undo/redo exact, independent copied sources, source-free versions, browser HTML reimport, browser DOCX styles and DOCX/PPTX/PDF/MD text; five checkpoints200')


if __name__ == '__main__':
    main()
