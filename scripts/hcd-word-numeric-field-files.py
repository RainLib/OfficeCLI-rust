#!/usr/bin/env python3
"""Read saved UI/service revisions and real DOCX/HCDZ files; no browser claim."""
import hashlib
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

repo = Path(__file__).resolve().parents[1]
root, out = [Path(value).resolve() for value in sys.argv[1:3]]
assert root.parent == repo / 'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
assert not root.is_symlink() and out.parent == repo / 'docs/assets'
c = json.loads((root / 'private.json').read_text())
assert c['root'] == str(root) and c['clean']
socket = json.loads((out / 'socket.json').read_text())
bundle, binary = root / 'region-test.hcd', repo / 'target/debug/officecli'
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
commands = []


def cli(*args):
    result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], capture_output=True, text=True, timeout=90)
    commands.append({'args': [str(arg).replace(str(root), '<owned-root>') for arg in args], 'exitCode': result.returncode})
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(result.stdout)['data']


def fields(state):
    return [(block['region'], inline['extension']) for block in state['blocks']
            for inline in block['content']['inlines'] if inline.get('extension')]


def content(state):
    return ''.join(inline['text'] for block in state['blocks'] for inline in block['content']['inlines'])


def inspect(file, state):
    expected = sorted((value['data']['kind'] + {'inherit': '', 'upperRoman': r' \* ROMAN', 'arabic': r' \* Arabic'}[value['data']['format']]) for _, value in fields(state))
    with zipfile.ZipFile(file) as archive:
        instructions, counts, text = [], {'begin': 0, 'end': 0}, ''
        for name in archive.namelist():
            if name != 'word/document.xml' and not re.fullmatch(r'word/(?:header|footer)\d+\.xml', name):
                continue
            tree = ET.fromstring(archive.read(name))
            for node in tree.iter(W + 'instrText'):
                instruction = ''.join(node.itertext()).strip()
                assert name.startswith('word/header') if instruction.startswith('SECTIONPAGES') else name == 'word/document.xml'
                instructions.append(instruction)
            text += ''.join(node.text or '' for node in tree.iter(W + 't'))
            for node in tree.iter(W + 'fldChar'):
                kind = node.get(W + 'fldCharType')
                if kind in counts:
                    counts[kind] += 1
        assert sorted(instructions) == expected, instructions
        assert counts == {'begin': len(expected), 'end': len(expected)}
        assert 'Body one' in text and 'Body two' in text
        assert ('Bob 页码协同' in text) == (state['revision'] >= socket['merged'])
        settings = ET.fromstring(archive.read('word/settings.xml'))
        assert len(list(settings.iter(W + 'updateFields'))) == 1
        assert settings.find(W + 'updateFields').get(W + 'val') == 'true'
        sections = list(ET.fromstring(archive.read('word/document.xml')).iter(W + 'sectPr'))
        assert len(sections) == len(state['flowLayout']['sections'])
        for section, original in zip(sections, state['flowLayout']['sections']):
            size = section.find(W + 'pgSz')
            assert (int(size.get(W + 'w')), int(size.get(W + 'h'))) == (original['page']['widthTwips'], original['page']['heightTwips'])
        media = {hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist() if name.startswith('word/media/') and not name.endswith('/')}
        assert source_media.issubset(media)
    returned = root / (file.stem + '-returned.hcd')
    assert not returned.exists()
    try:
        cli('import', file, '--word-regions', '--output', returned)
        assert cli('validate', returned)['valid']
        projection = cli('editor-state', returned)
        readonly = ''.join(block.get('readOnlyHtml', '') for block in projection['blocks'])
        assert readonly.count('data-hcd-word-field-definition=') == len(expected)
    finally:
        if returned.exists():
            shutil.rmtree(returned)
    return {'file': file.name, 'instructions': instructions, 'balancedControls': counts['begin'],
            'updateOnOpen': True, 'paperAndMediaPreserved': True, 'reimportReadonlyFields': len(expected)}


with zipfile.ZipFile(repo / 'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx') as archive:
    source_media = {hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist() if name.startswith('word/media/') and not name.endswith('/')}
assert source_media and cli('validate', bundle)['valid']
states = {revision: cli('editor-state', bundle, '--revision', revision) for revision in range(1, socket['withHeader'] + 1)}
assert cli('editor-state', bundle)['revision'] == socket['withHeader']
assert not fields(states[1]) and not fields(states[2])
assert fields(states[3])[0][1]['data'] == {'kind': 'PAGE', 'format': 'inherit'}
assert fields(states[4])[0][1]['data'] == {'kind': 'PAGE', 'format': 'upperRoman'}
assert len({fields(states[revision])[0][1]['instanceId'] for revision in range(3, 9)}) == 1
for revision, kind in [(5, 'NUMPAGES'), (6, 'PAGE'), (7, 'NUMPAGES')]:
    assert fields(states[revision])[0][1]['data']['kind'] == kind
    assert content(states[revision]).count('Bob 页码协同') == 1
docx = []
for revision in [3, 4, 5, 6, 7, 8]:
    file = out / f'field-r{revision}.docx'
    cli('export', bundle, '--revision', revision, '--output', file)
    docx.append(inspect(file, states[revision]))
archive_file, offline = out / 'field-r8.hcdz', root / 'numeric-offline.hcd'
assert not offline.exists()
try:
    cli('pack', bundle, '--output', archive_file)
    cli('unpack', archive_file, '--output', offline)
    assert cli('validate', offline)['valid']
    count = 0
    for file in offline.rglob('*'):
        if file.is_file():
            assert file.read_bytes() == (bundle / file.relative_to(offline)).read_bytes()
            count += 1
    for revision in range(9):
        assert cli('editor-state', offline, '--revision', revision) == cli('editor-state', bundle, '--revision', revision)
    file = out / 'offline-field-r8.docx'
    cli('export', offline, '--revision', 8, '--output', file)
    offline_docx = inspect(file, states[8])
finally:
    if offline.exists():
        shutil.rmtree(offline)
result = {'scope': 'Actual CLI files from UI r3/r4 and service r5-r8; no browser-download or Word/WPS calculation claim',
          'docx': docx, 'offlineDocx': offline_docx, 'canonicalFilesIdentical': count,
          'offlineHistoryRevisions': list(range(9)), 'editableExtensionIdentityPreservedInHcdz': True,
          'uiIntermediateSlashSaveAtR2': True, 'finalRevision': 8}
(out / 'file-commands.json').write_text(json.dumps(commands, ensure_ascii=False, indent=2) + '\n')
(out / 'files.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
