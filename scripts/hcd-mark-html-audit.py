#!/usr/bin/env python3
"""Audit the owned HTML mark evidence, including nested archives and credentials."""
import base64
import datetime
import gzip
import hashlib
import io
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path


def main():
    repo = Path(__file__).resolve().parents[1]
    assets = repo / 'docs/assets/hcd-mark-html-roundtrip-2026-10-26'
    configs = [json.loads(Path(path).read_text()) for path in sys.argv[1:]]
    assert configs
    secrets = [value[key].encode() for value in configs for key in ['alice', 'bob', 'reader', 'secret']]
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
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                for item in archive.infolist():
                    if not item.is_dir():
                        counts['expandedEntries'] += 1
                        scan(archive.read(item), label + '!' + item.filename, depth + 1)
        for match in re.finditer(rb'data:[^;,"\s]+;base64,([A-Za-z0-9+/=]+)', data):
            encoded = match.group(1)
            counts['expandedEntries'] += 1
            scan(base64.b64decode(encoded + b'=' * (-len(encoded) % 4), validate=True), label + ':data', depth + 1)

    def sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    checks = repo / 'target/hcd-preview-runtime/html-mark-checks'
    for name in ['frontend-tests', 'frontend-build', 'native-tests', 'native-build', 'clippy', 'fmt', 'diffcheck', 'fmtcheck']:
        shutil.copyfile(checks / (name + '.log'), assets / (name + '.log'))
    frontend = (assets / 'frontend-tests.log').read_text()
    assert 'ℹ pass 642' in frontend and 'ℹ fail 0' in frontend
    assert '53 passed; 0 failed' in (assets / 'native-tests.log').read_text()
    assert (assets / 'frontend-build.log').read_text().count('✓ built') == 2
    for name in ['native-build', 'clippy']:
        assert 'Finished' in (assets / (name + '.log')).read_text()
    for name in ['fmt', 'fmtcheck', 'diffcheck']:
        assert not (assets / (name + '.log')).read_bytes()
    active = Path(configs[0]['root'])
    head = json.loads((active / 'mentions-docx.hcd/manifest.json').read_text())
    assert head['revision'] == 6 and head['capabilities']['customMarks'] == 1
    files = json.loads((assets / 'file-evidence.json').read_text())
    assert files['htmlReimportContentExactIgnoringNewSourceIds'] and files['sourceIdsPreservedAndCopiesDistinct']
    assert files['all200'] and files['canonicalEquality'] == [3, 5]
    probes = [json.loads(path.read_text()) for path in sorted((active / 'checkpoint-probe').glob('*.json'))]
    assert len(probes) == 5 and all(probe['status'] == 200 for probe in probes)
    assert [probe['request']['expectedRevision'] for probe in probes] == list(range(1, 6))
    reader = json.loads((assets / 'reader-dom-r6.json').read_text())
    assert len(reader) == 4 and all(item['readOnly'] == 'true' and 'example.' not in item['title'] for item in reader)
    editor = json.loads((assets / 'editor-dom-r6.json').read_text())
    assert len(editor['marks']) == 7 and len(editor['unavailable']) == 1
    assert editor['unavailable'][0]['editable'] == 'false' and editor['unavailable'][0]['text'] == '未来业务中😀'
    assert all('--hcd-mark-' in item['inlineStyle'] for item in editor['marks'])
    clipboard = (assets / 'editor-copy-final.html').read_text()
    assert '--hcd-mark-' not in clipboard and 'font-weight: 700' in clipboard and 'rgb(' in clipboard
    assert clipboard.count('data-hcd-custom-mark=') == 2
    for path in sorted(assets.rglob('*')):
        if path.is_file() and path.name != 'validation.json':
            scan(path.read_bytes(), path.name)
    sources = [
        'crates/hcd-formats/src/textual.rs',
        *['examples/hdoc/editor/src/' + name for name in ['customMarks.ts', 'customMarks.test.ts', 'schema.ts', 'sourceIdentity.test.ts', 'style.css']],
        'examples/hdoc/editor/fixtures/customMarks.ts', 'scripts/hcd-mention-preview.py',
        'scripts/hcd-mark-html-files.py', 'scripts/hcd-mark-html-audit.py',
        'docs/design/hcd-mark-html-roundtrip.zh.md', 'docs/design/hcd-editor-delivery-plan.zh.md',
    ]
    result = {
        'date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope': 'Text mark HTML reimport, ordinary-format isolation, clipboard normalization, new-paragraph source and actual canonical/offline exports. Full original goal remains active.',
        'checks': {'frontend': 642, 'hcdFormats': 53, 'fail': 0, 'typeScriptStandaloneEmbedBuild': 0, 'nativeBuild': 0, 'clippyHcdFormatsAllTargetsDenyWarnings': 0, 'cargoFmtCheck': 0, 'gitDiffCheck': 0, 'browserCommittedVersions': list(range(1, 7)), 'firstNativeCheckpoints': 5, 'all200': True, 'canonicalEquality': [3, 5], 'sourceFreeAllVersionsExact': list(range(1, 7)), 'actualBrowserDownloads': ['docx', 'html'], 'actualHtmlReimport': True, 'actualStaticFormats': ['docx', 'pptx', 'pdf', 'md'], 'pdfWholePageInspection': {'pages': 1, 'status': 'passed'}, 'noCodecReadonlyFragments': 4, 'credentialZipGzipDataUriScan': {'status': 'passed', **counts}},
        'nativeBinarySha256': sha(repo / 'target/debug/officecli'),
        'sourceHashes': {name: sha(repo / name) for name in sources},
        'artifactHashes': {str(path.relative_to(assets)): sha(path) for path in sorted(assets.rglob('*')) if path.is_file() and path.name != 'validation.json'},
        'boundaries': ['Old failing fixture retained separately and deliberately stopped after diagnosis; final fixture never restarted', 'Personal undo verified before final fixture-control removal/page refresh; no cross-refresh undo claim', 'Text-only fixture; broader HTML/CSS, images/resources and business-node reimport remain open', 'Native HTML colors limited to six-digit hex; browser clipboard also normalizes RGB and short hex', 'No real Office/AI, service-restart, database/multi-instance, complete IME/device or production acceptance', 'Management platform and reminder delivery remain deferred'],
    }
    report = assets / 'validation.json'
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    scan(report.read_bytes(), report.name)
    doc = repo / 'docs/design/hcd-mark-html-roundtrip.zh.md'
    for link in re.findall(r'\]\(([^)]+)\)', doc.read_text()):
        if '://' not in link:
            assert (doc.parent / link.split('#')[0]).exists(), link
    print('PASS current checks, actual files, links, source/artifact hashes and credential/archive scan', counts)
    print('Full goal active; management/reminder delivery deferred. No commit/push/publication.')


if __name__ == '__main__':
    main()
