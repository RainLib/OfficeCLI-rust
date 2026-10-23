#!/usr/bin/env python3
"""Exercise public HCD commands against disposable text and rich-text fixtures."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--officecli', default='target/debug/officecli')
    args = parser.parse_args()
    binary = str(Path(args.officecli).resolve())

    def command(*arguments):
        result = subprocess.run([binary, 'hdoc', *map(str, arguments), '--json'], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(f'{arguments[0]} failed: {result.stderr or result.stdout}')
        return json.loads(result.stdout)['data']

    with tempfile.TemporaryDirectory(prefix='hcd-save-regression-') as temporary:
        root = Path(temporary)
        source = root / 'source.txt'
        source.write_text('abcdefghij\n', encoding='utf-8')
        bundle = root / 'document.hcd'
        command('import', source, '--output', bundle, '--document-id', 'save-regression')
        node = command('extract-text', bundle)['entries'][0]

        def apply(name, revision, operations, schema='hcd-patch/1'):
            patch = root / f'{name}.json'
            patch.write_text(json.dumps({
                'schemaVersion': schema, 'documentId': 'save-regression',
                'patchId': name, 'baseRevision': revision, 'operations': operations,
            }), encoding='utf-8')
            return command('apply', bundle, '--patch', patch, '--expected-revision', revision)

        apply('annotate', 0, [{'op': 'annotation.upsert', 'annotation': {
            'annotationId': 'review', 'nodeId': node['nodeId'], 'start': 7, 'end': 10, 'kind': 'recognition',
        }}])
        changed = apply('shorten', 1, [{
            'op': 'text.splice', 'nodeId': node['nodeId'], 'start': 0,
            'deleteCount': 10, 'insertText': '😀', 'precondition': {'nodeHash': node['nodeHash']},
        }])
        assert any(warning['code'] == 'ANNOTATIONS_INVALIDATED_BY_TEXT_EDIT' for warning in changed['warnings'])
        assert command('validate', bundle)['valid']
        assert 'abcdefghij' in command('get-chunk', bundle, 0, '--revision', 1)['html']
        rewritten = root / 'rewritten.txt'
        command('export', bundle, '--source', source, '--output', rewritten)
        assert rewritten.read_text(encoding='utf-8') == '😀\n'

        command('project-editor', bundle, '--expected-revision', 2)
        state = command('editor-state', bundle)
        block = state['blocks'][0]
        content = {'kind': 'blockquote', 'inlines': [], 'children': [
            {'kind': 'paragraph', 'inlines': [
                {'text': 'Strike 中文😀', 'strike': True, 'underline': True},
                {'text': '\n', 'hardBreak': True}, {'text': 'inline-code', 'code': True},
            ]},
            {'kind': 'code_block', 'language': 'rust', 'inlines': [{'text': 'let x = 1;\nprintln!("😀");'}]},
            {'kind': 'ordered_list', 'listStart': 4, 'inlines': [], 'children': [
                {'kind': 'list_item', 'level': 0, 'inlines': [{'text': 'Nested child'}]},
            ]},
            {'kind': 'horizontal_rule', 'inlines': []},
        ]}
        apply('rich-content', 3, [{'op': 'block.replace', 'blockId': block['blockId'],
              'precondition': {'blockHash': block['blockHash']}, 'block': content}], 'hcd-patch/4')
        assert command('validate', bundle)['valid']
        reopened = command('editor-state', bundle)['blocks'][0]['content']
        assert reopened['children'][0]['inlines'][1]['hardBreak']
        assert reopened['children'][1]['language'] == 'rust'
        assert reopened['children'][2]['listStart'] == 4
        output = root / 'semantic.docx'
        command('export', bundle, '--output', output)
        with zipfile.ZipFile(output) as archive:
            text = ''.join(ET.fromstring(archive.read('word/document.xml')).itertext())
        for required in ['Strike 中文😀', 'inline-code', 'let x = 1;', 'println!("😀");', 'Nested child']:
            assert required in text, required
        print(json.dumps({'passed': True, 'checks': [
            'annotation invalidation after shortening', 'historical text remains readable',
            'source-backed Unicode text export', 'rich HCD save/reopen/validation',
            'semantic DOCX text export',
        ]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
