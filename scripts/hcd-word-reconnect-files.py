#!/usr/bin/env python3
"""Read this batch's actual downloads and the guarded synthetic fixture only."""
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
root, out = [Path(value).resolve() for value in sys.argv[1:3]]
assert root.parent == repo / 'target/hcd-preview-runtime'
assert root.name.startswith('word-layout-ui-') and not root.is_symlink()
config = json.loads((root / 'private.json').read_text())
assert config['root'] == str(root) and config['clean'] and config['draftOnly'] and config['allowRestart']
assert json.loads((root / 'sidecar-restarted.json').read_text())['generation'] == 1
browser = json.loads((out / 'browser.json').read_text())
assert browser['finalRevision'] == 7
binary, bundle = repo / 'target/debug/officecli', root / 'region-test.hcd'


def cli(*args):
    response = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'],
                              capture_output=True, text=True, check=True, timeout=90)
    return json.loads(response.stdout)['data']


assert cli('validate', bundle)['valid']
assert cli('editor-state', bundle)['revision'] == 7
states = {revision: cli('editor-state', bundle, '--revision', revision) for revision in range(1, 8)}
history = {revision: cli('get-revision', bundle, revision) for revision in range(1, 8)}
expected_actors = {2: 'alice', 3: 'alice', 4: 'bob', 5: 'alice', 6: 'alice', 7: 'bob'}
for revision, actor in expected_actors.items():
    assert history[revision]['authorId'] == actor
    assert history[revision]['authorName'] == {'alice': 'Alice 王', 'bob': 'Bob 李'}[actor]
for revision, state in states.items():
    layout = copy.deepcopy(states[1]['flowLayout'])
    if revision >= 3:
        layout['sections'][0]['page'].update(numberStart=9, numberFormat='upperRoman')
    assert state['flowLayout'] == layout
    assert [block for block in state['blocks'] if block['region'] != 'body'] == [
        block for block in states[1]['blocks'] if block['region'] != 'body']
    text = json.dumps(state['blocks'], ensure_ascii=False)
    assert text.count(browser['markers']['own']) == int(revision >= 2 and revision != 5)
    assert text.count(browser['markers']['peer']) == int(revision >= 4)
    assert text.count(browser['markers']['after']) == int(revision >= 7)

before = json.loads((out / 'requests-before-retry.json').read_text())
after = json.loads((out / 'requests-after-retry.json').read_text())
current = json.loads((root / 'page-ui-proxy-records.json').read_text())
assert before == after == current
successful = [entry for entry in current if entry['action'] == 'submit' and entry.get('status') == 200]
assert len(successful) == 1 and successful[0]['response']['revision'] == 3

ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
with zipfile.ZipFile(root / 'sources/region-test.docx') as archive:
    source_media = {hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()
                    if name.startswith('word/media/') and not name.endswith('/')}
assert source_media
docx_results = []
with tempfile.TemporaryDirectory(prefix='reconnect-readback-', dir=root) as temporary:
    temporary = Path(temporary)
    for revision in [5, 6, 7]:
        file = out / f'reconnected-r{revision}.docx'
        if revision != 7:
            cli('export', bundle, '--revision', revision, '--output', file)
        with zipfile.ZipFile(file) as archive:
            document = ET.fromstring(archive.read('word/document.xml'))
            text = ''.join(document.itertext())
            for key, present in [('own', revision != 5), ('peer', True), ('after', revision == 7)]:
                assert text.count(browser['markers'][key]) == int(present), (revision, key)
            sections = list(document.iter(ns + 'sectPr'))
            assert len(sections) == len(states[revision]['flowLayout']['sections']) == 2
            for section, expected in zip(sections, states[revision]['flowLayout']['sections']):
                page = expected['page']
                number, size = section.find(ns + 'pgNumType'), section.find(ns + 'pgSz')
                assert number.get(ns + 'start') == str(page['numberStart'])
                assert number.get(ns + 'fmt') == page['numberFormat']
                assert int(size.get(ns + 'w')) == page['widthTwips']
                assert int(size.get(ns + 'h')) == page['heightTwips']
            media = {hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()
                     if name.startswith('word/media/') and not name.endswith('/')}
            assert source_media.issubset(media)
        imported = temporary / f'reimport-r{revision}.hcd'
        cli('import', file, '--word-regions', '--output', imported)
        assert cli('validate', imported)['valid']
        imported_state = cli('editor-state', imported)
        for actual, expected in zip(imported_state['flowLayout']['sections'], states[revision]['flowLayout']['sections']):
            for field in ['numberStart', 'numberFormat', 'widthTwips', 'heightTwips']:
                assert actual['page'].get(field) == expected['page'].get(field)
        for key in ['own', 'peer', 'after']:
            present = (key != 'own' or revision != 5) and (key != 'after' or revision == 7)
            assert (browser['markers'][key] in json.dumps(imported_state['blocks'], ensure_ascii=False)) == present
        docx_results.append({'revision': revision, 'download': 'browser' if revision == 7 else 'native CLI fixed revision'})
    offline = temporary / 'offline.hcd'
    cli('unpack', out / 'reconnected-r7.hcdz', '--output', offline)
    assert cli('validate', offline)['valid']
    for revision, expected in states.items():
        assert cli('editor-state', offline, '--revision', revision) == expected
    file_count = 0
    for file in offline.rglob('*'):
        if file.is_file():
            assert file.read_bytes() == (bundle / file.relative_to(offline)).read_bytes()
            file_count += 1

assert cli('editor-state', bundle)['revision'] == 7
(out / 'final-projection.json').write_text(json.dumps(states[7], ensure_ascii=False) + '\n')
(out / 'history.json').write_text(json.dumps(history, ensure_ascii=False, indent=2) + '\n')
result = {'nativeValidate': True, 'verifiedRevisions': list(states), 'actorsVerified': expected_actors,
          'ownUndoPreservesPeer': True, 'ownRedoPreservesPeer': True, 'headersFootersUnchanged': True,
          'pageSettingsRetained': True, 'noOldRoundQueryDuringRetry': True,
          'requestsBeforeAndAfter': len(current), 'onlyOnePageSubmit': True,
          'actualDocxAndReimport': docx_results, 'originalMediaBytesPreserved': True,
          'actualHcdzAllHistoricalStates': True, 'canonicalFilesByteIdentical': file_count,
          'nativeBinarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
          'scope': 'isolated local synthetic Word and controlled graceful sidecar restart'}
(out / 'files.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
