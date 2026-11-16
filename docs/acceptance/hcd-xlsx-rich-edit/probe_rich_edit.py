"""Exercise the public rich-text operation through CLI/source export/readback."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from zipfile import ZipFile

REPO = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=Path, default=REPO / 'target/debug/officecli')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='hcd-xlsx-rich-edit-'))
source = root / 'input.xlsx'
runpy.run_path(str(REPO / 'docs/acceptance/hcd-xlsx-rich-text/make_fixture.py'))['make_fixture'](source)
original = source.read_bytes()


def cli(*argv, failure=False):
    command = [str(args.binary.resolve()), 'hdoc', *map(str, argv), '--json']
    result = subprocess.run(command, cwd=REPO, capture_output=True, text=True)
    if failure:
        assert result.returncode != 0, result.stdout
        return
    assert result.returncode == 0, result.stderr or result.stdout
    data = json.loads(result.stdout)
    assert data['success'], data
    return data['data']


bundle = root / 'input.hcd'
cli('import', source, '--output', bundle, '--document-id', 'rich-edit-cli')
node = next(node for node in cli('extract-text', bundle)['entries'] if node['source']['paragraphId'] == 'A1')
before = cli('get-node', bundle, node['nodeId'])
runs = deepcopy(before['xlsxRuns'])
middle = runs.pop(1)
expected = [runs[0], {'text': ' ', 'properties': deepcopy(middle['properties'])},
            {'text': 'normal', 'properties': {**deepcopy(middle['properties']), 'b': {'val': '1'}}},
            {'text': ' ', 'properties': deepcopy(middle['properties'])}, runs[1]]
patch = {'schemaVersion': 'hcd-patch/49', 'documentId': 'rich-edit-cli', 'patchId': 'rich-selection-format',
         'baseRevision': 0, 'operations': [{'op': 'xlsx.richText.set', 'nodeId': node['nodeId'],
                                          'runs': expected, 'precondition': {'nodeHash': node['nodeHash']}}]}
path = root / 'format.json'
path.write_text(json.dumps(patch, ensure_ascii=False))
cli('apply', bundle, '--patch', path, '--expected-revision', 0)
after = cli('get-node', bundle, node['nodeId'])
assert after['text'] == before['text']
assert after['nodeHash'] == before['nodeHash']
assert after['source'] == before['source']
assert after['xlsxRuns'] == expected
assert after['revision'] == 1
assert cli('validate', bundle)['valid']
patch['patchId'] = 'stale-formatting'
path.write_text(json.dumps(patch, ensure_ascii=False))
cli('apply', bundle, '--patch', path, '--expected-revision', 1, failure=True)
assert cli('get-node', bundle, node['nodeId'])['revision'] == 1

exported = root / 'formatted.xlsx'
cli('export', bundle, '--source', source, '--output', exported)
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with ZipFile(exported) as archive, ZipFile(source) as original_zip:
    cell = ET.fromstring(archive.read('xl/worksheets/sheet1.xml')).find('.//s:c[@r="A1"]', ns)
    observed = []
    for run in cell.findall('s:is/s:r', ns):
        props = run.find('s:rPr', ns)
        observed.append({'text': ''.join(text.text or '' for text in run.findall('s:t', ns)),
                         'properties': {} if props is None else {prop.tag.rsplit('}', 1)[-1]: prop.attrib for prop in props}})
    assert observed == expected
    for part in ['xl/styles.xml', 'xl/sharedStrings.xml']:
        assert archive.read(part) == original_zip.read(part)
readback = root / 'readback.hcd'
cli('import', exported, '--output', readback)
assert cli('validate', readback)['valid']
read_node = next(node for node in cli('extract-text', readback)['entries'] if node['source']['paragraphId'] == 'A1')
assert cli('get-node', readback, read_node['nodeId'])['xlsxRuns'] == expected
assert source.read_bytes() == original
result = {'formatOnlyEdit': True, 'textHashAndAnchorPreserved': True, 'nodeReadIncludesNativeRuns': True,
          'staleFormattingRejected': True, 'nativeRunsAndUntouchedPartsVerified': True, 'readbackVerified': True,
          'sourceUnchanged': True, 'sameSourceOfficeVisualReference': False}
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
