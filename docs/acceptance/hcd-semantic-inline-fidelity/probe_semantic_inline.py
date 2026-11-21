"""Verify source-free HCD exports through the actual CLI and native OOXML.

Uses a public synthetic fixture, temporary output and no model/service. Input
documents are never overwritten. Rich native runs and readback text are
separate checks: XLSX HCD preview currently flattens inline run formatting.
"""
import argparse
import base64
import re
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
root = Path(tempfile.mkdtemp(prefix='hcd-semantic-inline-'))
fixture = Path(__file__).with_name('fixture.html')
binary = str(args.binary.resolve())


def cli(*argv):
    result = subprocess.run([binary, 'hdoc', *map(str, argv), '--json'],
                            cwd=REPO, capture_output=True, text=True)
    assert result.returncode == 0, (result.args, result.stdout, result.stderr)
    envelope = json.loads(result.stdout)
    assert envelope['success'], envelope
    return envelope['data']


def xml(package, part):
    with zipfile.ZipFile(package) as archive:
        return ET.fromstring(archive.read(part))


def runs(element, namespace, drawing=False):
    def flag(run, name):
        props = run.find(f'{{{namespace}}}rPr')
        if props is None:
            return None
        if drawing:
            value = props.get(name)
        else:
            child = props.find(f'{{{namespace}}}{name}')
            if child is None:
                return None
            value = child.get(f'{{{namespace}}}val', child.get('val', '1'))
        return None if value is None else value not in ('0', 'false')

    output = []
    for run in element.iter(f'{{{namespace}}}r'):
        text = ''.join(child.text or '' for child in run.iter(f'{{{namespace}}}t'))
        if text:
            output.append((text, flag(run, 'b'), flag(run, 'i')))
    return output


# HTML's HCD importer currently flattens several inline tags. Seed a native
# DOCX through the direct HTML converter to isolate source-free Office export.
seed = root / 'seed.docx'
source_html = fixture.read_text()
seed_html = root / 'seed.html'
seed_html.write_text(re.sub(r'<img\b[^>]*>', '', source_html))
subprocess.run([binary, 'convert', str(seed_html), '--output', str(seed), '--json'],
               cwd=REPO, capture_output=True, text=True, check=True)
# Direct HTML conversion intentionally loads only trusted resolved assets.
# Attach the fixture raster through the CLI's part-aware image operation.
pixel = root / 'pixel.png'
pixel.write_bytes(base64.b64decode(re.search(r'data:image/png;base64,([^\"]+)', source_html)[1]))
for kind, properties in [('paragraph', ['text=']),
                         ('image', [f'src={pixel}', 'width=609600', 'height=609600'])]:
    subprocess.run([binary, 'add', str(seed), '/body', '--type-name', kind,
                    *[argument for prop in properties for argument in ('--prop', prop)]],
                   cwd=REPO, capture_output=True, text=True, check=True)
bundle = root / 'input.hcd'
cli('import', seed, '--output', bundle)
assert cli('validate', bundle)['valid']
expected = [('同名😀', True, False), (' tail', False, True), (' plain', False, False),
            ('同名😀', None, True), (' tail plain', None, None)]
namespaces = {
    'docx': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'xlsx': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'pptx': 'http://schemas.openxmlformats.org/drawingml/2006/main',
}
parts = {'docx': 'word/document.xml', 'xlsx': 'xl/worksheets/sheet1.xml',
         'pptx': 'ppt/slides/slide1.xml'}
results = []
for format in ('docx', 'xlsx', 'pptx', 'md'):
    output = root / f'converted.{format}'
    report = cli('export', bundle, '--output', output)
    assert output.is_file() and output.stat().st_size > 0
    if format in parts:
        native = xml(output, parts[format])
        assert runs(native, namespaces[format], format == 'pptx')[:5] == expected, format
    readback = root / f'readback-{format}.hcd'
    cli('import', output, '--output', readback)
    assert cli('validate', readback)['valid']
    preview = root / f'preview-{format}.html'
    cli('render-html', readback, '--output', preview)
    html = preview.read_text()
    assert '同名😀' in html and 'tail' in html and 'plain' in html
    entry = {'format': format, 'nativeInlineRunsVerified': format != 'md',
             'readbackValidated': True, 'readbackTextVerified': True,
             'htmlGenerated': True, 'bytes': output.stat().st_size,
             'fidelity': report.get('level'),
             'fullLayoutEquivalenceCertified': False}
    if format == 'docx':
        ns = {'w': namespaces['docx']}
        native = xml(output, parts['docx'])
        assert native.find('.//w:br', ns) is not None
        tables = native.findall('.//w:tbl', ns)
        assert len(tables) == 1 and tables[0].find('.//w:drawing', ns) is None
        assert len(native.findall('.//w:drawing', ns)) == 1
        with zipfile.ZipFile(output) as archive:
            rels = ET.fromstring(archive.read('word/_rels/document.xml.rels'))
            assert any(rel.get('Target') == 'https://example.com/?a=1&b=2' for rel in rels)
        entry['imageOutsideTableAndNativeLinkVerified'] = True
    if format == 'md':
        assert '<code class="hcd-markdown-raw-html"' not in html
        docx = root / 'markdown-roundtrip.docx'
        cli('export', readback, '--output', docx)
        assert runs(xml(docx, parts['docx']), namespaces['docx'])[:5] == expected
        entry['markdownToNativeDocxStylesVerified'] = True
    results.append(entry)

result = {'fixture': str(fixture.relative_to(REPO)),
          'route': 'direct HTML conversion + part-aware raster attachment -> native DOCX -> HCD -> source-free targets', 'temporaryArtifacts': str(root),
          'results': results,
          'boundaries': ['Native run formatting and readback text checked independently.',
                         'No same-source Word/WPS visual reference or pixel equivalence.',
                         'XLSX HCD preview flattens inline rich runs.',
                         'HTML HCD import flattens several inline tags; this probe seeds DOCX through direct conversion.',
                         'No real provider, service restart or production data used.']}
rendered = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
if args.output:
    args.output.write_text(rendered)
print(rendered)
