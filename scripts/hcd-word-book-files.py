#!/usr/bin/env python3
"""Read actual browser-saved book revisions and exported/offline files."""
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
c = json.loads((root / 'private.json').read_text())
assert c['root'] == str(root) and c['clean'] and c['bookSource']
assert out.parent == repo / 'docs/assets'
binary, bundle = repo / 'target/debug/officecli', root / 'region-test.hcd'
assert hashlib.sha256(binary.read_bytes()).hexdigest() == c['nativeBinarySha256']
commands = []
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def cli(*args):
    result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], capture_output=True, text=True, timeout=120)
    commands.append({'args': [str(arg).replace(str(root), '<owned-root>') for arg in args], 'exitCode': result.returncode})
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(result.stdout)['data']


def labels(state):
    return ''.join(inline.get('text', '') for block in state['blocks'] for inline in block['content'].get('inlines', []))


def layout(state):
    result = json.loads(json.dumps(state['flowLayout']))
    for section in result['sections']:
        section.pop('canonicalEndBlockId', None)
    return result


def check_docx(path):
    with zipfile.ZipFile(path) as archive:
        document = ET.fromstring(archive.read('word/document.xml'))
        body = ''.join(node.text or '' for node in document.iter(W + 't'))
        assert body.count('跨节排版正文') == 95 and body.count('第二节正文') == 90
        assert body.count('Bob 跨节同伴') == 1 and 'Body one' in body and 'Body two' in body
        stories = ''.join(''.join(ET.fromstring(archive.read(name)).itertext()) for name in archive.namelist()
                          if name.startswith('word/header') and name.endswith('.xml'))
        assert stories.count('跨节共享页眉') == 1
        sections = list(document.iter(W + 'sectPr'))
        assert len(sections) == 2
        assert sections[1].find(W + 'pgNumType').get(W + 'start') is None
        assert b'data-word-page' not in archive.read('word/document.xml')
        media = [name for name in archive.namelist() if name.startswith('word/media/') and not name.endswith('/')]
        assert media
    return {'file': path.name, 'bodyTextAndBothMembers': True, 'sharedHeaderWrittenOnce': True,
            'derivedPageStartNotWritten': True, 'sections': len(sections), 'mediaEntries': len(media)}


state = cli('editor-state', bundle)
head = state['revision']
assert head >= 6 and labels(state).count('Bob 跨节同伴') == 1
assert layout(state) == layout(c['initialProjection'])
assert state['flowLayout']['sections'][1]['page'].get('numberStart') is None
assert [len([block for block in state['blocks'] if block.get('flowRegionId') == section['id']]) for section in state['flowLayout']['sections']] == [1, 1]
docx, packed = out / f'book-r{head}.docx', out / f'book-r{head}.hcdz'
assert not docx.exists() and not packed.exists()
cli('export', bundle, '--revision', head, '--output', docx)
docx_result = check_docx(docx)
offline, returned = root / 'book-offline.hcd', root / 'book-returned.hcd'
assert not offline.exists() and not returned.exists()
try:
    cli('import', docx, '--word-regions', '--output', returned)
    assert cli('validate', returned)['valid']
    reimported = cli('editor-state', returned)
    assert labels(reimported).count('跨节排版正文') == 95 and labels(reimported).count('第二节正文') == 90
    assert labels(reimported).count('Bob 跨节同伴') == 1 and labels(reimported).count('跨节共享页眉') == 1
    assert len(reimported['flowLayout']['sections']) == 2
    cli('pack', bundle, '--output', packed)
    cli('unpack', packed, '--output', offline)
    assert cli('validate', offline)['valid']
    count = 0
    for file in offline.rglob('*'):
        if file.is_file():
            assert file.read_bytes() == (bundle / file.relative_to(offline)).read_bytes()
            count += 1
    for revision in range(head + 1):
        assert cli('editor-state', offline, '--revision', revision) == cli('editor-state', bundle, '--revision', revision)
    offline_docx = out / f'book-offline-r{head}.docx'
    assert not offline_docx.exists()
    cli('export', offline, '--revision', head, '--output', offline_docx)
    offline_result = check_docx(offline_docx)
finally:
    for owned in [offline, returned]:
        if owned.exists():
            shutil.rmtree(owned)
revisions = cli('list-revisions', bundle)
authors = {record['revision']: record.get('authorId') for record in revisions['revisions']}
assert all(authors[revision] == 'alice' for revision in [2, 3, 4, 5]) and authors[6] == 'bob'
result = {'scope': 'Actual native CLI files from ordinary browser saves, not external Word/WPS layout or app offline startup',
          'head': head, 'docx': docx_result, 'offlineDocx': offline_result,
          'canonicalLayoutAndStoryBindingsUnchanged': True, 'oneParagraphPerBodyRetained': True,
          'reimportTextAndSharedHeader': True, 'offlineCanonicalFilesIdentical': count,
          'offlineExactRevisions': list(range(head + 1)), 'nativeBinaryUnchanged': True,
          'authoredSaves': {revision: authors[revision] for revision in [2, 3, 4, 5, 6]}}
(out / 'files.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
(out / 'revisions.json').write_text(json.dumps(revisions, ensure_ascii=False, indent=2) + '\n')
(out / 'file-commands.json').write_text(json.dumps(commands, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
