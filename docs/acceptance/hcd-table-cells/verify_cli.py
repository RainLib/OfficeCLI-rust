"""Exercise the public table-cell protocol against an immutable native Word source."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid
import xml.etree.ElementTree as ET
from zipfile import ZipFile

REPO = Path(__file__).resolve().parents[3]
BINARY = os.environ.get('OFFICECLI_BIN', str(REPO / 'target/debug/officecli'))
ROOT = Path(tempfile.mkdtemp(prefix='officecli-table-cells-'))
BUNDLE = ROOT / 'table.hcd'
SOURCE = REPO / 'examples/hdoc/editor/e2e/fixtures/word-table-edit.docx'
SOURCE_HASH = hashlib.sha256(SOURCE.read_bytes()).hexdigest()


def cli(*args):
    result = subprocess.run([BINARY, 'hdoc', *map(str, args), '--json'],
                            cwd=REPO, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)['data']


def state():
    current = cli('editor-state', BUNDLE)
    table = next(block for block in current['blocks'] if '<table' in block.get('readOnlyHtml', ''))
    return current, table


def commit(operation, schema='hcd-patch/67', hash_override=None):
    current, table = state()
    operation.update(blockId=table['blockId'], precondition={'blockHash': hash_override or table['blockHash']})
    patch = ROOT / 'patch.json'
    patch.write_text(json.dumps({'schemaVersion': schema, 'documentId': current['documentId'],
        'patchId': str(uuid.uuid4()), 'baseRevision': current['revision'], 'operations': [operation]}))
    return cli('apply', BUNDLE, '--patch', patch, '--expected-revision', current['revision'])


cli('import', SOURCE, '--output', BUNDLE, '--document-id', 'table-cells-cli')
cli('project-editor', BUNDLE, '--expected-revision', 0)
initial, original_table = state()
commit({'op': 'table.cells.merge', 'tableIndex': 0, 'range': {'row': 0, 'column': 0, 'rows': 2, 'columns': 2}})
merged, merged_table = state()
old_revision = merged['revision']
try:
    commit({'op': 'table.cell.split', 'tableIndex': 0, 'row': 0, 'column': 0}, hash_override=original_table['blockHash'])
    raise AssertionError('stale table hash was accepted')
except subprocess.CalledProcessError as error:
    assert 'hash mismatch' in error.stdout + error.stderr
assert state()[0]['revision'] == old_revision

merged_file = ROOT / 'merged.docx'
cli('export', BUNDLE, '--source', SOURCE, '--output', merged_file)
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
with ZipFile(SOURCE) as old, ZipFile(merged_file) as new:
    assert set(old.namelist()) == set(new.namelist())
    unchanged = [name for name in old.namelist() if name != 'word/document.xml']
    assert all(old.read(name) == new.read(name) for name in unchanged)
    doc = ET.fromstring(new.read('word/document.xml'))
    first = doc.find('w:body/w:tbl/w:tr/w:tc', ns)
    assert ''.join(node.text or '' for node in first.findall('.//w:t', ns)) == 'ROW 00Value 00ROW 01Value 01'
    assert first.find('w:tcPr/w:gridSpan', ns).get('{' + ns['w'] + '}val') == '2'
    assert first.find('w:tcPr/w:vMerge', ns).get('{' + ns['w'] + '}val') == 'restart'
    assert first.find('.//w:b', ns) is not None and first.find('.//w:i', ns) is not None

commit({'op': 'table.cell.split', 'tableIndex': 0, 'row': 0, 'column': 0})
_, split = state()
assert len(split['editableTextNodeIds']) == len(original_table['editableTextNodeIds']) + 3
commit({'op': 'table.restore', 'sourceRevision': merged['revision'], 'afterBlockId': None}, schema='hcd-patch/4')
assert state()[1]['blockHash'] == merged_table['blockHash']
assert cli('validate', BUNDLE)['valid']
reopened = ROOT / 'reopened.hcd'
cli('import', merged_file, '--output', reopened, '--document-id', 'table-cells-reopened')
assert cli('validate', reopened)['valid']
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == SOURCE_HASH
print(json.dumps({'status': 'passed', 'output': str(ROOT), 'schema': 'hcd-patch/67',
    'nativeText': 'ROW 00Value 00ROW 01Value 01', 'unchangedParts': unchanged,
    'staleHashRejected': True, 'splitAddedEditableCells': 3, 'guardedRestore': True,
    'sourceUnchanged': True}, ensure_ascii=False, indent=2))
