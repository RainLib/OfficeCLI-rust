#!/usr/bin/env python3
"""Independently read this batch's real browser downloads and owned fixture."""
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

repo = Path(__file__).resolve().parents[1]
root, out = map(lambda value: Path(value).resolve(), sys.argv[1:3])
assert root.parent == repo / 'target/hcd-preview-runtime'
assert root.name.startswith('word-layout-ui-') and not root.is_symlink()
config = json.loads((root / 'private.json').read_text())
assert config['root'] == str(root)
assert config['clean'] and config['draftOnly'] and config['linkUiProxy']
binary = repo / 'target/debug/officecli'
bundle = root / 'region-test.hcd'


def cli(*args):
    result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'],
                            capture_output=True, text=True, check=True, timeout=90)
    return json.loads(result.stdout)['data']


assert cli('validate', bundle)['valid']
assert cli('editor-state', bundle)['revision'] == 6
states = {revision: cli('editor-state', bundle, '--revision', revision) for revision in range(1, 7)}
base = states[1]['flowLayout']
assert len(base['sections']) == 2


def expected_layout(revision):
    layout = copy.deepcopy(base)
    if revision >= 2:
        layout['sections'][0]['page'].update(numberStart=8, numberFormat='upperRoman')
    if revision >= 4:
        layout['sections'][1]['page'].update(numberStart=12, numberFormat='lowerRoman')
    if revision >= 6:
        layout['sections'][1]['page'].pop('numberStart')
        layout['sections'][1]['page'].pop('numberFormat')
    return layout


for revision, state in states.items():
    assert state['flowLayout'] == expected_layout(revision), revision
    assert [block for block in state['blocks'] if block['region'] != 'body'] == [
        block for block in states[1]['blocks'] if block['region'] != 'body']
    text = json.dumps(state['blocks'], ensure_ascii=False)
    assert text.count('Bob 页码协同后保留') == int(revision >= 3)
    assert text.count('重开后续存') == int(revision >= 5)
for previous, revision in [(1, 2), (3, 4), (5, 6)]:
    assert states[previous]['blocks'] == states[revision]['blocks']

assert (out / 'request-r4-before-close.json').read_bytes() == (out / 'request-r4-reopened.json').read_bytes()
requests = json.loads((root / 'page-ui-proxy-records.json').read_text())
original = json.loads((out / 'request-r4-before-close.json').read_text())
submitted = [entry for entry in requests if entry['action'] == 'submit' and entry.get('status') == 200]
assert [entry['response']['revision'] for entry in submitted] == [2, 4, 6]
lost = [entry for entry in submitted if entry['mode'] == 'drop-success-block-retry']
assert len(lost) == 1 and lost[0]['response']['revision'] == 4
assert lost[0]['body']['request'] == original['request']
assert any(entry['action'] == 'check' and entry.get('status') == 200
           and entry['body']['request'] == original['request'] for entry in requests)
clear = json.loads((out / 'request-r6-clear.json').read_text())
assert [(change['field'], change['value']) for change in clear['request']['edits']['changes']] == [
    ('numberStart', None), ('numberFormat', None)]

ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
with zipfile.ZipFile(root / 'sources/region-test.docx') as archive:
    media = {hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()
             if name.startswith('word/media/') and not name.endswith('/')}
assert media
docx_results = []
offline_files = {}
with tempfile.TemporaryDirectory(prefix='numbering-readback-', dir=root) as temporary:
    temporary = Path(temporary)
    for revision in [2, 4, 6]:
        file = out / f'numbering-r{revision}.docx'
        with zipfile.ZipFile(file) as archive:
            document = ET.fromstring(archive.read('word/document.xml'))
            sections = list(document.iter(ns + 'sectPr'))
            assert len(sections) == 2
            for section, expected in zip(sections, expected_layout(revision)['sections']):
                numbering = section.find(ns + 'pgNumType')
                values = {key.removeprefix(ns): value for key, value in numbering.attrib.items()} if numbering is not None else {}
                page = expected['page']
                target = {key: str(page[field]) for key, field in [('start', 'numberStart'), ('fmt', 'numberFormat')] if field in page}
                assert values == target, (revision, values, target)
                size = section.find(ns + 'pgSz')
                assert int(size.get(ns + 'w')) == page['widthTwips']
                assert int(size.get(ns + 'h')) == page['heightTwips']
            text = ''.join(document.itertext())
            assert text.count('Bob 页码协同后保留') == int(revision >= 3)
            assert text.count('重开后续存') == int(revision >= 5)
            exported_media = {hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()
                              if name.startswith('word/media/') and not name.endswith('/')}
            assert media.issubset(exported_media)
        imported = temporary / f'reimport-r{revision}.hcd'
        cli('import', file, '--word-regions', '--output', imported)
        assert cli('validate', imported)['valid']
        imported_sections = cli('editor-state', imported)['flowLayout']['sections']
        for actual, expected in zip(imported_sections, expected_layout(revision)['sections']):
            for field in ['numberStart', 'numberFormat', 'widthTwips', 'heightTwips']:
                assert actual['page'].get(field) == expected['page'].get(field), (revision, field)
        docx_results.append(revision)
    for revision in [2, 6]:
        offline = temporary / f'offline-r{revision}.hcd'
        cli('unpack', out / f'numbering-r{revision}.hcdz', '--output', offline)
        assert cli('validate', offline)['valid']
        for saved in range(1, revision + 1):
            assert cli('editor-state', offline, '--revision', saved) == states[saved]
        offline_files[str(revision)] = sum(path.is_file() for path in offline.rglob('*'))

(out / 'final-projection.json').write_text(json.dumps(states[6], ensure_ascii=False) + '\n')
(out / 'requests.json').write_text(json.dumps(requests, ensure_ascii=False, indent=2) + '\n')
result = {'nativeValidate': True, 'allRevisions': list(states), 'onlyExpectedSectionNumberingChanged': True,
          'pageTransactionsPreserveAllBlocks': True, 'headerFooterBlocksUnchanged': True,
          'exactRequestSurvivesCloseAndRestart': True, 'oneSuccessPerPageRequest': True,
          'clearIsExplicitNull': True, 'actualDocxAndReimport': docx_results,
          'originalMediaBytesPreserved': True, 'actualHcdzHistoricalRevisions': {'2': [1, 2], '6': list(states)},
          'offlineFileCounts': offline_files, 'nativeBinarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
          'notClaimed': ['page field insertion or recalculation', 'precise pagination', 'source-preserving mixed export',
                         'seamless existing peer recovery after sidecar restart', 'desktop Office or production acceptance']}
(out / 'files.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
