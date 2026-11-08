#!/usr/bin/env python3
"""Verify native/offline files after ordinary UI pagination; no Word layout claim."""
import hashlib
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

repo = Path(__file__).resolve().parents[1]
root, out = (Path(arg).resolve() for arg in sys.argv[1:3])
assert root.parent == repo / 'target/hcd-preview-runtime' and root.name.startswith('word-layout-ui-')
assert not root.is_symlink() and out.parent == repo / 'docs/assets'
c = json.loads((root / 'private.json').read_text())
assert c['root'] == str(root) and c['clean']
binary, bundle = repo / 'target/debug/officecli', root / 'region-test.hcd'
assert hashlib.sha256(binary.read_bytes()).hexdigest() == c['nativeBinarySha256']
commands = []


def cli(*args):
    result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], capture_output=True, text=True, timeout=120)
    commands.append({'args': [str(arg).replace(str(root), '<owned-root>') for arg in args], 'exitCode': result.returncode})
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(result.stdout)['data']


def text(state):
    return ''.join(inline.get('text', '') for block in state['blocks'] for inline in block['content'].get('inlines', []))


state, initial = cli('editor-state', bundle), c['initialProjection']
head = state['revision']
expect_header = '--header' in sys.argv[3:]
assert head >= 3
assert text(state).count('分页正文验证') == 95
assert text(state).count('Bob 同伴保留') == 1
assert 'Body two' in text(state)
if expect_header:
    assert text(state).count('页眉重复位置编辑') == 1
assert state['flowLayout'] == initial['flowLayout']
region = state['flowLayout']['sections'][0]['id']
assert len([block for block in state['blocks'] if block.get('flowRegionId') == region]) == 1
assert 'data-hcd-word-page-flow' not in json.dumps(state)
docx = out / f'paginated-ui-r{head}.docx'
assert not docx.exists()
cli('export', bundle, '--revision', head, '--output', docx)
with zipfile.ZipFile(docx) as archive:
    xml = archive.read('word/document.xml')
    tree = ET.fromstring(xml)
    actual = ''.join(node.text or '' for node in tree.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'))
    assert actual.count('分页正文验证') == 95 and actual.count('Bob 同伴保留') == 1
    assert 'Body two' in actual
    if expect_header:
        stories = ''.join(''.join(ET.fromstring(archive.read(name)).itertext()) for name in archive.namelist()
                          if name.startswith('word/header') and name.endswith('.xml'))
        assert stories.count('页眉重复位置编辑') == 1
    assert b'data-hcd-word-page-flow' not in xml and b'hcd-word-page-break' not in xml
    media = [name for name in archive.namelist() if name.startswith('word/media/') and not name.endswith('/')]
    assert media
packed, offline = out / f'paginated-ui-r{head}.hcdz', root / 'page-flow-offline.hcd'
assert not packed.exists() and not offline.exists()
try:
    cli('pack', bundle, '--output', packed)
    cli('unpack', packed, '--output', offline)
    assert cli('validate', offline)['valid']
    files = 0
    for file in offline.rglob('*'):
        if file.is_file():
            assert file.read_bytes() == (bundle / file.relative_to(offline)).read_bytes()
            files += 1
    for revision in range(head + 1):
        assert cli('editor-state', offline, '--revision', revision) == cli('editor-state', bundle, '--revision', revision)
finally:
    if offline.exists():
        shutil.rmtree(offline)
result = {'scope': 'Actual CLI DOCX/HCDZ from ordinary browser saved content; not browser download, Word/WPS pagination or offline app acceptance',
          'revision': head, 'singleBodyParagraphRetained': True, 'bothMembersTextRetained': True,
          'sectionAndPageSettingsUnchanged': True, 'paginationWidgetsAbsentFromCanonicalAndDocx': True,
          'offlineCanonicalFilesIdentical': files, 'offlineExactRevisions': list(range(head + 1)),
          'docx': docx.name, 'hcdz': packed.name, 'docxMediaEntries': len(media),
          'nativeBinaryUnchanged': True}
result['headerEditedAtRepeatedPaperPosition'] = expect_header
(out / 'files.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
(out / 'file-commands.json').write_text(json.dumps(commands, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
