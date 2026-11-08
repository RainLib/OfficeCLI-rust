#!/usr/bin/env python3
"""Read actual field-export downloads and fixed revisions of one owned fixture."""
import hashlib
import html
import json
import re
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
assert config['root'] == str(root) and config['numericFields'] and config['clean']
browser = json.loads((out / 'browser.json').read_text())
assert browser['finalRevision'] == 5
binary, bundle = repo / 'target/debug/officecli', root / 'region-test.hcd'
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
expected_instructions = ['NUMPAGES', 'PAGE', r'PAGE \* ROMAN', 'SECTIONPAGES']


def cli(*args):
    result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'],
                            capture_output=True, text=True, check=True, timeout=90)
    return json.loads(result.stdout)['data']


def definitions(state):
    values = []
    for block in state['blocks']:
        encoded = re.findall(r'data-hcd-word-field-definition="([^"]*)"', block.get('readOnlyHtml', ''))
        if encoded:
            assert block['readOnly'] is True
        values.extend(json.loads(html.unescape(value)) for value in encoded)
    return sorted(values, key=lambda value: value['fieldId'])


def text(state):
    return '\n'.join(''.join(run.get('text', '') for run in block['content'].get('inlines', []))
                     for block in state['blocks'])


def read_docx(file, state):
    fields = []
    with zipfile.ZipFile(file) as archive:
        names = [name for name in archive.namelist() if name == 'word/document.xml'
                 or re.fullmatch(r'word/(?:header|footer)\d+\.xml', name)]
        all_text = ''
        for name in names:
            tree = ET.fromstring(archive.read(name))
            parents = {child: parent for parent in tree.iter() for child in parent}

            def ancestor(node, tag):
                while node in parents:
                    node = parents[node]
                    if node.tag == W + tag:
                        return node
                return None

            stack = []
            for node in tree.iter():
                assert node.tag != W + 'fldSimple', 'numeric controls should use typed complex fields'
                if node.tag == W + 'fldChar':
                    kind = node.get(W + 'fldCharType')
                    if kind == 'begin':
                        assert node.get(W + 'dirty') == 'true'
                        stack.append({'instruction': '', 'cached': '', 'separate': False,
                                      'beginParagraph': ancestor(node, 'p'), 'cells': set(), 'bold': False})
                    elif kind == 'separate':
                        assert stack and not stack[-1]['separate']
                        stack[-1]['separate'] = True
                    elif kind == 'end':
                        assert stack and stack[-1]['separate']
                        field = stack.pop()
                        field['crossParagraph'] = field.pop('beginParagraph') is not ancestor(node, 'p')
                        field['inTable'] = bool(field.pop('cells'))
                        field['instruction'] = field['instruction'].strip()
                        field['part'] = name
                        fields.append(field)
                elif node.tag == W + 'instrText':
                    assert stack and not stack[-1]['separate']
                    assert node.get('{http://www.w3.org/XML/1998/namespace}space') == 'preserve'
                    stack[-1]['instruction'] += node.text or ''
                elif node.tag == W + 't':
                    value = node.text or ''
                    all_text += value
                    for field in stack:
                        if field['separate']:
                            field['cached'] += value
                            cell = ancestor(node, 'tc')
                            if cell is not None:
                                field['cells'].add(cell)
                            run = ancestor(node, 'r')
                            field['bold'] |= run is not None and run.find(W + 'rPr/' + W + 'b') is not None
            assert not stack, name
        assert sorted(field['instruction'] for field in fields) == expected_instructions
        by_instruction = {field['instruction']: field for field in fields}
        assert by_instruction[r'PAGE \* ROMAN']['cached'] == 'VIII'
        assert by_instruction[r'PAGE \* ROMAN']['bold']
        assert by_instruction['NUMPAGES']['cached'] == '12 total pages'
        assert by_instruction['NUMPAGES']['crossParagraph']
        assert by_instruction['SECTIONPAGES']['cached'] == '3'
        assert by_instruction['SECTIONPAGES']['inTable']
        assert by_instruction['PAGE']['cached'] == ''
        assert all(field['part'].startswith('word/header') for field in fields)
        assert 'Saved field date' in all_text and 'Saved char format' in all_text
        assert all_text.count('Alice 页码域保留') == int(state['revision'] != 4)
        assert all_text.count('Bob 页码协同正文') == 1
        settings = ET.fromstring(archive.read('word/settings.xml'))
        updates = list(settings.iter(W + 'updateFields'))
        assert len(updates) == 1 and updates[0].get(W + 'val') == 'true'
        body = ET.fromstring(archive.read('word/document.xml'))
        sections = list(body.iter(W + 'sectPr'))
        assert len(sections) == len(state['flowLayout']['sections']) == 2
        for section, expected in zip(sections, state['flowLayout']['sections']):
            size = section.find(W + 'pgSz')
            assert int(size.get(W + 'w')) == expected['page']['widthTwips']
            assert int(size.get(W + 'h')) == expected['page']['heightTwips']
        media = {hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()
                 if name.startswith('word/media/') and not name.endswith('/')}
        assert source_media.issubset(media)
    return fields


