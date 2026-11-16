"""Real CLI: HTML import -> text checkpoint -> source/native exports -> readback.

Uses a public synthetic fixture and temporary files. No model or daily service.
Native formatting, readback text and browser rendering are separate assertions.
"""
import argparse
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

REPO = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=Path, default=REPO / 'target/debug/officecli')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='hcd-html-inline-'))
fixture = Path(__file__).resolve().parent.parent / 'hcd-semantic-inline-fidelity/fixture.html'
source = root / 'source.html'
original = fixture.read_bytes()
source.write_bytes(original)


def cli(*argv):
    result = subprocess.run([str(args.binary.resolve()), 'hdoc', *map(str, argv), '--json'],
                            cwd=REPO, capture_output=True, text=True, check=True)
    envelope = json.loads(result.stdout)
    assert envelope['success'], envelope
    return envelope['data']


def native_runs(package, part, namespace, drawing=False):
    with zipfile.ZipFile(package) as archive:
        tree = ET.fromstring(archive.read(part))
    output = []
    for run in tree.iter(f'{{{namespace}}}r'):
        text = ''.join(node.text or '' for node in run.iter(f'{{{namespace}}}t'))
        if not text:
            continue
        properties = run.find(f'{{{namespace}}}rPr')
        flags = []
        for name in ('b', 'i'):
            value = None
            if properties is not None:
                if drawing:
                    value = properties.get(name)
                else:
                    flag = properties.find(f'{{{namespace}}}{name}')
                    if flag is not None:
                        value = flag.get(f'{{{namespace}}}val', flag.get('val', '1'))
            flags.append(None if value is None else value not in ('false', '0'))
        output.append((text, *flags))
    start = next(index for index, run in enumerate(output) if run[0].startswith('同名😀'))
    return tree, output[start:start + 5]


bundle = root / 'input.hcd'
cli('import', source, '--output', bundle, '--document-id', 'html-inline-probe')
assert cli('validate', bundle)['valid']
cli('project-editor', bundle, '--expected-revision', 0)
before = cli('editor-state', bundle)
heading = next(block for block in before['blocks'] if block['content']['kind'] == 'heading')
first_id = heading['content']['inlines'][0]['nodeId']
anchor = cli('get-node', bundle, first_id)['source']
assert [(run['text'], run['bold'], run['italic']) for run in heading['content']['inlines']] == [
    ('同名😀', True, False), (' tail', False, True), (' plain', False, False)]
content = copy.deepcopy(heading['content'])
for inline in content['inlines']:
    inline.pop('nodeId', None)
marker = ' EDIT中文😀'
content['inlines'][0]['text'] += marker
patch = {'schemaVersion': 'hcd-patch/4', 'documentId': before['documentId'],
         'patchId': 'html-inline-probe', 'baseRevision': before['revision'],
         'operations': [{'op': 'block.replace', 'blockId': heading['blockId'],
                         'block': content, 'precondition': {'blockHash': heading['blockHash']}}]}
patch_path = root / 'checkpoint.json'
patch_path.write_text(json.dumps(patch, ensure_ascii=False))
cli('apply', bundle, '--patch', patch_path, '--expected-revision', before['revision'])
assert cli('validate', bundle)['valid']
after = cli('editor-state', bundle)
assert cli('get-node', bundle, first_id)['source'] == anchor
assert not cli('get-revision', bundle, after['revision']).get('structuralChange', False)
source_export = root / 'source-export.html'
source_report = cli('export', bundle, '--source', source, '--output', source_export)
assert source_export.read_text() == original.decode().replace('同名😀', '同名😀' + marker, 1)
cli('render-html', bundle, '--output', root / 'preview-html.html')
expected = [('同名😀' + marker, True, False), (' tail', False, True), (' plain', False, False),
            ('同名😀', None, True), (' tail plain', None, None)]
word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
formats = {
    'docx': ('word/document.xml', word),
    'xlsx': ('xl/worksheets/sheet1.xml', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'),
    'pptx': ('ppt/slides/slide1.xml', 'http://schemas.openxmlformats.org/drawingml/2006/main'),
    'md': None,
}
results = []
for format, spec in formats.items():
    output = root / f'converted.{format}'
    report = cli('export', bundle, '--output', output)
    if spec:
        native, observed = native_runs(output, *spec, drawing=format == 'pptx')
        assert observed == expected, (format, observed)
    if format == 'docx':
        ns = {'w': word}
        assert len(native.findall('.//w:drawing', ns)) == 1
        assert native.find('.//w:tbl//w:drawing', ns) is None
        extent = native.find('.//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent')
        assert extent is not None and extent.get('cx') == '609600' and extent.get('cy') == '609600'
        with zipfile.ZipFile(output) as archive:
            rels = ET.fromstring(archive.read('word/_rels/document.xml.rels'))
        assert any(rel.get('Target') == 'https://example.com/?a=1&b=2' for rel in rels)
    readback = root / f'readback-{format}.hcd'
    cli('import', output, '--output', readback)
    assert cli('validate', readback)['valid']
    preview = root / f'preview-{format}.html'
    cli('render-html', readback, '--output', preview)
    assert all(text in preview.read_text() for text in ['同名😀', marker.strip(), '280'])
    if format == 'md':
        reroundtrip = root / 'markdown-readback.docx'
        cli('export', readback, '--output', reroundtrip)
        _, observed = native_runs(reroundtrip, *formats['docx'])
        assert observed == expected
    results.append({'format': format, 'nativeRunsChecked': spec is not None,
                    'readbackValidated': True, 'readbackTextChecked': True,
                    'fidelity': report['level'], 'bytes': output.stat().st_size})

assert source.read_bytes() == original
result = {'route': 'HTML -> HCD -> text checkpoint -> source HTML / native Office / Markdown -> HCD',
          'fixture': str(fixture.relative_to(REPO)), 'temporaryArtifacts': str(root),
          'modelsCalled': False, 'sourceUnmodified': True,
          'stableSourceAnchor': True, 'textOnlyRevision': True,
          'sourceMarkupPreserved': True, 'sourceExportFidelity': source_report['level'],
          'docxImageOutsideTableAndLinkChecked': True, 'markdownNativeRoundtripChecked': True,
          'docxImageDimensionsChecked': True,
          'results': results,
          'boundaries': ['No same-source Office/WPS physical layout certification.',
                         'XLSX native rich runs do not certify grid rich-text readback.',
                         'Stylesheets, other inline CSS and arbitrary HTML remain simplified.']}
rendered = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
if args.output:
    args.output.write_text(rendered)
print(rendered, end='')
