#!/usr/bin/env python3
"""Reproduce the computed-field guard using a disposable synthetic DOCX."""
import gzip
import hashlib
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
runtime = repo / 'target/hcd-preview-runtime'
runtime.mkdir(parents=True, exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='hcd-field-guard-', dir=runtime))
output = Path(sys.argv[1]).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
binary = repo / 'target/debug/officecli'

def cli(*args, success=True):
    result = subprocess.run([str(binary), *map(str, args), '--json'], capture_output=True, text=True, timeout=120)
    assert (result.returncode == 0) == success, result.stderr + result.stdout
    return json.loads(result.stdout)

cli('create', root / 'base.docx')
with zipfile.ZipFile(root / 'base.docx') as source, zipfile.ZipFile(root / 'source.docx', 'x') as target:
    for item in source.infolist():
        data = source.read(item.filename)
        if item.filename == 'word/document.xml':
            xml = data.decode()
            content = ('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>First heading</w:t></w:r></w:p>'
                       '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">'
                       ' TOC \\o &quot;1-3&quot; \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
                       '<w:r><w:t>Cached first heading ..... 1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>')
            assert '<w:body>' in xml
            data = xml.replace('<w:body>', '<w:body>' + content, 1).encode()
        target.writestr(item, data)

bundle = root / 'document.hcd'
cli('hdoc', 'import', root / 'source.docx', '--output', bundle, '--document-id', 'toc-test')
state = cli('hdoc', 'editor-state', bundle)['data']
blocks = state['blocks']
heading = next(block for block in blocks if any(i.get('text') == 'First heading' for i in block['content'].get('inlines', [])))
field = next(block for block in blocks if any(i.get('text') == 'Cached first heading ..... 1' for i in block['content'].get('inlines', [])))
assert not heading['readOnly'] and field['readOnly']
entries = {entry['nodeId']: entry for path in (bundle / 'maps').rglob('*.gz')
           for entry in json.loads(gzip.decompress(path.read_bytes()))['entries']}

def patch(block, original, replacement, name):
    node = next(item['nodeId'] for item in block['content']['inlines'] if item.get('text') == original)
    entry = entries[node]
    value = {'schemaVersion': 'hcd-patch/1', 'documentId': 'toc-test', 'patchId': name, 'baseRevision': 0,
             'operations': [{'op': 'text.splice', 'nodeId': node, 'start': 0, 'deleteCount': len(original),
                             'insertText': replacement, 'precondition': {'nodeHash': entry['nodeHash']}}]}
    path = root / (name + '.json')
    path.write_text(json.dumps(value))
    return entry, path

field_entry, field_patch = patch(field, 'Cached first heading ..... 1', 'Changed field', 'field')
heading_entry, heading_patch = patch(heading, 'First heading', 'Changed heading', 'heading')
assert field_entry['source']['editable'] is False and heading_entry['source']['editable'] is True
rejected = cli('hdoc', 'apply', bundle, '--patch', field_patch, '--expected-revision', 0, success=False)
assert 'read-only' in rejected['error']['error']
cli('hdoc', 'apply', bundle, '--patch', heading_patch, '--expected-revision', 0)
cli('hdoc', 'export', bundle, '--source', root / 'source.docx', '--output', root / 'source-export.docx')
cli('hdoc', 'export', bundle, '--output', root / 'semantic-export.docx')
with zipfile.ZipFile(root / 'source-export.docx') as archive:
    xml = archive.read('word/document.xml').decode()
    assert all(value in xml for value in ['Changed heading', 'Cached first heading', 'TOC', 'fldChar'])
with zipfile.ZipFile(root / 'semantic-export.docx') as archive:
    xml = archive.read('word/document.xml').decode()
    assert 'Cached first heading' in xml and 'TOC' not in xml and 'fldChar' not in xml
result = {'scope': 'synthetic DOCX and local CLI', 'projectionFieldReadOnly': True, 'fieldPatchRejected': True,
          'neighborHeadingSaved': True, 'sourceExportPreservesFieldAndCachedText': True,
          'semanticExportIsStatic': True, 'revision': 1,
          'sourceExportSha256': hashlib.sha256((root / 'source-export.docx').read_bytes()).hexdigest()}
output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
