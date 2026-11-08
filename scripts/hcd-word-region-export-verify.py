#!/usr/bin/env python3
"""Verify actual source-free regional DOCX bytes and read-only HTTP export.
Only owned archives/temporary bundles; never touches the user's preview.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


def main():
    repo = Path(__file__).resolve().parents[1]
    binary = repo / 'target/debug/officecli'
    evidence = repo / 'docs/assets/hcd-word-region-export-2026-10-26'
    evidence.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='hcd-word-region-export-', dir=repo / 'target/hcd-preview-runtime'))
    env = {**os.environ, 'NO_COLOR': '1', 'HCD_TOKEN_SECRET': secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        env.pop(key, None)

    def run(args):
        return subprocess.run([str(binary), *map(str, args)], cwd=work, env=env,
                              capture_output=True, text=True, timeout=120)

    def cli(*args):
        result = run(['hdoc', *args, '--json'])
        response = json.loads(result.stdout)
        assert result.returncode == 0 and response['success'] and not result.stderr, (args[0], result.stdout, result.stderr)
        assert '\x1b[' not in result.stdout
        return response['data']

    w = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    r = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
    wp = '{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}'

    def inspect(content):
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            for name in z.namelist():
                if name.endswith(('.xml', '.rels')):
                    ET.fromstring(z.read(name))
            root = ET.fromstring(z.read('word/document.xml'))
            sections = root.findall('.//' + w + 'sectPr')
            assert len(sections) == 2
            assert not root.findall('.//' + w + 'bookmarkStart')
            rels = ET.fromstring(z.read('word/_rels/document.xml.rels'))
            relationships = {rel.attrib['Id']: rel for rel in rels}
            stories = {}
            for rel in relationships.values():
                if rel.attrib['Type'].endswith(('/header', '/footer')):
                    path = 'word/' + rel.attrib['Target']
                    stories[path] = ''.join(ET.fromstring(z.read(path)).itertext())
            assert len(stories) == 6
            for section in sections:
                for ref in list(section):
                    if ref.tag in [w + 'headerReference', w + 'footerReference']:
                        assert ref.attrib[r + 'id'] in relationships
            return {'body': ''.join(root.itertext()), 'stories': stories,
                    'sections': [ET.tostring(s, encoding='unicode') for s in sections]}

    archive_root = repo / 'docs/assets/hcd-flow-regions-2026-10-26'
    bundle = work / 'region-test.hcd'
    cli('unpack', archive_root / 'regions-r4.hcdz', '--output', bundle)
    before = (bundle / 'manifest.json').read_bytes()
    reports = {}
    for revision in [0, 1, 2, 4]:
        output = evidence / f'regions-r{revision}.docx'
        report = cli('export', bundle, '--revision', revision, '--output', output)
        reports[str(revision)] = report
        inspected = inspect(output.read_bytes())
        if revision == 4:
            assert 'Header detail 中😀' in inspected['stories']['word/header1.xml']
            assert '@Alice' in inspected['stories']['word/header1.xml']
            assert 'Header detail' not in inspected['body']
            codes = [entry['code'] for entry in report['warnings']]
            assert 'HCD_REFERENCE_FLATTENED' in codes and 'HCD_EXTENSION_FLATTENED' in codes
        if revision == 0:
            assert 'Body one' in inspected['body']
            assert any(warning['code'] == 'HCD_TEMPORARY_REGION_PROJECTION' for warning in report['warnings'])
        assert (bundle / 'manifest.json').read_bytes() == before

    # Real imported header image, replaced and resized in a joint region save.
    image_bundle = work / 'image-test.hcd'
    cli('unpack', archive_root / 'image-r2.hcdz', '--output', image_bundle)
    output = evidence / 'image-r2.docx'
    image_report = cli('export', image_bundle, '--output', output)
    inspect(output.read_bytes())
    expected = json.loads((archive_root / 'header-image-r2.json').read_text())
    with zipfile.ZipFile(output) as z:
        header = ET.fromstring(z.read('word/header1.xml'))
        extent = header.find('.//' + wp + 'extent')
        assert extent is not None and int(extent.attrib['cx']) == expected['geometry']['width'] and int(extent.attrib['cy']) == expected['geometry']['height']
        media = [z.read(name) for name in z.namelist() if name.startswith('word/media/')]
        assert any(hashlib.sha256(content).hexdigest() == expected['assetHash'] for content in media)
        assert '图片批次正文' in ''.join(ET.fromstring(z.read('word/document.xml')).itertext())
    assert any('Floating image' in warning['message'] for warning in image_report['warnings'])

    # Real computed/unknown field caches: retain visible results, never emit
    # executable source instructions in a source-free semantic document.
    source = repo / 'docs/assets/hcd-flow-layout-2026-10-26/source.docx'
    field_source = work / 'fields.docx'
    field_header = f'''<w:hdr xmlns:w="{w[1:-1]}"><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p><w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>42</w:t></w:r></w:fldSimple></w:p><w:p><w:fldSimple w:instr=" INCLUDETEXT &amp;quot;never-open.docx&amp;quot; "><w:r><w:t>Saved external result</w:t></w:r></w:fldSimple></w:p></w:hdr>'''
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(field_source, 'w') as generated:
        for name in original.namelist():
            generated.writestr(name, field_header.encode() if name == 'word/header1.xml' else original.read(name))
    field_bundle = work / 'fields.hcd'
    cli('import', field_source, '--word-regions', '--document-id', 'fields', '--output', field_bundle)
    field_output = evidence / 'fields.docx'
    field_report = cli('export', field_bundle, '--output', field_output)
    assert any('Word fields' in warning['message'] for warning in field_report['warnings'])
    with zipfile.ZipFile(field_output) as generated:
        header = generated.read('word/header1.xml').decode()
        text = ''.join(ET.fromstring(header).itertext())
        assert '7' in text and '42' in text and 'Saved external result' in text
        assert 'fldChar' not in header and 'fldSimple' not in header and 'INCLUDETEXT' not in header
    assert cli('editor-state', field_bundle)['revision'] == 0

    # Unsupported targets and a damaged asset cannot replace an existing file.
    for target in ['pdf', 'md']:
        output = work / ('keep.' + target)
        output.write_bytes(b'keep existing output')
        result = run(['hdoc', 'export', bundle, '--output', output, '--json'])
        assert result.returncode == 1 and not json.loads(result.stdout)['success'] and not result.stderr
        assert output.read_bytes() == b'keep existing output'
    # Locate the archived bytes by digest, without depending on asset-index schema.
    asset_file = next(path for path in (image_bundle / 'assets/sha256').iterdir() if path.name.startswith(expected['assetHash']))
    asset_file.write_bytes(b'changed')
    output = work / 'keep.docx'
    output.write_bytes(b'keep existing output')
    result = run(['hdoc', 'export', image_bundle, '--output', output, '--json'])
    assert result.returncode == 1 and not json.loads(result.stdout)['success'] and not result.stderr
    assert output.read_bytes() == b'keep existing output'

    # Actual read-only authenticated download, no original DOCX installed.
    token = cli('issue-token', '--document-id', 'region-test', '--scope', 'read',
                '--user-id', 'reader', '--display-name', 'Reader', '--ttl-seconds', 3600)['token']
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}/v1/documents/region-test'
    log = open(work / 'server.log', 'w')
    process = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(work), '--bind', f'127.0.0.1:{port}'], cwd=work, env=env, stdout=log, stderr=log)

    def request(route, authenticated=True):
        headers = {'Authorization': 'Bearer ' + token} if authenticated else {}
        try:
            with urllib.request.urlopen(urllib.request.Request(origin + route, headers=headers), timeout=120) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    try:
        deadline = time.monotonic() + 30
        while True:
            assert process.poll() is None
            try:
                if request('/export-options')[0] == 200:
                    break
            except urllib.error.URLError:
                pass
            assert time.monotonic() < deadline
            time.sleep(.05)
        status, body = request('/export-options')
        options = json.loads(body)
        assert status == 200 and options['semanticFormats'] == ['docx'] and not options['sourceAvailable']
        for revision in [0, 4]:
            status, content = request('/export/docx?revision=' + str(revision))
            assert status == 200
            inspect(content)
            (evidence / f'http-r{revision}.docx').write_bytes(content)
        assert request('/export/docx', False)[0] == 401
        assert request('/export/pdf')[0] == 422
        assert (bundle / 'manifest.json').read_bytes() == before
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        log.close()
    summary = {'nativeBinarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'runtime': str(work),
               'cliRevisions': [0, 1, 2, 4], 'sourceFreeOfflineRoundtrip': True,
               'model1ProjectionOnlyInTemporarySnapshot': True, 'originalHeadUnchanged': True,
               'headerMentionAndRichExtensionFallback': True, 'headerImageBytesAndDimensions': True, 'computedAndUnknownFieldsStaticCaches': True,
               'unsupportedAndInvalidAssetPreserveOutput': True,
               'readOnlyHttpCurrentAndHistoricalDocx': True, 'unauthenticatedDownloadStatus': 401,
               'pdfStillUnsupportedStatus': 422, 'options': options,
               'limits': ['static field results', 'floating images become inline', 'semantic pagination', 'no browser region UI or signed CRDT activation', 'no Office desktop or production acceptance']}
    (evidence / 'file-evidence.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    (evidence / 'fidelity-reports.json').write_text(json.dumps({'revisions': reports, 'image': image_report, 'fields': field_report}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
