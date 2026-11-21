"""Public mixed XLSX content contract, atomicity and native source roundtrip."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
from zipfile import ZipFile
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=Path, default=REPO / 'target/debug/officecli')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='hcd-rich-paste-cli-'))
source = root / 'source.xlsx'
runpy.run_path(str(REPO / 'docs/acceptance/hcd-xlsx-rich-text/make_fixture.py'))['make_fixture'](source)
# Exercise each native creation shape: absent cell, empty row, styled empty
# cell and a row absent from the source XML. Only this temporary fixture changes.
with ZipFile(source) as archive:
    parts = [(info, archive.read(info.filename)) for info in archive.infolist()]
with ZipFile(source, 'w') as archive:
    for info, content in parts:
        if info.filename == 'xl/worksheets/sheet1.xml':
            content = content.replace(b'</sheetData>', b'<row r="5"/><row r="6"><c r="B6" s="0"/></row></sheetData>')
        archive.writestr(info, content)
original = source.read_bytes()


def command(*argv, fail=False, hdoc=True):
    proc = subprocess.run([str(args.binary.resolve()), *(['hdoc'] if hdoc else []), *map(str, argv), '--json'],
                          cwd=REPO, capture_output=True, text=True)
    if fail:
        assert proc.returncode != 0, proc.stdout
        return
    assert proc.returncode == 0, proc.stderr or proc.stdout
    payload = json.loads(proc.stdout)
    assert payload['success'], payload
    return payload['data']


caps = command('capabilities', hdoc=False)
assert caps['xlsxContentBatch']['atomic']
assert 'xlsx.richText.create' in caps['patchSchemas']['hcd-patch/50']['operations']
bundle = root / 'input.hcd'
manifest = command('import', source, '--output', bundle, '--document-id', 'rich-paste-cli')
sheet = command('get-index-page', bundle, 0)['indexPage']['chunks'][0]['grid']['sheetId']


def entries():
    return {n['source']['paragraphId']: n for n in command('extract-text', bundle)['entries']}


def node(address):
    return command('get-node', bundle, entries()[address]['nodeId'])


def guarded(op, address, **fields):
    n = node(address)
    return {'op': op, 'nodeId': n['nodeId'], 'precondition': {'nodeHash': n['nodeHash']}, **fields}


runs = [{'text': '新增😀', 'properties': {'b': {'val': '1'}, 'color': {'rgb': 'FF228844'}}},
        {'text': ' normal', 'properties': {'b': {'val': '0'}, 'scheme': {'val': 'minor'}}}]
operations = [guarded('xlsx.richText.set', 'A1', runs=runs),
              {'op': 'xlsx.richText.create', 'sheetId': sheet, 'row': 2, 'column': 2, 'runs': runs},
              guarded('xlsx.number.set', 'B1', sheetId=sheet, value='7'),
              guarded('xlsx.formula.set', 'C1', sheetId=sheet, formula='=SUM(B1,2)'),
              {'op': 'xlsx.formula.create', 'sheetId': sheet, 'row': 2, 'column': 3, 'formula': '=B1*2'},
              *[{'op': 'xlsx.richText.create', 'sheetId': sheet, 'row': row, 'column': 2, 'runs': runs}
                for row in [5, 6, 7]]]
patch = {'schemaVersion': 'hcd-patch/50', 'documentId': 'rich-paste-cli', 'patchId': 'mixed',
         'baseRevision': 0, 'operations': operations}
patch_path = root / 'patch.json'
patch_path.write_text(json.dumps(patch, ensure_ascii=False))
first = command('apply', bundle, '--patch', patch_path, '--expected-revision', 0)
assert first['revision'] == 1
assert command('apply', bundle, '--patch', patch_path, '--expected-revision', 0)['revision'] == 1
rich_addresses = ['A1', 'B2', 'B5', 'B6', 'B7']
for address in rich_addresses:
    assert node(address)['xlsxRuns'] == runs
assert node('A1')['xlsxRuns'] == runs
exported = root / 'mixed.xlsx'
command('export', bundle, '--source', source, '--output', exported)
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with ZipFile(exported) as archive:
    native = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    def cell(address):
        return native.find('.//s:c[@r="' + address + '"]', ns)
    assert cell('B1').find('s:v', ns).text == '7'
    assert cell('C1').find('s:f', ns).text == 'SUM(B1,2)'
    assert cell('C2').find('s:f', ns).text == 'B1*2'
    for address in rich_addresses:
        assert cell(address).find('s:is/s:r/s:rPr/s:b', ns) is not None
    assert cell('B6').get('s') == '0'

# Replacing writable numeric/formula cells with rich text is one explicit operation.
patch.update(patchId='rich-conversions', baseRevision=1,
             operations=[guarded('xlsx.richText.set', a, runs=runs) for a in ['B1', 'C1']])
patch_path.write_text(json.dumps(patch, ensure_ascii=False))
command('apply', bundle, '--patch', patch_path, '--expected-revision', 1)
for address in ['B1', 'C1']:
    current = node(address)
    assert current['xlsxRuns'] == runs and current['source']['editable']
# First change is valid; later address collision must prevent the whole commit.
before = node('A1')
bad = {'schemaVersion': 'hcd-patch/50', 'documentId': 'rich-paste-cli', 'patchId': 'must-rollback', 'baseRevision': 2,
       'operations': [guarded('text.splice', 'A1', start=0, deleteCount=0, insertText='BAD'),
                      {'op': 'xlsx.richText.create', 'sheetId': sheet, 'row': 2, 'column': 2, 'runs': runs}]}
patch_path.write_text(json.dumps(bad, ensure_ascii=False))
command('apply', bundle, '--patch', patch_path, '--expected-revision', 2, fail=True)
assert node('A1') == before
stale = deepcopy(patch)
stale['patchId'] = 'stale'
patch_path.write_text(json.dumps(stale, ensure_ascii=False))
command('apply', bundle, '--patch', patch_path, '--expected-revision', 2, fail=True)
exported = root / 'converted.xlsx'
command('export', bundle, '--source', source, '--output', exported)
with ZipFile(exported) as archive, ZipFile(source) as initial:
    native = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    for address in [*rich_addresses, 'B1', 'C1']:
        c = native.find('.//s:c[@r="' + address + '"]', ns)
        assert c.find('s:f', ns) is None
        assert ''.join(c.find('s:is', ns).itertext()) == '新增😀 normal'
        assert c.find('s:is/s:r/s:rPr/s:color', ns).get('rgb') == 'FF228844'
    for part in ['xl/styles.xml', 'xl/sharedStrings.xml']:
        assert archive.read(part) == initial.read(part)
readback = root / 'readback.hcd'
command('import', exported, '--output', readback)
assert command('validate', readback)['valid']
seen_readback = set()
for entry in command('extract-text', readback)['entries']:
    if entry['source']['paragraphId'] in [*rich_addresses, 'B1', 'C1']:
        assert command('get-node', readback, entry['nodeId'])['xlsxRuns'] == runs
        seen_readback.add(entry['source']['paragraphId'])
assert seen_readback == {*rich_addresses, 'B1', 'C1'}
assert source.read_bytes() == original
result = {'publicCapabilities': True, 'mixedAtomicRevision': True, 'richBlankCreation': True,
          'nativeCreationShapes': ['absentCell', 'emptyRow', 'styledEmptyCell', 'absentRow'],
          'nativeNumericAndFormulaTypes': True, 'numericFormulaToRichText': True, 'idempotentReplay': True,
          'lateCollisionRollsBack': True, 'staleRejected': True, 'nativeReadback': True,
          'untouchedPartsPreserved': True, 'sourceUnchanged': True, 'sameSourceOfficeVisualReference': False}
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
