#!/usr/bin/env python3
"""Exercise atomic Word body, image replacement and geometry via CLI and HTTP."""
import argparse
import base64
import copy
import json
import os
import posixpath
from pathlib import Path
import secrets
import socket
import subprocess
import struct
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
import zlib
import xml.etree.ElementTree as ET


def exercise(binary, root):
    root.mkdir(parents=True, exist_ok=True)
    secret = secrets.token_hex(32)
    env = {**os.environ, 'HCD_TOKEN_SECRET': secret}
    # Always exercise local filesystem durability, independent of the caller's cloud setup.
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        env.pop(key, None)

    def command(*arguments, success=True):
        result = subprocess.run([str(binary), 'hdoc', *map(str, arguments), '--json'],
                                env=env, capture_output=True, text=True)
        if not success:
            assert result.returncode, 'unsupported native image export unexpectedly succeeded'
            return
        if result.returncode:
            raise RuntimeError(f'{arguments[0]} failed: {result.stderr or result.stdout}')
        return json.loads(result.stdout)['data']

    source = root / 'source.docx'
    if source.exists():
        raise RuntimeError('work directory already contains this fixture')
    w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    parts = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>',
        'word/document.xml': f'<w:document xmlns:w="{w}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>Original 中😀</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:anchor><wp:positionH relativeFrom="page"><wp:posOffset>127000</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>254000</wp:posOffset></wp:positionV><wp:extent cx="1270000" cy="635000"/><wp:docPr id="42" descr="Atomic image"/><a:graphic><a:blip r:embed="rIdImage"/></a:graphic></wp:anchor></w:drawing></w:r></w:p><w:p><w:r><w:t>Neighbor</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
        'word/media/image.png': base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
    }
    with zipfile.ZipFile(source, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, value in parts.items():
            archive.writestr(name, value)
    modes = [(mode, replacement) for mode in ['source-runs', 'presentation-style', 'semantic-structure', 'source-text'] for replacement in [False, True]]
    tokens, reads = {}, {}
    for index, (mode, replacement) in enumerate(modes):
        document_id = f'atomic-word-{index}'
        bundle = root / f'{document_id}.hcd'
        command('import', source, '--output', bundle, '--document-id', document_id)
        command('project-editor', bundle, '--expected-revision', 0)
        tokens[document_id] = command('issue-token', '--document-id', document_id, '--scope', 'write',
                                      '--user-id', 'hcd-collaboration', '--ttl-seconds', 120)['token']
        reads[document_id] = command('issue-token', '--document-id', document_id, '--scope', 'read',
                                     '--user-id', 'reader', '--ttl-seconds', 120)['token']
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    log = open(root / 'api.log', 'wb')
    server = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{port}'],
                              env=env, stdout=log, stderr=log)

    def request(document_id, route, body=None, status=200, read=False, raw_response=False):
        raw = None if body is None else body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        headers = {'Authorization': f'Bearer {(reads if read else tokens)[document_id]}',
                   'X-HCD-Collaboration-Epoch': '0', 'Content-Type': 'application/octet-stream' if isinstance(body, bytes) else 'application/json'}
        req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/documents/{document_id}{route}',
                                     data=raw, headers=headers)
        try:
            with opener.open(req, timeout=15) as response:
                actual, payload = response.status, response.read()
        except urllib.error.HTTPError as error:
            actual, payload = error.code, error.read()
        assert actual == status, f'{route}: expected {status}, got {actual}: {payload[:500]!r}'
        return payload if raw_response else json.loads(payload)

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    evidence = []
    try:
        for _ in range(100):
            if server.poll() is not None:
                raise RuntimeError('test API exited; inspect api.log')
            try:
                request('atomic-word-0', '/auth')
                break
            except urllib.error.URLError:
                time.sleep(0.05)
        else:
            raise RuntimeError('test API did not become ready')
        for index, (mode, replacement) in enumerate(modes):
            document_id = f'atomic-word-{index}'
            bundle = root / f'{document_id}.hcd'
            projection = request(document_id, '/editor')
            image = request(document_id, '/images')['entries'][0]
            geometry = {**image['geometry'], 'x': image['geometry']['x'] + 12700,
                        'width': image['geometry']['width'] + 127000}
            blocks = [{'blockId': block['blockId'], 'content': copy.deepcopy(block['content'])} for block in projection['blocks']]
            body = next(block['content'] for block in blocks if any(part['text'] == 'Original 中😀' for part in block['content']['inlines']))
            if mode == 'source-runs':
                body['inlines'][0].update(text='Changed 中文😀', fontSizeExplicit=True)
                body['inlines'][0]['typography']['sizePt'] = 18
            elif mode == 'presentation-style':
                body['inlines'][0]['textColor'] = '#123456'
            elif mode == 'semantic-structure':
                body.update(kind='heading', level=2)
            attempt = {'typographyVersion': 2, 'coordinatorVersion': 4, 'coordinatorId': 'c' * 32,
                       'checkpointId': 'a' * 32, 'coordinatorDigest': 'b' * 64, 'expectedRevision': 1,
                       'blocks': blocks, 'images': [{'nodeId': image['nodeId'], 'geometry': geometry,
                                                   'precondition': {'visualHash': image['visualHash']}}]}
            # Staging is not a canonical save. Only the combined checkpoint may
            # introduce the new asset into a revision's immutable asset index.
            def png_chunk(kind, data):
                return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
            replacement_bytes = (b'\x89PNG\r\n\x1a\n'
                + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 1, 8, 2, 0, 0, 0))
                + png_chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00\x00\x00\xff'))
                + png_chunk(b'IEND', b''))
            staged = request(document_id, '/staged-assets?extension=png', replacement_bytes)
            command('gc', bundle, '--delete')
            assert request(document_id, f'/staged-assets/{staged["hash"]}', read=True, raw_response=True) == replacement_bytes
            assert request(document_id, '/editor') == projection
            if replacement:
                attempt['images'][0]['assetHash'] = staged['hash']
            baseline = request(document_id, '/revisions/1')
            old = copy.deepcopy(attempt)
            old['coordinatorVersion'] = 2
            request(document_id, '/checkpoints', old, status=426)
            old['coordinatorVersion'] = 3
            request(document_id, '/checkpoints', old, status=426)
            request(document_id, '/checkpoints', attempt, status=403, read=True)
            for field, value, status in [('hash', '0' * 64, 409), ('width', -1, 400), ('unit', 'pt', 400), ('asset', '../../not-an-asset', 400)]:
                bad = copy.deepcopy(attempt)
                if field == 'hash':
                    bad['images'][0]['precondition']['visualHash'] = value
                elif field == 'asset':
                    bad['images'][0]['assetHash'] = value
                else:
                    bad['images'][0]['geometry'][field] = value
                request(document_id, '/checkpoints', bad, status=status)
                assert request(document_id, '/editor') == projection
                assert request(document_id, '/revisions/1') == baseline
                assert request(document_id, '/images')['entries'][0] == image
            if replacement:
                descriptor = json.loads((bundle / 'assets' / 'staged' / f'{staged["hash"]}.json').read_text())
                asset_path = bundle / descriptor['href']
                corrupt = bytearray(replacement_bytes)
                corrupt[-1] ^= 1
                asset_path.write_bytes(corrupt)
                request(document_id, '/checkpoints', attempt, status=500)
                assert request(document_id, '/editor') == projection
                assert request(document_id, '/images')['entries'][0] == image
                assert request(document_id, '/revisions/1') == baseline
                asset_path.write_bytes(replacement_bytes)
            saved = request(document_id, '/checkpoints', attempt)
            assert saved['revision'] == 2 and saved['saveMode'] == mode
            assert saved['images'][0]['geometry'] == geometry
            expected_hash = staged['hash'] if replacement else image['assetHash']
            assert saved['images'][0]['assetHash'] == expected_hash
            assert request(document_id, f'/images/{image["nodeId"]}?revision=1')['image']['assetHash'] == image['assetHash']
            assert command('validate', bundle)['valid']
            later = copy.deepcopy(saved['images'][0]['geometry'])
            later['y'] += 12700
            patch = {'schemaVersion': 'hcd-patch/3', 'documentId': document_id, 'patchId': 'later-image',
                     'baseRevision': 2, 'operations': [{'op': 'image.geometry', 'nodeId': image['nodeId'],
                        'geometry': later, 'precondition': {'visualHash': saved['images'][0]['visualHash']}}]}
            if replacement:
                # /edits deliberately excludes replacement. Exercise a second
                # full checkpoint to change asset and geometry together.
                later_attempt = {**attempt, 'checkpointId': 'd' * 32,
                    'coordinatorDigest': 'e' * 64, 'expectedRevision': 2,
                    'blocks': [{'blockId': block['blockId'], 'content': block['content']}
                               for block in saved['projection']['blocks']],
                    'images': [{'nodeId': image['nodeId'], 'geometry': later,
                                'assetHash': image['assetHash'],
                                'precondition': {'visualHash': saved['images'][0]['visualHash']}}]}
                request(document_id, '/checkpoints', later_attempt)
            else:
                request(document_id, '/edits', patch)
            assert request(document_id, '/images')['entries'][0]['assetHash'] == image['assetHash']
            historical = request(document_id, f'/images/{image["nodeId"]}?revision=2')
            assert historical['revision'] == 2 and historical['image']['geometry'] == saved['images'][0]['geometry']
            assert historical['image']['assetHash'] == expected_hash
            replay = request(document_id, '/checkpoints', attempt)
            assert replay['revision'] == 2 and replay['images'] == saved['images']
            assert request(document_id, '/editor')['revision'] == 3
            assert request(document_id, '/images')['entries'][0]['geometry'] == later
            altered = copy.deepcopy(attempt)
            if replacement:
                altered['images'][0]['assetHash'] = image['assetHash']
            else:
                altered['images'][0]['geometry']['x'] += 1
            request(document_id, '/checkpoints', altered, status=409)
            native = root / f'{document_id}-unsupported-native.docx'
            command('export', bundle, '--source', source, '--output', native, success=False)
            assert not native.exists(), 'unsupported native rewrite created an output file'
            semantic = root / f'{document_id}-r2.docx'
            command('export', bundle, '--revision', 2, '--output', semantic)
            with zipfile.ZipFile(semantic) as archive:
                document = ET.fromstring(archive.read('word/document.xml'))
                relationships = ET.fromstring(archive.read('word/_rels/document.xml.rels'))
                by_id = {item.attrib['Id']: item.attrib['Target'] for item in relationships}
                blips = document.findall('.//{http://schemas.openxmlformats.org/drawingml/2006/main}blip')
                assert len(blips) == 1
                embed = blips[0].attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed']
                target = posixpath.normpath(posixpath.join('word', by_id[embed]))
                assert archive.read(target) == (replacement_bytes if replacement else parts['word/media/image.png'])
                extents = document.findall('.//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent')
                assert len(extents) == 1 and int(extents[0].attrib['cx']) == geometry['width']
                if mode == 'source-runs':
                    assert 'Changed 中文😀' in ''.join(item.text or '' for item in document.findall(f'.//{{{w}}}t'))
            evidence.append({'documentId': document_id, 'replacement': replacement, 'mode': mode, 'savedRevision': 2,
                             'imageReceipt': saved['images'][0], 'laterRevision': 3,
                             'replayRevision': replay['revision'], 'invalidBatchesKeptHead': True})
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        log.close()
    result = {'passed': True, 'coordinatorVersion': 4, 'modes': evidence, 'checks': ['real loopback HTTP', 'read-only rejection',
        'invalid image rolls back body', 'one revision per combined save', 'source text and size',
        'color with retained image block', 'structure with image', 'immutable image replay',
        'signed body binds geometry and asset', 'corrupt staged asset rolls back body', 'GC retains staged replacement resources',
        'historical revision keeps original asset', 'semantic DOCX contains saved image bytes and width',
        'native image export refuses stale output']}
    (root / 'evidence.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--officecli', type=Path, default=Path('target/debug/officecli'))
    parser.add_argument('--work-dir', type=Path)
    args = parser.parse_args()
    if args.work_dir:
        print(json.dumps(exercise(args.officecli.resolve(), args.work_dir.resolve()), ensure_ascii=False))
    else:
        with tempfile.TemporaryDirectory(prefix='hcd-word-atomic-') as directory:
            print(json.dumps(exercise(args.officecli.resolve(), Path(directory)), ensure_ascii=False))
