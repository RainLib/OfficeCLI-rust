#!/usr/bin/env python3
"""Exercise built-in field creation through real CLI files, without a UI claim."""
import copy
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

repo = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1]).resolve()
assert out.parent == repo / 'docs/assets' and out.name == 'hcd-word-field-insert-2026-10-30'
out.mkdir(exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='word-field-insert-native-', dir=repo / 'target/hcd-preview-runtime'))
binary = repo / 'target/debug/officecli'
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
commands = []


def cli(*args, rejected=False):
    command = [str(binary), 'hdoc', *map(str, args), '--json']
    result = subprocess.run(command, capture_output=True, text=True, timeout=90)
    commands.append({'args': [str(arg).replace(str(root), '<owned-root>') for arg in args], 'exitCode': result.returncode})
    if rejected:
        assert result.returncode != 0
        return
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(result.stdout)['data']


def field(instance, kind, format='inherit'):
    text = f'[{kind}]'
    node = {'schemaVersion': 'hcd.extension/2', 'instanceId': f'x_{instance:032x}',
            'type': 'officecli.word.numeric_field', 'version': 1, 'display': 'inline',
            'data': {'kind': kind, 'format': format}, 'fallback': {'text': text},
            'exports': {target: {'support': 'semantic' if target == 'docx' else 'static',
                                'blocks': [{'kind': 'paragraph', 'runs': [{'text': text}]}]}
                        for target in ['docx', 'xlsx', 'pptx', 'pdf', 'html', 'md', 'txt']}}
    return {'text': text, 'extension': node}


def block(*runs):
    return {'kind': 'paragraph', 'inlines': list(runs)}


def layout_settings(value):
    value = copy.deepcopy(value)
    for section in value['sections']:
        section.pop('canonicalEndBlockId', None)
    return value


def patch(bundle, state, name, operations, regional=True, rejected=False):
    value = {'schemaVersion': 'hcd-patch/6' if regional else 'hcd-patch/4',
             'documentId': state['documentId'], 'patchId': name, 'baseRevision': state['revision'],
             'actor': {'authorId': 'native-field-check', 'authorName': 'Native verification'}}
    value.update({'layoutHash': state['flowLayoutHash'], 'regions': operations} if regional else {'operations': operations})
    file = root / f'{name}.json'
    file.write_text(json.dumps(value, ensure_ascii=False))
    return cli('apply', bundle, '--patch', file, '--expected-revision', state['revision'], rejected=rejected)


def inspect_docx(file, expected, regional=False, layout=None, source_media=None):
    with zipfile.ZipFile(file) as archive:
        instructions = []
        text = ''
        counts = {'begin': 0, 'end': 0}
        for name in archive.namelist():
            if name != 'word/document.xml' and not (name.startswith(('word/header', 'word/footer')) and name.endswith('.xml')):
                continue
            tree = ET.fromstring(archive.read(name))
            instructions += [(name, ''.join(node.itertext()).strip()) for node in tree.iter(W + 'instrText')]
            text += ''.join(node.text or '' for node in tree.iter(W + 't'))
            for node in tree.iter(W + 'fldChar'):
                kind = node.get(W + 'fldCharType')
                if kind in counts:
                    counts[kind] += 1
        assert sorted(value for _, value in instructions) == sorted(expected), instructions
        for part, instruction in instructions:
            assert (part.startswith('word/header') if regional and instruction.startswith('SECTIONPAGES') else part == 'word/document.xml'), (part, instruction)
        assert counts == {'begin': len(expected), 'end': len(expected)}
        settings = ET.fromstring(archive.read('word/settings.xml'))
        updates = list(settings.iter(W + 'updateFields'))
        assert len(updates) == 1 and updates[0].get(W + 'val') == 'true'
        relations = ET.fromstring(archive.read('word/_rels/document.xml.rels'))
        assert sum(node.get('Type', '').endswith('/settings') for node in relations) == 1
        types = ET.fromstring(archive.read('[Content_Types].xml'))
        assert sum(node.get('PartName') == '/word/settings.xml' for node in types) == 1
        if layout is not None:
            document = ET.fromstring(archive.read('word/document.xml'))
            sections = list(document.iter(W + 'sectPr'))
            assert len(sections) == len(layout['sections'])
            for actual, original in zip(sections, layout['sections']):
                size = actual.find(W + 'pgSz')
                assert int(size.get(W + 'w')) == original['page']['widthTwips']
                assert int(size.get(W + 'h')) == original['page']['heightTwips']
        if source_media is not None:
            media = {hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()
                     if name.startswith('word/media/') and not name.endswith('/')}
            assert source_media.issubset(media)
        return {'instructionsByPart': instructions, 'balancedFields': counts['begin'], 'explicitUpdateRequest': True,
                'readablePlaceholders': '[PAGE]' in text and '[NUMPAGES]' in text,
                'fieldPartsVerified': True, 'pageSizesVerified': layout is not None,
                'originalMediaVerified': source_media is not None}


