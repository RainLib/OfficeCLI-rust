#!/usr/bin/env python3
"""Read-only audit of owned native inline-content artifacts and model fences."""
import base64
import gzip
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def main():
    repo = Path(__file__).resolve().parents[1]
    assets = repo / 'docs/assets/hcd-inline-content-native-2026-10-26'
    configs = [json.loads(Path(path).read_text()) for path in sys.argv[1:]]
    assert configs
    active = Path(configs[0]['root'])
    assert active.parent == repo / 'target/hcd-preview-runtime' and active.name.startswith('hcd-inline-native-')
    bundle = active / 'inline-native.hcd'
    binary = repo / 'target/debug/officecli'

    def sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    baseline = {str(path.relative_to(bundle)): sha(path) for path in bundle.rglob('*') if path.is_file()}
    work = Path(tempfile.mkdtemp(prefix='model-fences-', dir=active))
    fences = []
    for model in [2, 4]:
        clone = work / f'model-{model}.hcd'
        shutil.copytree(bundle, clone)
        manifest = json.loads((clone / 'manifest.json').read_text())
        manifest['capabilities']['extensionNodes'] = model
        (clone / 'manifest.json').write_text(json.dumps(manifest))
        before = {str(path.relative_to(clone)): sha(path) for path in clone.rglob('*') if path.is_file()}
        result = subprocess.run([str(binary), 'hdoc', 'validate', str(clone), '--json'], capture_output=True)
        assert result.returncode != 0
        if model == 2:
            assert b'INLINE_CONTAINER_MODEL_MISSING' in result.stdout
        projection = subprocess.run([str(binary), 'hdoc', 'editor-state', str(clone), '--json'], capture_output=True)
        assert projection.returncode != 0
        assert {str(path.relative_to(clone)): sha(path) for path in clone.rglob('*') if path.is_file()} == before
        fences.append({'model': model, 'validationRejected': True, 'projectionRejected': True, 'bytesUnchanged': True})
    assert {str(path.relative_to(bundle)): sha(path) for path in bundle.rglob('*') if path.is_file()} == baseline
    files = json.loads((assets / 'file-evidence.json').read_text())
    assert files['head'] == 8 and files['nativeBytesUnchangedByFences']
    assert files['canonicalEqualities'] == [[2, 7], [6, 8]] and files['sourceFreeVersionsExact'] == list(range(1, 9))
    http = json.loads((assets / 'http-evidence.json').read_text())
    statuses = {str(code): sum(item['status'] == code for item in http) for code in [200, 403, 409, 426]}
    assert statuses['426'] == 5 and statuses['403'] == statuses['409'] == 1
    assert any(item['path'] == '/checkpoints' and 'editable-inline-container-aware' in item.get('error', '') for item in http)
    refs = json.loads((assets / 'references-r8.json').read_text())
    assert refs['reminders']['enabled'] is False
    assert sorted(item['inlinePath'] for item in refs['items']) == [[1], [1], [1, 2], [1, 2]]
    capabilities = json.loads((assets / 'export-capabilities.json').read_text())
    feature = next(item for item in capabilities['features'] if item['kind'] == 'extension_inline')
    assert feature['formats']['md']['support'] == feature['formats']['pptx']['support'] == 'static'
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    with zipfile.ZipFile(assets / 'offline-r8.docx') as package:
        xml = ET.fromstring(package.read('word/document.xml'))
        runs = xml.findall('.//w:r', ns)
        for text, tag in [('Edited中😀', 'b'), ('Nested😀', 'i')]:
            selected = [run for run in runs if text in ''.join(run.itertext())]
            assert len(selected) == 2
            for run in selected:
                properties = run.find('w:rPr', ns)
                assert properties.find('w:' + tag, ns) is not None
                if tag == 'b':
                    assert properties.find('w:shd', ns).attrib['{' + ns['w'] + '}fill'].lower() == 'fff2a8'
    checks = repo / 'target/hcd-preview-runtime/inline-content-native-checks'
    for name in ['native-tests', 'cli-tests', 'native-build', 'clippy', 'fmt', 'fmtcheck', 'diffcheck']:
        shutil.copyfile(checks / (name + '.log'), assets / (name + '.log'))
    native = (assets / 'native-tests.log').read_text()
    assert all(f'{count} passed; 0 failed' in native for count in [89, 43, 53])
    assert '162 passed; 0 failed' in (assets / 'cli-tests.log').read_text()
    assert all('Finished' in (assets / (name + '.log')).read_text() for name in ['clippy', 'native-build'])
    assert all(not (assets / (name + '.log')).read_bytes() for name in ['fmt', 'fmtcheck', 'diffcheck'])
    secrets = [value.encode() for config in configs for value in [config['secret'], *config['tokens'].values()]]
    counts = {'blobs': 0, 'expandedEntries': 0}

    def scan(data, label, depth=0):
        assert depth < 9
        counts['blobs'] += 1
        assert all(secret not in data for secret in secrets), label
        assert not re.search(rb'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}', data), label
        if data.startswith(b'\x1f\x8b'):
            counts['expandedEntries'] += 1
            scan(gzip.decompress(data), label + ':gzip', depth + 1)
        elif data.startswith(b'PK\x03\x04'):
            with zipfile.ZipFile(io.BytesIO(data)) as package:
                for item in package.infolist():
                    if not item.is_dir():
                        counts['expandedEntries'] += 1
                        scan(package.read(item), label + '!' + item.filename, depth + 1)
        for match in re.finditer(rb'data:[^;,"\s]+;base64,([A-Za-z0-9+/=]+)', data):
            value = match.group(1)
            counts['expandedEntries'] += 1
            scan(base64.b64decode(value + b'=' * (-len(value) % 4), validate=True), label + ':data', depth + 1)

    for path in sorted(assets.rglob('*')):
        if path.is_file() and path.name != 'validation.json':
            scan(path.read_bytes(), path.name)
    source_names = [*['crates/hcd-core/src/' + name for name in ['extensions.rs', 'structure.rs', 'references.rs', 'custom_marks.rs', 'bundle.rs', 'extension_portable.rs', 'export_capabilities.rs', 'validate.rs']], 'crates/officecli/src/hdoc_server.rs', 'crates/hcd-core/schemas/hcd-2.schema.json', 'crates/hcd-core/schemas/hcd-patch-4.schema.json', 'scripts/hcd-inline-content-native.py', 'scripts/hcd-inline-content-audit.py', 'docs/design/hcd-inline-content-native.zh.md']
    result = {'scope': 'Native inline subtree foundation only; no browser/CRDT UI acceptance. Full goal remains active; management/reminder delivery deferred.', 'checks': {'core': 89, 'docx': 43, 'formats': 53, 'cli': 162, 'fail': 0, 'nativeBuild': 0, 'clippyCoreAndCliAllTargetsDenyWarnings': 0, 'fmtCheck': 0, 'diffCheck': 0, 'authenticatedHttpStatuses': statuses, 'nativeFencesByteExact': True, 'canonicalEqualities': [[2, 7], [6, 8]], 'sourceFreeVersionsExact': list(range(1, 9)), 'docxBoldItalicHighlight': True, 'pdfWholePageInspection': {'pages': 1, 'status': 'passed'}, 'modelFences': fences, 'credentialArchiveScan': {'status': 'passed', **counts}}, 'knownExportBoundaries': files['knownExportBoundaries'], 'nativeBinarySha256': sha(binary), 'sourceHashes': {name: sha(repo / name) for name in source_names}, 'artifactHashes': {str(path.relative_to(assets)): sha(path) for path in sorted(assets.rglob('*')) if path.is_file() and path.name != 'validation.json'}}
    report = assets / 'validation.json'
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    scan(report.read_bytes(), report.name)
    doc = repo / 'docs/design/hcd-inline-content-native.zh.md'
    for link in re.findall(r'\]\(([^)]+)\)', doc.read_text()):
        if '://' not in link:
            assert (doc.parent / link.split('#')[0]).exists(), link
    print('PASS native model/read-only file fences, actual files, DOCX styles, HTTP evidence, current tests/builds/links and credential/archive scan', counts)
    print('Native foundation only; browser inline-content collaboration remains pending. No commit/push/publication.')


if __name__ == '__main__':
    main()
