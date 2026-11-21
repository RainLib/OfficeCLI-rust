"""Exercise real files through the CLI without modifying or printing their text.

DOCX: mixed-mark checkpoint, source export, native property and package checks,
then reimport. PDF: independent import/validation/render/source-export checks.
These are robustness checks, not same-source Office/WPS visual certification.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

REPO = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('sources', type=Path, nargs='+')
parser.add_argument('--binary', type=Path, default=REPO / 'target/debug/officecli')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='hcd-inline-fidelity-'))


def cli(*argv):
    result = subprocess.run([str(args.binary.resolve()), 'hdoc', *map(str, argv), '--json'],
                            cwd=REPO, capture_output=True, text=True)
    if result.returncode:
        # Native errors can quote document content. Keep the public result terse;
        # raw process output remains available only to the caller on failure.
        raise RuntimeError(f'CLI {argv[0]} failed (exit {result.returncode})')
    envelope = json.loads(result.stdout)
    assert envelope['success']
    return envelope['data']


results = []
for number, source in enumerate(args.sources):
    source = source.resolve()
    before_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    bundle = root / f'input-{number}.hcd'
    manifest = cli('import', source, '--output', bundle)
    assert cli('validate', bundle)['valid']
    cli('render-html', bundle, '--output', root / f'preview-{number}.html')
    result = {'file': source.name, 'sha256': before_hash, 'importValidated': True,
              'canonicalHtmlRendered': True, 'chunks': manifest['chunkCount']}
    if source.suffix.lower() == '.docx':
        cli('project-editor', bundle, '--expected-revision', 0)
        state = cli('editor-state', bundle)
        block = next(block for block in state['blocks'] if block['region'] == 'body'
                     and not block['readOnly'] and any(run['text'] for run in block['content']['inlines']))
        first_id = block['content']['inlines'][0]['nodeId']
        anchor = cli('get-node', bundle, first_id)['source']
        content = copy.deepcopy(block['content'])
        for inline in content['inlines']:
            inline.pop('nodeId', None)
        marker = ' INLINE_FIDELITY_中文😀'
        content['inlines'].append({'text': marker})
        patch = {'schemaVersion': 'hcd-patch/4', 'documentId': state['documentId'],
                 'patchId': 'mixed-inline-probe', 'baseRevision': state['revision'],
                 'operations': [{'op': 'block.replace', 'blockId': block['blockId'],
                                 'block': content, 'precondition': {'blockHash': block['blockHash']}}]}
        patch_file = root / f'patch-{number}.json'
        patch_file.write_text(json.dumps(patch, ensure_ascii=False))
        cli('apply', bundle, '--patch', patch_file, '--expected-revision', state['revision'])
        assert cli('validate', bundle)['valid']
        current = cli('editor-state', bundle)
        revision = cli('get-revision', bundle, current['revision'])
        assert not revision.get('structuralChange', False)
        updated = next(item for item in current['blocks'] if item['blockId'] == block['blockId'])
        assert block['presentationHtml'].split('>')[0] == updated['presentationHtml'].split('>')[0]
        output = root / f'edited-{number}.docx'
        cli('export', bundle, '--source', source, '--output', output)
        ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        with zipfile.ZipFile(source) as original, zipfile.ZipFile(output) as exported:
            assert set(original.namelist()) == set(exported.namelist())
            for name in original.namelist():
                if name != 'word/document.xml':
                    assert original.read(name) == exported.read(name), name
            a = ET.fromstring(original.read('word/document.xml'))
            b = ET.fromstring(exported.read('word/document.xml'))
            ap, bp = a.findall('.//w:p', ns), b.findall('.//w:p', ns)
            assert len(ap) == len(bp)
            for left, right in zip(ap, bp):
                lp, rp = left.find('w:pPr', ns), right.find('w:pPr', ns)
                assert (ET.tostring(lp) if lp is not None else None) == (ET.tostring(rp) if rp is not None else None)
            texts = a.findall('.//w:t', ns)
            source_text = texts[anchor['textOrdinal'] - 1]
            source_run = next(run for run in a.findall('.//w:r', ns) if source_text in list(run))
            original_props = source_run.find('w:rPr', ns)
            inserted_run = next(run for run in b.findall('.//w:r', ns)
                                if marker in ''.join(node.text or '' for node in run.findall('w:t', ns)))
            # Every unedited source run property (font/size/colour/language/etc.)
            # must also be present on the inserted run; only bold/italic differ.
            if original_props is not None:
                for prop in original_props:
                    if prop.tag.rsplit('}', 1)[-1] not in ('b', 'bCs', 'i', 'iCs'):
                        assert any(ET.tostring(prop) == ET.tostring(other) for other in inserted_run.find('w:rPr', ns)), prop.tag
        roundtrip = root / f'roundtrip-{number}.hcd'
        cli('import', output, '--output', roundtrip)
        assert cli('validate', roundtrip)['valid']
        reread = cli('editor-state', roundtrip)
        assert any(marker in ''.join(run['text'] for run in item['content']['inlines']) for item in reread['blocks'])
        result.update(mixedInlinePatch=True, stableAnchor=first_id in [run.get('nodeId') for run in updated['content']['inlines']],
                      sourceExport=True, paragraphPropertiesPreserved=True, runPropertiesPreserved=True,
                      untouchedPackagePartsPreserved=True, exportReimportValidated=True)
    else:
        assert source.suffix.lower() == '.pdf'
        output = root / f'unchanged-{number}.pdf'
        cli('export', bundle, '--source', source, '--output', output)
        result.update(unchangedSourceExport=True, exportedBytesEqualSource=output.read_bytes() == source.read_bytes(),
                      pageCount=manifest.get('source', {}).get('pageCount'))
    result['originalUnmodified'] = hashlib.sha256(source.read_bytes()).hexdigest() == before_hash
    assert result['originalUnmodified']
    results.append(result)

report = {'purpose': 'independent robustness and source-backed edit probes; no same-source visual certification',
          'modelsCalled': False, 'temporaryRoot': str(root), 'results': results}
rendered = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
if args.output:
    args.output.write_text(rendered)
print(rendered, end='')