assert cli('validate', bundle)['valid']
states = {revision: cli('editor-state', bundle, '--revision', revision) for revision in range(1, 6)}
assert cli('editor-state', bundle)['revision'] == 5
base_definitions = definitions(states[1])
assert len(base_definitions) == 6
assert sorted(value['instruction'].strip() for value in base_definitions) == sorted(
    [*expected_instructions, 'DATE', r'PAGE \* CHARFORMAT'])
history = {revision: cli('get-revision', bundle, revision) for revision in range(1, 6)}
for revision, state in states.items():
    assert state['flowLayout'] == states[1]['flowLayout']
    assert definitions(state) == base_definitions
    assert text(state).count('Alice 页码域保留') == int(revision in [2, 3, 5])
    assert text(state).count('Bob 页码协同正文') == int(revision >= 3)
    if revision > 1:
        actor = 'bob' if revision == 3 else 'alice'
        assert history[revision]['authorId'] == actor
        assert history[revision]['authorName'] == {'alice': 'Alice 王', 'bob': 'Bob 李'}[actor]
with zipfile.ZipFile(root / 'sources/region-test.docx') as archive:
    source_media = {hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()
                    if name.startswith('word/media/') and not name.endswith('/')}
assert source_media
results = []
with tempfile.TemporaryDirectory(prefix='field-export-readback-', dir=root) as temporary:
    temporary = Path(temporary)
    for revision in [3, 4, 5]:
        file = out / f'fields-r{revision}.docx'
        if revision == 4:
            cli('export', bundle, '--revision', revision, '--output', file)
        fields = read_docx(file, states[revision])
        imported = temporary / f'reimport-r{revision}.hcd'
        cli('import', file, '--word-regions', '--output', imported)
        assert cli('validate', imported)['valid']
        returned = cli('editor-state', imported)
        returned_definitions = definitions(returned)
        assert sorted(value['instruction'].strip() for value in returned_definitions) == expected_instructions
        assert text(returned).count('Alice 页码域保留') == int(revision != 4)
        assert text(returned).count('Bob 页码协同正文') == 1
        results.append({'revision': revision, 'origin': 'native fixed revision' if revision == 4 else 'browser download',
                        'fields': fields, 'reimportReadonlyFields': len(returned_definitions)})
    offline = temporary / 'offline.hcd'
    cli('unpack', out / 'fields-r5.hcdz', '--output', offline)
    assert cli('validate', offline)['valid']
    count = 0
    for file in offline.rglob('*'):
        if file.is_file():
            assert file.read_bytes() == (bundle / file.relative_to(offline)).read_bytes()
            count += 1
    for revision, state in states.items():
        assert cli('editor-state', offline, '--revision', revision) == state
    cli('export', offline, '--revision', 5, '--output', out / 'fields-offline-r5.docx')
    offline_fields = read_docx(out / 'fields-offline-r5.docx', states[5])
assert cli('editor-state', bundle)['revision'] == 5
(out / 'final-projection.json').write_text(json.dumps(states[5], ensure_ascii=False) + '\n')
(out / 'history.json').write_text(json.dumps(history, ensure_ascii=False, indent=2) + '\n')
result = {'numericInstructions': expected_instructions, 'verifiedRevisions': list(states),
          'canonicalSixDefinitionsUnchanged': True, 'readonlyOnReimport': True,
          'originalMediaPreserved': True, 'sectionSizesPreserved': True,
          'actualDocxAndReimport': results, 'offlineNumericFields': len(offline_fields),
          'staticUnsupportedFields': ['DATE', r'PAGE \* CHARFORMAT'],
          'canonicalFilesByteIdentical': count, 'exportDoesNotChangeHead': True,
          'nativeBinarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
          'scope': 'local synthetic ordinary Word browser, native DOCX and HCDZ readback; no target application recalculation'}
(out / 'files.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
