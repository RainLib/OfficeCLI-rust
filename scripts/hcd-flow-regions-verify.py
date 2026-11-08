#!/usr/bin/env python3
"""Owned Word region fixture: real CLI, authenticated loopback HTTP and HCDZ.
Never edits the user's preview bundle. Credentials stay in process memory.
"""
import binascii
import copy
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
import zlib


def main():
    repo = Path(__file__).resolve().parents[1]
    binary = repo / 'target/debug/officecli'
    assets = Path(os.environ.get('HCD_FLOW_REGIONS_EVIDENCE_DIR', repo / 'docs/assets/hcd-flow-regions-2026-10-26'))
    assets.mkdir(parents=True, exist_ok=True)
    fixture = repo / 'docs/assets/hcd-flow-layout-2026-10-26/source.docx'
    assert fixture.is_file(), 'Missing owned two-section Word fixture'
    work = Path(tempfile.mkdtemp(prefix='hcd-flow-regions-', dir=repo / 'target/hcd-preview-runtime'))
    source = work / 'source.docx'
    shutil.copyfile(fixture, source)
    bundle = work / 'region-test.hcd'
    env = {**os.environ, 'NO_COLOR': '1', 'HCD_TOKEN_SECRET': secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        env.pop(key, None)

    def run(args):
        return subprocess.run([str(binary), *map(str, args)], env=env, cwd=work, capture_output=True, text=True, timeout=120)

    def cli(*args):
        result = run(['hdoc', *args, '--json'])
        value = json.loads(result.stdout)
        assert result.returncode == 0 and value['success'] and not result.stderr, f'{args[0]} failed (exit {result.returncode})'
        assert '\x1b[' not in result.stdout
        return value['data']

    def projection(path=bundle, revision=None):
        return cli('editor-state', path, *([] if revision is None else ['--revision', revision]))

    def find_block(state, text):
        return next(block for block in state['blocks'] if any(i['text'] == text for i in block['content']['inlines']))

    def paragraph(text):
        return {'kind': 'paragraph', 'inlines': [{'text': text, 'bold': True}]}

    def replace(block, content):
        return {'op': 'block.replace', 'blockId': block['blockId'], 'precondition': {'blockHash': block['blockHash']}, 'block': content}

    def patch(state, patch_id, edits):
        return {'schemaVersion': 'hcd-patch/6', 'documentId': 'region-test', 'patchId': patch_id,
                'baseRevision': state['revision'], 'layoutHash': state['flowLayoutHash'],
                'actor': {'userId': 'alice', 'displayName': 'Alice'},
                'regions': [{'regionId': block['flowRegionId'], 'operations': operations} for block, operations in edits]}

    def apply(value, path=bundle):
        request_file = work / 'request.json'
        request_file.write_text(json.dumps(value, ensure_ascii=False))
        return cli('apply', path, '--patch', request_file, '--expected-revision', value['baseRevision'])

    def denied(value, expected_code=None):
        before = projection()
        request_file = work / 'denied.json'
        request_file.write_text(json.dumps(value, ensure_ascii=False))
        result = run(['hdoc', 'apply', bundle, '--patch', request_file, '--expected-revision', value['baseRevision'], '--json'])
        response = json.loads(result.stdout)
        assert result.returncode == 1 and not response['success'] and not result.stderr
        if expected_code:
            assert response['error']['code'] == expected_code, response
        assert projection() == before

    help_checks = [([], 'help'), (['hdoc', 'import'], 'import-help'),
                   (['hdoc', 'project-editor'], 'project-help'), (['hdoc', 'apply'], 'apply-help')]
    for args, name in help_checks:
        result = run([*args, '--help'])
        assert result.returncode == 0 and not result.stderr
        if name in ['import-help', 'project-help']:
            assert '--word-regions' in result.stdout
        (assets / f'{name}.txt').write_text(result.stdout)

    legacy = work / 'legacy.hcd'
    cli('import', source, '--output', legacy, '--document-id', 'legacy')
    assert 'flowLayout' not in projection(legacy)
    cli('project-editor', legacy, '--expected-revision', 0)
    assert cli('validate', legacy)['valid']
    legacy_docx = work / 'legacy.docx'
    cli('export', legacy, '--source', source, '--output', legacy_docx)
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(legacy_docx) as actual:
        assert original.namelist() == actual.namelist()
        assert all(original.read(name) == actual.read(name) for name in original.namelist())

    invalid_source = work / 'invalid.txt'
    invalid_source.write_text('Not a Word document')
    invalid_target = work / 'invalid.hcd'
    result = run(['hdoc', 'import', invalid_source, '--word-regions', '--output', invalid_target, '--json'])
    assert result.returncode == 1 and json.loads(result.stdout)['success'] is False and not invalid_target.exists()

    cli('import', source, '--word-regions', '--output', bundle, '--document-id', 'region-test')
    r0 = projection()
    assert r0['flowLayout']['schemaVersion'] == 'hcd-flow-layout/1'
    before = (bundle / 'manifest.json').read_bytes()
    result = run(['hdoc', 'project-editor', bundle, '--expected-revision', 0, '--json'])
    assert result.returncode == 1 and not json.loads(result.stdout)['success']
    assert (bundle / 'manifest.json').read_bytes() == before
    cli('project-editor', bundle, '--word-regions', '--expected-revision', 0)
    r1 = projection()
    assert r1['flowLayout']['schemaVersion'] == 'hcd-flow-layout/2' and len(r1['flowLayoutHash']) == 64
    assert len(r1['flowLayout']['sections']) == 2 and len(r1['flowLayout']['stories']) == 6
    assert all('flowRegionId' in block for block in r1['blocks']) and projection(revision=0) == r0
    retry = cli('project-editor', bundle, '--word-regions', '--expected-revision', 0)
    assert retry['revision'] == 1 and retry['idempotentReplay']
    human = run(['hdoc', 'editor-state', bundle])
    assert human.returncode == 0 and not human.stderr and '\x1b[' not in human.stdout

    replacements = [('Body one', '正文跨区域保存', 'word/document.xml'),
                    ('Default header', '页眉跨区域保存', 'word/header1.xml'),
                    ('Default footer', '页脚跨区域保存', 'word/footer1.xml')]
    edits = [(find_block(r1, old), [replace(find_block(r1, old), paragraph(new))]) for old, new, _ in replacements]
    rich_patch = patch(r1, 'regional-rich-cli', edits)
    bad = copy.deepcopy(rich_patch)
    bad['regions'][1]['operations'][0]['precondition']['blockHash'] = '0' * 64
    denied(bad)
    bad = copy.deepcopy(rich_patch)
    bad['layoutHash'] = '0' * 64
    denied(bad)
    bad = copy.deepcopy(rich_patch)
    bad['regions'][0]['operations'][0]['block']['inlines'][0]['nodeId'] = find_block(r1, 'Default header')['content']['inlines'][0]['nodeId']
    denied(bad)
    assert apply(rich_patch)['revision'] == 2
    r2 = projection()
    nodes = cli('extract-text', bundle)['entries']
    for _, new, part in replacements:
        assert next(node for node in nodes if node['text'] == new)['source']['part'] == part
        assert find_block(r2, new)['content']['inlines'][0]['bold']
    assert cli('validate', bundle)['valid']
    assert apply(rich_patch)['idempotentReplay']

    # A restore crosses the model boundary, then an explicit upgrade is safe to repeat.
    restored = work / 'restored.hcd'
    shutil.copytree(bundle, restored)
    cli('restore', restored, '--revision', 0, '--expected-revision', 2)
    assert projection(restored)['flowLayout']['schemaVersion'] == 'hcd-flow-layout/1'
    assert apply(rich_patch, restored)['revision'] == 2 and projection(restored)['revision'] == 3
    cli('project-editor', restored, '--word-regions', '--expected-revision', 3)
    assert projection(restored)['revision'] == 4 and cli('validate', restored)['valid']
    assert projection(restored, 0) == r0 and projection(restored, 2) == r2

    (work / 'sources').mkdir()
    shutil.copyfile(source, work / 'sources/region-test.docx')
    tokens = {scope: cli('issue-token', '--document-id', 'region-test', '--scope', scope,
                         '--user-id', 'alice', '--display-name', 'Alice', '--ttl-seconds', 3600)['token'] for scope in ['read', 'write']}
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}/v1/documents/region-test'
    observations = []
    log = open(work / 'server.log', 'w')
    process = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(work), '--bind', f'127.0.0.1:{port}'], env=env, stdout=log, stderr=log)

    def request(route='', data=None, scope='read', model='2', binary_response=False):
        headers = {'Authorization': 'Bearer ' + tokens[scope], 'Content-Type': 'application/json'}
        if model is not None:
            headers['X-HCD-Flow-Layout-Version'] = model
        req = urllib.request.Request(origin + route, data=None if data is None else json.dumps(data).encode(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                return response.status, response.read() if binary_response else json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    try:
        deadline = time.monotonic() + 30
        while True:
            assert process.poll() is None, 'Owned server exited during startup'
            try:
                if request()[0] == 200:
                    break
            except urllib.error.URLError:
                pass
            assert time.monotonic() < deadline
            time.sleep(.05)
        for model in [None, '0', '1', '3']:
            status, _ = request('/editor', model=model)
            assert status == 426
            observations.append({'route': 'GET /editor', 'model': model, 'status': status})
        assert request('/editor') == (200, r2)
        assert request('/editor?revision=0', model='1') == (200, r0)
        assert request('/editor?revision=0', model='2')[0] == 426
        observations.append({'route': 'GET /editor', 'model': '2', 'status': 200, 'historicalModel1ReadWithVersion1': True})
        operations = []
        for _, new, _ in replacements:
            node = next(node for node in nodes if node['text'] == new)
            operations.append({'op': 'text.splice', 'nodeId': node['nodeId'], 'start': 0, 'deleteCount': len(new),
                               'insertText': new + '（接口修改）', 'precondition': {'nodeHash': node['nodeHash']}})
        text_patch = {'schemaVersion': 'hcd-patch/3', 'documentId': 'region-test', 'patchId': 'regional-http-text',
                      'baseRevision': 2, 'actor': {}, 'metadata': {}, 'operations': operations}
        for scope, model, expected in [('write', '1', 426), ('read', '2', 403)]:
            status, _ = request('/edits', text_patch, scope, model)
            assert status == expected and projection() == r2
            observations.append({'route': 'POST /edits', 'scope': scope, 'model': model, 'status': status, 'headUnchanged': True})
        bad = copy.deepcopy(text_patch)
        bad['operations'][1]['precondition']['nodeHash'] = '0' * 64
        assert request('/edits', bad, 'write')[0] == 412 and projection() == r2
        status, saved = request('/edits', text_patch, 'write')
        assert status == 200 and saved['revision'] == 3
        assert request('/edits', text_patch, 'write')[1]['idempotentReplay']
        observations.append({'route': 'POST /edits', 'status': 200, 'jointBodyHeaderFooterRevision': 3, 'idempotentReplay': True})
        for route, data in [('/project', {'expectedRevision': 3}),
                            ('/patch', {'schemaVersion': 'hcd-patch/4', 'documentId': 'region-test', 'patchId': 'old-client', 'baseRevision': 3, 'operations': []})]:
            assert request(route, data, 'write')[0] == 426
        status, options = request('/export-options')
        assert status == 200 and options['semanticExportSupported'] is False and options['sourceEditsSupported'] is False
        assert options['semanticFormats'] == ['docx']
        status, semantic_docx = request('/export/docx', binary_response=True)
        assert status == 200 and zipfile.is_zipfile(__import__('io').BytesIO(semantic_docx))
        for fmt in ['pdf', 'pptx', 'html', 'md', 'txt']:
            assert request('/export/' + fmt)[0] == 422
        assert request('/export/docx?source=true')[0] == 400
        status, original_docx = request('/export/docx?revision=0&source=true', binary_response=True)
        assert status == 200 and original_docx == source.read_bytes()
        status, archive = request('/export/hcdz', binary_response=True)
        assert status == 200
        http_archive = work / 'http-r3.hcdz'
        http_archive.write_bytes(archive)
        http_reopened = work / 'http-offline.hcd'
        cli('unpack', http_archive, '--output', http_reopened)
        for revision in range(4):
            assert projection(http_reopened, revision) == projection(revision=revision)
        observations.append({'route': 'exports', 'currentSemanticDocxSupported': True, 'otherSemanticFormatsRefused': True, 'currentSourceRefused': True, 'currentSourceRefusalStatus': 400,
                             'historicalSourceR0Exact': True, 'httpHcdzR3AllHistoryExact': True})
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        log.close()

    # Resource-bearing, unknown business node in the actual header region.
    def png_part(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', binascii.crc32(kind + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + png_part(b'IHDR', struct.pack('!IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + png_part(b'IDAT', zlib.compress(b'\x00\x26\x7d\xed\xff')) + png_part(b'IEND', b'')
    picture = work / 'card.png'
    picture.write_bytes(png)
    asset = cli('put-asset', bundle, picture)
    r3 = projection()
    header = find_block(r3, '页眉跨区域保存（接口修改）')
    node = {'schemaVersion': 'hcd.extension/2', 'instanceId': 'x_' + '1' * 32, 'type': 'example.header_card', 'version': 77,
            'display': 'block', 'data': {'future': ['中文<&😀', 1, True, None]}, 'fallback': {'text': 'Header card'},
            'contentModel': 'blocks', 'resources': [{'key': 'preview', 'hash': asset['hash'], 'byteLength': asset['byteLength'],
                                                   'name': 'card.png', 'mediaType': 'image/png'}]}
    mention = {'type': 'hcd.mention', 'version': 1, 'mentionId': 'm_' + '1' * 32,
               'target': {'kind': 'person', 'id': 'alice'}, 'snapshot': {'label': 'Alice'}}
    card = {'kind': 'extension', 'extension': node, 'inlines': [], 'children': [
        {'kind': 'paragraph', 'inlines': [{'text': 'Header detail 中😀', 'bold': True}, {'text': '@Alice', 'reference': mention}]}]}
    card_patch = patch(r3, 'regional-header-card', [(header, [replace(header, card)])])
    assert apply(card_patch)['revision'] == 4 and cli('validate', bundle)['valid']
    r4 = projection()
    card_block = next(block for block in r4['blocks'] if block['blockId'] == header['blockId'])
    assert card_block['flowRegionId'] == header['flowRegionId'] and card_block['content']['extension'] == node
    current_nodes = cli('extract-text', bundle)['entries']
    for text in ['Header detail 中😀', '@Alice']:
        assert next(n for n in current_nodes if n['text'] == text)['source']['part'] == 'word/header1.xml'
    final = work / 'regions-r4.hcdz'
    cli('pack', bundle, '--output', final)
    reopened = work / 'final-offline.hcd'
    cli('unpack', final, '--output', reopened)
    for revision in range(5):
        assert projection(reopened, revision) == projection(revision=revision)
    assert (reopened / asset['href']).read_bytes() == png
    assert apply(rich_patch)['revision'] == 2 and projection()['revision'] == 4
    (assets / 'projection-r4.json').write_text(json.dumps(r4, ensure_ascii=False, indent=2) + '\n')
    (assets / 'rich-patch.json').write_text(json.dumps(rich_patch, ensure_ascii=False, indent=2) + '\n')
    shutil.copyfile(final, assets / final.name)
    shutil.copyfile(http_archive, assets / http_archive.name)
    # An actual imported header image shares the region transaction with text.
    image_source = work / 'image-source.docx'
    original_png = b'\x89PNG\r\n\x1a\n' + png_part(b'IHDR', struct.pack('!IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + png_part(b'IDAT', zlib.compress(b'\x00\xeb\x48\x48\xff')) + png_part(b'IEND', b'')
    header_xml = '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:p><w:r><w:t>Header image text</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="42" name="Header logo" descr="Header logo"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Logo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:hdr>'
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(image_source, 'w') as target:
        for name in original.namelist():
            data = original.read(name)
            if name == 'word/header1.xml':
                data = header_xml.encode()
            if name == '[Content_Types].xml':
                data = data.replace(b'</Types>', b'<Default Extension="png" ContentType="image/png"/></Types>')
            target.writestr(name, data)
        target.writestr('word/media/header.png', original_png)
        target.writestr('word/_rels/header1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/header.png"/></Relationships>')
    image_bundle = work / 'image-test.hcd'
    cli('import', image_source, '--word-regions', '--document-id', 'image-test', '--output', image_bundle)
    cli('project-editor', image_bundle, '--word-regions', '--expected-revision', 0)
    image_state = projection(image_bundle)
    image = cli('list-images', image_bundle)['entries'][0]
    assert image['source']['part'] == 'word/header1.xml'
    replacement = cli('put-asset', image_bundle, picture)
    geometry = {**image['geometry'], 'x': image['geometry']['x'] + 12, 'width': 80, 'height': 40}
    body_block = find_block(image_state, 'Body one')
    header_block = find_block(image_state, 'Header image text')
    footer_block = find_block(image_state, 'Default footer')
    image_operation = {'op': 'image.replace', 'nodeId': image['nodeId'], 'assetHash': replacement['hash'], 'geometry': geometry, 'precondition': {'visualHash': image['visualHash']}}
    image_patch = patch(image_state, 'regional-header-image', [(body_block, [replace(body_block, paragraph('图片批次正文'))]), (header_block, [replace(header_block, paragraph('图片批次页眉')), image_operation]), (footer_block, [replace(footer_block, paragraph('图片批次页脚'))])])
    image_patch['documentId'] = 'image-test'
    bad = copy.deepcopy(image_patch)
    bad['regions'][1]['operations'][1]['precondition']['visualHash'] = '0' * 64
    request_file = work / 'bad-image.json'
    request_file.write_text(json.dumps(bad, ensure_ascii=False))
    result = run(['hdoc', 'apply', image_bundle, '--patch', request_file, '--expected-revision', 1, '--json'])
    assert result.returncode == 1 and not json.loads(result.stdout)['success'] and projection(image_bundle) == image_state
    assert apply(image_patch, image_bundle)['revision'] == 2 and cli('validate', image_bundle)['valid']
    saved_image = cli('get-image', image_bundle, image['nodeId'])
    assert saved_image['assetHash'] == replacement['hash'] and saved_image['geometry'] == geometry
    for text in ['图片批次正文', '图片批次页眉', '图片批次页脚']:
        find_block(projection(image_bundle), text)
    image_archive = work / 'image-r2.hcdz'
    cli('pack', image_bundle, '--output', image_archive)
    image_reopened = work / 'image-offline.hcd'
    cli('unpack', image_archive, '--output', image_reopened)
    for revision in range(3):
        assert projection(image_reopened, revision) == projection(image_bundle, revision)
    assert cli('get-image', image_reopened, image['nodeId']) == saved_image
    assert (image_reopened / replacement['href']).read_bytes() == png
    shutil.copyfile(image_archive, assets / image_archive.name)
    shutil.copyfile(image_source, assets / image_source.name)
    (assets / 'header-image-r2.json').write_text(json.dumps(saved_image, ensure_ascii=False, indent=2) + '\n')
    report = {'scope': 'Opt-in native Word region structure and actual authenticated mapped-text HTTP; no browser/signed CRDT room activation',
              'nativeBinarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'runtime': str(work),
              'normalImportAndProjectionUnchanged': True, 'regionalRichSaveRevision': 2,
              'httpJointMappedSaveRevision': 3, 'headerResourceAndMentionRevision': 4,
              'sourcePartsVerified': ['word/document.xml', 'word/header1.xml', 'word/footer1.xml'],
              'restoredAcrossModelsAndReprojected': True, 'lateReceiptReturnsR2WithoutChangingRestoredHead': True,
              'regionalHeaderImageAndGeometryJointSave': True, 'lateImageFailureRollsBackAllText': True, 'imageOfflineR0ToR2Exact': True, 'offlineAllRevisionsExact': list(range(5)), 'offlineResourceBytesExact': True, 'http': observations,
              'cli': {'workingDirectory': 'owned temporary directory outside source repository', 'help': 'checked', 'jsonSingleValue': True, 'NO_COLOR': True, 'humanOutput': 'checked',
                      'invalidNonWordFlagDoesNotCreateBundle': True, 'quietAndNoColorFlags': 'not part of existing CLI; NO_COLOR used'},
              'boundaries': ['No browser region editing or signed region collaboration/undo', 'No existing user-document migration',
                             'No page-number update, real pagination or document TOC', 'Semantic DOCX is supported; other regional export formats remain refused',
                             'Compound root crossing a section requires splitting before projection',
                             'No Office desktop, cross-platform or production acceptance', 'Management and actual reminder delivery deferred']}
    (assets / 'file-evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print('PASS native regional rich r2, authenticated HTTP r3, custom header/resource/mention r4, restore/model replay, all offline history, semantic DOCX and remaining export refusals')


if __name__ == '__main__':
    main()
