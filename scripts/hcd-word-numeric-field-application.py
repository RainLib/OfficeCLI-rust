#!/usr/bin/env python3
"""Exercise actual installed LibreOffice; do not claim Word/WPS or in-app pagination."""
import hashlib
import html
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

repo = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1]).resolve()
assert out.parent == repo / 'docs/assets'
out.mkdir(exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='word-field-app-check-', dir=repo / 'target/hcd-preview-runtime'))
binary = repo / 'target/debug/officecli'
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
commands = []


def run(args, timeout=90):
    result = subprocess.run(list(map(str, args)), capture_output=True, text=True, timeout=timeout)
    commands.append({'args': [str(arg).replace(str(root), '<owned-root>') for arg in args], 'exitCode': result.returncode})
    assert result.returncode == 0, result.stderr or result.stdout
    return result.stdout


def cli(*args):
    return json.loads(run([binary, 'hdoc', *args, '--json']))['data']


def field(number, kind, format):
    text = f'[{kind}]'
    value = {'schemaVersion': 'hcd.extension/2', 'instanceId': f'x_{number:032x}',
             'type': 'officecli.word.numeric_field', 'version': 1, 'display': 'inline',
             'data': {'kind': kind, 'format': format}, 'fallback': {'text': text},
             'exports': {target: {'support': 'semantic' if target == 'docx' else 'static',
                                 'blocks': [{'kind': 'paragraph', 'runs': [{'text': text}]}]}
                         for target in ['docx', 'xlsx', 'pptx', 'pdf', 'html', 'md', 'txt']}}
    return {'text': text, 'extension': value}


try:
    version = run(['/usr/local/bin/soffice', '--version']).strip()
    source = repo / 'docs/assets/hcd-word-field-ui-2026-10-30/field-r8.hcdz'
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    bundle = root / 'application.hcd'
    cli('unpack', source, '--output', bundle)
    state = cli('editor-state', bundle)
    assert state['revision'] == 8
    first_header = state['flowLayout']['sections'][0]['headers']['first']
    target = next(block for block in state['blocks'] if block['flowRegionId'] == first_header and not block['readOnly'])
    assert 'First header' in ''.join(inline['text'] for inline in target['content']['inlines'])
    content = {'kind': 'paragraph', 'inlines': [{'text': 'Page '}, field(801, 'PAGE', 'upperRoman'),
               {'text': ' / section '}, field(802, 'SECTIONPAGES', 'arabic')]}
    patch = {'schemaVersion': 'hcd-patch/6', 'documentId': state['documentId'], 'patchId': 'application-visible-fields',
             'baseRevision': 8, 'layoutHash': state['flowLayoutHash'],
             'actor': {'authorId': 'interop-check', 'authorName': 'Application verification'},
             'regions': [{'regionId': first_header, 'operations': [{'op': 'block.insert', 'afterBlockId': target['blockId'], 'block': content}]}]}
    patch_file = root / 'patch.json'
    patch_file.write_text(json.dumps(patch, ensure_ascii=False))
    cli('apply', bundle, '--patch', patch_file, '--expected-revision', 8)
    assert cli('validate', bundle)['valid']
    docx = out / 'visible-fields.docx'
    assert not docx.exists()
    cli('export', bundle, '--revision', 9, '--output', docx)
    profile = (root / 'lo-profile').as_uri()
    output = run(['/usr/local/bin/soffice', '-env:UserInstallation=' + profile, '--headless', '--convert-to', 'pdf', '--outdir', out, docx], timeout=180)
    (out / 'visible-render.log').write_text(output)
    pdf = out / 'visible-fields.pdf'
    assert pdf.is_file()
    info = run(['pdfinfo', pdf])
    assert re.search(r'^Pages:\s+2$', info, re.M), info
    text_file = out / 'visible-fields.txt'
    run(['pdftotext', '-layout', pdf, text_file])
    pages = [text for text in text_file.read_text().split('\f') if text.strip()]
    assert len(pages) == 2
    assert state['flowLayout']['sections'][1]['page']['numberStart'] == 4
    section_results = []
    for page, number in zip(pages, ['I', 'IV']):
        assert f'Page {number} / section ' in ' '.join(page.split()), page
        section_results.append(re.search(r'/ section ([^\n]+)', page).group(1).strip())
        assert not any(placeholder in page for placeholder in ['[PAGE]', '[NUMPAGES]'])
    assert 'IIBody one' in pages[0] and 'Body two' in pages[1]
    assert re.search(r'Bob\s+页码协同', pages[0])
    roundtrip = out / 'roundtrip'
    roundtrip.mkdir(exist_ok=True)
    assert not (roundtrip / docx.name).exists()
    (out / 'visible-resave.log').write_text(run(['/usr/local/bin/soffice', '-env:UserInstallation=' + profile, '--headless', '--convert-to', 'docx:Office Open XML Text', '--outdir', roundtrip, docx], timeout=180))
    resaved = roundtrip / docx.name
    assert resaved.is_file()
    returned = root / 'returned.hcd'
    cli('import', resaved, '--word-regions', '--output', returned)
    assert cli('validate', returned)['valid']
    projection = cli('editor-state', returned)
    definitions = []
    for block in projection['blocks']:
        values = re.findall(r'data-hcd-word-field-definition="([^"]*)"', block.get('readOnlyHtml', ''))
        if values:
            assert block['readOnly']
        definitions.extend(json.loads(html.unescape(value)) for value in values)
    kinds = {value['instruction'].strip().split()[0] for value in definitions}
    roundtrip_preserved = kinds == {'PAGE', 'NUMPAGES', 'SECTIONPAGES'}
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    for page in [1, 2]:
        run(['pdftoppm', '-f', page, '-singlefile', '-scale-to', 1200, '-png', pdf, out / f'visible-page-{page}'])
    result = {'application': version, 'sourceArchiveSha256': source_hash,
              'scope': 'Actual isolated LibreOffice open/render/resave; not Word/WPS, browser UI or editor pagination',
              'status': 'passed' if section_results == ['1', '1'] and roundtrip_preserved else 'partial: required application compatibility is not fully achieved',
              'pdfPages': 2, 'pageNumbers': ['I', 'IV'], 'secondSectionNumberStart': 4,
              'expectedSectionPageCounts': [1, 1], 'actualSectionPageResults': section_results,
              'sectionPagesCalculated': section_results == ['1', '1'],
              'totalPagesRoman': 'II', 'unicodePeerTextPreserved': True,
              'resavedDocxReimportReadonlyFields': len(definitions), 'resavedInstructionKinds': sorted(kinds), 'allInstructionKindsSurvivedApplicationResave': roundtrip_preserved,
              'sourceArchiveUnchanged': True, 'ownedRootRemoved': root.name}
finally:
    assert root.parent == repo / 'target/hcd-preview-runtime' and root.name.startswith('word-field-app-check-') and not root.is_symlink()
    shutil.rmtree(root)
assert not root.exists()
(out / 'application-commands.json').write_text(json.dumps(commands, ensure_ascii=False, indent=2) + '\n')
(out / 'application.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
if result['status'] != 'passed':
    sys.exit(2)