try:
    bundle = root / 'regional.hcd'
    original_source = repo / 'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx'
    with zipfile.ZipFile(original_source) as archive:
        source_media = {hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()
                        if name.startswith('word/media/') and not name.endswith('/')}
    assert source_media
    owned_source = root / 'original.docx'
    shutil.copyfile(original_source, owned_source)
    cli('import', owned_source, '--word-regions', '--document-id', 'insert-regional', '--output', bundle)
    cli('project-editor', bundle, '--word-regions', '--expected-revision', 0)
    owned_source.unlink()
    assert not owned_source.exists()
    initial = cli('editor-state', bundle)
    body = next(item for item in initial['blocks'] if item['region'] == 'body' and not item['readOnly'])
    header = next(item for item in initial['blocks'] if item['region'] == 'header' and not item['readOnly'])
    body_content = block({'text': '页 '}, field(101, 'PAGE', 'upperRoman'), {'text': ' / '}, field(102, 'NUMPAGES'))
    header_content = block({'text': '本节 '}, field(103, 'SECTIONPAGES', 'arabic'))
    groups = [{'regionId': target['flowRegionId'], 'operations': [{'op': 'block.insert', 'afterBlockId': target['blockId'], 'block': content}]}
              for target, content in [(body, body_content), (header, header_content)]]
    patch(bundle, initial, 'insert-fields', groups)
    inserted = cli('editor-state', bundle)
    (out / 'initial-projection.json').write_text(json.dumps(initial, ensure_ascii=False, indent=2) + '\n')
    (out / 'inserted-projection.json').write_text(json.dumps(inserted, ensure_ascii=False, indent=2) + '\n')
    assert inserted['revision'] == 2 and layout_settings(inserted['flowLayout']) == layout_settings(initial['flowLayout'])
    assert sum(bool(inline.get('extension')) for item in inserted['blocks'] for inline in item['content']['inlines']) == 3
    damaged = copy.deepcopy(groups)
    damaged[0]['operations'][0]['block']['inlines'][1]['extension']['data']['kind'] = 'DDE'
    patch(bundle, inserted, 'reject-arbitrary-code', damaged, rejected=True)
    patch(bundle, inserted, 'reject-duplicate-identities', groups, rejected=True)
    assert cli('editor-state', bundle)['revision'] == 2
    added_header = next(item for item in inserted['blocks'] if any(inline.get('extension', {}).get('data', {}).get('kind') == 'SECTIONPAGES' for inline in item['content']['inlines']))
    assert added_header['readOnly'] is False
    patch(bundle, inserted, 'delete-field-block', [{'regionId': added_header['flowRegionId'], 'operations': [{'op': 'block.delete', 'blockId': added_header['blockId'], 'precondition': {'blockHash': added_header['blockHash']}}]}])
    cli('restore', bundle, '--revision', 2, '--expected-revision', 3)
    assert cli('validate', bundle)['valid']
    regional = []
    all_fields = ['PAGE \\* ROMAN', 'NUMPAGES', 'SECTIONPAGES \\* Arabic']
    for revision in [2, 3, 4]:
        expected = all_fields if revision != 3 else all_fields[:2]
        output = out / f'insert-regional-r{revision}.docx'
        cli('export', bundle, '--revision', revision, '--output', output)
        result = inspect_docx(output, expected, regional=True, layout=inserted['flowLayout'], source_media=source_media)
        returned = root / f'returned-{revision}.hcd'
        cli('import', output, '--word-regions', '--output', returned)
        assert cli('validate', returned)['valid']
        view = cli('editor-state', returned)
        html = ''.join(item.get('readOnlyHtml', '') for item in view['blocks'])
        assert html.count('data-hcd-word-field-definition=') == len(expected)
        result.update(revision=revision, reimportReadonlyFields=len(expected))
        regional.append(result)
    archive_file = root / 'insert-regional-r4.hcdz'
    cli('pack', bundle, '--output', archive_file)
    shutil.copyfile(archive_file, out / archive_file.name)
    offline = root / 'offline.hcd'
    cli('unpack', out / 'insert-regional-r4.hcdz', '--output', offline)
    assert cli('validate', offline)['valid']
    count = 0
    for file in offline.rglob('*'):
        if file.is_file():
            assert file.read_bytes() == (bundle / file.relative_to(offline)).read_bytes()
            count += 1
    for revision in range(5):
        assert cli('editor-state', offline, '--revision', revision) == cli('editor-state', bundle, '--revision', revision)
    cli('export', offline, '--revision', 4, '--output', out / 'insert-offline-r4.docx')
    inspect_docx(out / 'insert-offline-r4.docx', all_fields, regional=True, layout=inserted['flowLayout'], source_media=source_media)
    normal = root / 'normal.hcd'
    source = root / 'source.html'
    source.write_text('<html><body><p>Normal semantic document</p></body></html>')
    cli('import', source, '--document-id', 'insert-normal', '--output', normal)
    cli('project-editor', normal, '--expected-revision', 0)
    source.unlink()
    state = cli('editor-state', normal)
    patch(normal, state, 'normal-numeric-atoms', [{'op': 'block.insert', 'afterBlockId': state['blocks'][0]['blockId'], 'block': block(field(111, 'PAGE', 'upperRoman'), field(112, 'NUMPAGES'), field(113, 'SECTIONPAGES', 'arabic'))}], regional=False)
    cli('export', normal, '--revision', 2, '--output', out / 'insert-normal-r2.docx')
    normal_result = inspect_docx(out / 'insert-normal-r2.docx', all_fields)
    assert cli('editor-state', normal)['revision'] == 2
    (out / 'inserted-projection.json').write_text(json.dumps(inserted, ensure_ascii=False, indent=2) + '\n')
    (out / 'commands.json').write_text(json.dumps(commands, ensure_ascii=False, indent=2) + '\n')
    result = {'scope': 'real native CLI with synthetic files; no browser or live collaboration acceptance',
              'regional': regional, 'normalSemanticDocx': normal_result, 'offlineCanonicalFilesIdentical': count,
              'offlineRevisions': list(range(5)), 'arbitraryCodeRejected': True, 'duplicateIdentitiesRejected': True,
              'importedOriginalFilesRemovedBeforeEditsAndExports': True,
              'nativeBinarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'ownedRootRemoved': root.name}
finally:
    assert root.parent == repo / 'target/hcd-preview-runtime' and root.name.startswith('word-field-insert-native-') and not root.is_symlink()
    shutil.rmtree(root)
assert not root.exists()
(out / 'files.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
