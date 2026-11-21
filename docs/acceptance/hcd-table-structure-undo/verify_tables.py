"""Public-fixture CLI acceptance; writes only to a new temporary directory."""
import json
from pathlib import Path
import subprocess
import tempfile
import uuid
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
BINARY = REPO / 'target/debug/officecli'
ROOT = Path(tempfile.mkdtemp(prefix='officecli-table-structure-'))
BUNDLE = ROOT / 'table.hcd'


def cli(*args):
    result = subprocess.run([str(BINARY), 'hdoc', *map(str, args), '--json'],
                            cwd=REPO, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)['data']


def projection():
    return cli('editor-state', BUNDLE)


def commit(operation):
    current = projection()
    patch = ROOT / 'patch.json'
    patch.write_text(json.dumps({'schemaVersion': 'hcd-patch/4',
        'documentId': current['documentId'], 'patchId': str(uuid.uuid4()),
        'baseRevision': current['revision'], 'operations': [operation]}))
    cli('apply', BUNDLE, '--patch', patch, '--expected-revision', current['revision'])
    return projection()


def table(current, block_id=None):
    return next(block for block in current['blocks'] if
        (block_id is None or block['blockId'] == block_id) and
        '<table' in block.get('readOnlyHtml', ''))


def shape(block):
    element = ET.fromstring('<section>' + block['readOnlyHtml'] + '</section>').find('.//table')
    rows = element.findall('./tbody/tr') or element.findall('./tr')
    width = sum(int(cell.get('colspan', '1')) for cell in rows[0] if cell.tag in ('td', 'th'))
    return len(rows), width


cli('import', REPO / 'examples/hdoc/editor/e2e/fixtures/word-table-edit.docx',
    '--output', BUNDLE, '--document-id', 'table-structure-smoke')
cli('project-editor', BUNDLE, '--expected-revision', 0)
original = projection()
block_id = table(original)['blockId']
assert shape(table(original)) == (31, 2)


def edit(action, index):
    block = table(projection(), block_id)
    return commit({'op': 'table.edit', 'blockId': block_id, 'tableIndex': 0,
        'action': action, 'index': index, 'precondition': {'blockHash': block['blockHash']}})


assert shape(table(edit('insertRow', 1), block_id)) == (32, 2)
expanded = edit('insertColumn', 1)
assert shape(table(expanded, block_id)) == (32, 3)
deleted = edit('deleteRow', 1)
assert shape(table(deleted, block_id)) == (31, 3)
restored = commit({'op': 'table.restore', 'blockId': block_id,
    'sourceRevision': expanded['revision'], 'afterBlockId': None,
    'precondition': {'blockHash': table(deleted, block_id)['blockHash']}})
assert table(restored, block_id)['blockHash'] == table(expanded, block_id)['blockHash']
added = commit({'op': 'table.insert', 'afterBlockId': original['blocks'][0]['blockId'],
                'rows': 2, 'columns': 3})
new = next(block for block in added['blocks'] if block['blockId'] not in
           {old['blockId'] for old in restored['blocks']})
assert shape(new) == (2, 3)
assert len(new['editableTextNodeIds']) == 6
assert all(not inline['text'] for inline in new['content']['inlines'])
assert cli('validate', BUNDLE)['valid']
cli('export', BUNDLE, '--output', ROOT / 'table.docx')
print(json.dumps({'result': 'passed', 'rowsColumns': [[31, 2], [32, 2], [32, 3], [31, 3], [32, 3]],
    'newEmptyTable': [2, 3], 'revision': added['revision'], 'output': str(ROOT)}, ensure_ascii=False))
