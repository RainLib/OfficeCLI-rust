"""CLI evidence for XLSX inline/shared rich strings and source export/readback."""
import argparse
from html.parser import HTMLParser
import json
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from make_fixture import make_fixture

REPO = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=Path, default=REPO / 'target/debug/officecli')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='hcd-xlsx-rich-'))
source = root / 'rich.xlsx'
make_fixture(source)
original = source.read_bytes()


def cli(*argv):
    result = subprocess.run([str(args.binary.resolve()), 'hdoc', *map(str, argv), '--json'],
                            cwd=REPO, capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)
    assert data['success'], data
    return data['data']


class RichPreview(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cells = {}
        self.cell = None
        self.run = None

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == 'td':
            self.cell = attrs.get('data-hcd-cell')
        if 'data-hcd-xlsx-run' in attrs:
            assert self.cell and self.run is None
            self.run = {'text': '', 'properties': json.loads(attrs['data-hcd-xlsx-run'])}

    def handle_data(self, text):
        if self.run is not None:
            self.run['text'] += text

    def handle_endtag(self, tag):
        if tag == 'span' and self.run is not None:
            self.cells.setdefault(self.cell, []).append(self.run)
            self.run = None
        if tag == 'td':
            self.cell = None


def preview(bundle, name):
    path = root / f'{name}.html'
    cli('render-html', bundle, '--output', path)
    document = RichPreview()
    document.feed(path.read_text())
    return document.cells


bundle = root / 'input.hcd'
cli('import', source, '--output', bundle, '--document-id', 'xlsx-rich-probe')
assert cli('validate', bundle)['valid']
before = preview(bundle, 'before')
assert before['A1'] == before['A2']
assert before['A1'] != before['A3']
assert ''.join(run['text'] for run in before['A2']) == '中文😀 normal 斜体'
nodes = cli('extract-text', bundle)['entries']
node = next(n for n in nodes if n['source']['paragraphId'] == 'A1')
patch = {'schemaVersion': 'hcd-patch/1', 'documentId': 'xlsx-rich-probe',
         'patchId': 'rich-text-edit', 'baseRevision': 0,
         'operations': [{'op': 'text.splice', 'nodeId': node['nodeId'],
                         'start': 4, 'deleteCount': 6, 'insertText': 'edited',
                         'precondition': {'nodeHash': node['nodeHash']}}]}
patch_path = root / 'edit.json'
patch_path.write_text(json.dumps(patch, ensure_ascii=False))
cli('apply', bundle, '--patch', patch_path, '--expected-revision', 0)
after = preview(bundle, 'after')
expected = json.loads(json.dumps(before['A1']))
expected[1]['text'] = ' edited '
assert after['A1'] == expected
assert after['A2'] == before['A2']
assert cli('get-node', bundle, node['nodeId'])['source'] == node['source']
assert cli('validate', bundle)['valid']
output = root / 'edited.xlsx'
report = cli('export', bundle, '--source', source, '--output', output)
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with ZipFile(output) as archive:
    native = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    cell = native.find('.//s:c[@r="A1"]', ns)
    runs = cell.findall('s:is/s:r', ns)
    observed = []
    for run in runs:
        properties = run.find('s:rPr', ns)
        observed.append({'text': ''.join(t.text or '' for t in run.findall('s:t', ns)),
                         'properties': {} if properties is None else {
                             prop.tag.rsplit('}', 1)[-1]: prop.attrib for prop in properties}})
    assert observed == expected
    with ZipFile(source) as old:
        assert archive.read('xl/sharedStrings.xml') == old.read('xl/sharedStrings.xml')
        assert archive.read('xl/styles.xml') == old.read('xl/styles.xml')
readback = root / 'readback.hcd'
cli('import', output, '--output', readback)
assert cli('validate', readback)['valid']
assert preview(readback, 'readback') == after
assert source.read_bytes() == original
result = {'temporaryArtifacts': str(root), 'inlineAndSharedRichRunsVerified': True,
          'duplicateTextKeepsIndependentStyles': True, 'phoneticReadingExcluded': True,
          'unicodeTextSpliceKeepsPropertiesAndAnchor': True,
          'nativeSourceExportRunsAndUntouchedPartsVerified': True,
          'readbackRunsVerified': True, 'sourceUnchanged': True,
          'fidelity': report.get('level'), 'sameSourceOfficeVisualReference': False,
          'boundaries': ['Theme/indexed colour and font scheme are preserved as native properties; resolved appearance is not certified.',
                         'In-cell selection formatting, arbitrary rich clipboard paste and cross-device rich input drafts remain incomplete.',
                         'Source-free conversion remains semantic and does not preserve every run property.']}
if args.output:
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
