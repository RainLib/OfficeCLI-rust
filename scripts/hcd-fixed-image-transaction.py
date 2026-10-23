#!/usr/bin/env python3
"""Real HTTP regression for fixed/section text + replacement + geometry saves."""
import argparse
import copy
import io
import json
import os
import posixpath
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
import zlib
import xml.etree.ElementTree as ET


def png(rgb):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\0' + bytes(rgb))) + chunk(b'IEND', b'')


def fixtures(root):
    content_types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/></Types>'
    rel = lambda target, kind: f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{target}"/></Relationships>'
    word = {'[Content_Types].xml': content_types, '_rels/.rels': rel('word/document.xml', 'officeDocument'),
            'word/_rels/document.xml.rels': rel('media/image.png', 'image'),
            'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:t>Original</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><wp:docPr id="1" name="Image"/><a:graphic><a:blip r:embed="rId1"/></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>', 'word/media/image.png': png([0, 0, 255])}
    slide = '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="12700" y="25400"/><a:ext cx="2540000" cy="635000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>Original</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3" name="Image"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill><p:spPr><a:xfrm><a:off x="127000" y="1270000"/><a:ext cx="1270000" cy="635000"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>'
    ppt = {'[Content_Types].xml': content_types, '_rels/.rels': rel('ppt/presentation.xml', 'officeDocument'),
           'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
           'ppt/_rels/presentation.xml.rels': rel('slides/slide1.xml', 'slide'),
           'ppt/slides/_rels/slide1.xml.rels': rel('../media/image.png', 'image'),
           'ppt/slides/slide1.xml': slide, 'ppt/media/image.png': png([0, 0, 255])}
    for kind, parts in [('docx', word), ('pptx', ppt)]:
        with zipfile.ZipFile(root / f'fixture.{kind}', 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, value in parts.items():
                archive.writestr(name, value)
    content = b'BT /F1 12 Tf 10 180 Td (Original) Tj ET q 40 0 0 30 50 70 cm /Im1 Do Q'
    pixels = zlib.compress(bytes([0, 0, 255]))
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
               b'<< /Length %d >>\nstream\n' % len(content) + content + b'\nendstream',
               b'<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n' % len(pixels) + pixels + b'\nendstream']
    data = b'%PDF-1.7\n'; offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data)); data += f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n'
    start = len(data)
    data += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    data += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    data += f'trailer\n<< /Root 1 0 R /Size {len(offsets)} >>\nstartxref\n{start}\n%%EOF\n'.encode()
    (root / 'fixture.pdf').write_bytes(data)


def exercise(binary, root):
    root.mkdir(parents=True, exist_ok=True)
    if any(root.iterdir()):
        raise RuntimeError('use a fresh work directory')
    fixtures(root)
    (root / 'sources').mkdir()
    secret = secrets.token_hex(32)
    env = {**os.environ, 'HCD_TOKEN_SECRET': secret}
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        env.pop(key, None)

    def command(*args):
        completed = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], env=env, capture_output=True, text=True, timeout=120)
        if completed.returncode:
            raise RuntimeError(completed.stderr or completed.stdout)
        return json.loads(completed.stdout)['data']

    tokens = {}
    for kind in ['docx', 'pptx', 'pdf']:
        doc = f'fixed-{kind}'; source = root / f'fixture.{kind}'
        command('import', source, '--output', root / f'{doc}.hcd', '--document-id', doc)
        (root / 'sources' / f'{doc}.{kind}').write_bytes(source.read_bytes())
        tokens[doc] = command('issue-token', '--document-id', doc, '--scope', 'write', '--user-id', 'fixed-writer', '--ttl-seconds', 3600)['token']
    private = root / 'test-env.json'
    private.write_text(json.dumps({'secret': secret, 'tokens': tokens})); private.chmod(0o600)
    (root / 'red.png').write_bytes(png([255, 0, 0]))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
    with open(root / 'api.log', 'wb') as log:
        server = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{port}'], env=env, stdout=log, stderr=log)

    def request(doc, route, body=None, expected=200, raw=False):
        payload = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/documents/{doc}{route}', data=payload,
                                     headers={'Authorization': 'Bearer ' + tokens[doc], 'Content-Type': 'application/octet-stream' if isinstance(body, bytes) else 'application/json'})
        try:
            with opener.open(req, timeout=60) as response:
                status, value = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, value = error.code, error.read()
        if expected is None:
            return status, json.loads(value)
        assert status == expected, (route, status, value[:400])
        return value if raw else json.loads(value)

    evidence = []
    try:
        for _ in range(100):
            try:
                request('fixed-pptx', '/auth'); break
            except urllib.error.URLError:
                if server.poll() is not None:
                    raise RuntimeError('fixture API exited')
                time.sleep(.05)
        for kind in ['docx', 'pptx', 'pdf']:
            doc = f'fixed-{kind}'; bundle = root / f'{doc}.hcd'
            text = next(item for item in command('extract-text', bundle)['entries'] if item['text'].strip())
            image = request(doc, '/images')['entries'][0]
            staged = request(doc, '/staged-assets?extension=png', (root / 'red.png').read_bytes())
            geometry = {**image['geometry'], 'width': image['geometry']['width'] * 1.25}
            new_text = 'Saved' if kind == 'pdf' else 'Saved 中文😀'
            patch = {'schemaVersion': 'hcd-patch/3', 'documentId': doc, 'patchId': 'joint-fixed-save', 'baseRevision': 0, 'operations': [
                {'op': 'text.splice', 'nodeId': text['nodeId'], 'start': 0, 'deleteCount': len(text['text']), 'insertText': new_text, 'precondition': {'nodeHash': text['nodeHash']}},
                {'op': 'image.replace', 'nodeId': image['nodeId'], 'assetHash': staged['hash'], 'precondition': {'visualHash': image['visualHash']}},
                {'op': 'image.geometry', 'nodeId': image['nodeId'], 'geometry': geometry, 'precondition': {'visualHash': image['visualHash']}}]}
            invalid = copy.deepcopy(patch); invalid['operations'][1]['assetHash'] = '0' * 64
            rejected_status, _ = request(doc, '/edits', invalid, expected=None)
            assert 400 <= rejected_status < 600, rejected_status
            assert request(doc, '')['revision'] == 0
            assert request(doc, '/edits/receipt', patch)['status'] == 'missing'
            assert request(doc, '')['revision'] == 0
            saved = request(doc, '/edits', patch)
            assert saved['revision'] == 1 and len(saved['images']) == 1
            assert saved['images'][0]['assetHash'] == staged['hash'] and saved['images'][0]['geometry'] == geometry
            assert request(doc, '/text/' + text['nodeId'])['text'] == new_text
            output = request(doc, '/export/' + kind + '?revision=1' + ('&source=true' if kind == 'pdf' else ''), raw=True)
            (root / f'saved.{kind}').write_bytes(output)
            if kind in ['docx', 'pptx']:
                with zipfile.ZipFile(io.BytesIO(output)) as archive:
                    part = 'word/document.xml' if kind == 'docx' else 'ppt/slides/slide1.xml'
                    body = ET.fromstring(archive.read(part))
                    assert new_text in ''.join(body.itertext())
                    relpath = posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part) + '.rels')
                    relations = {item.attrib['Id']: item.attrib['Target'] for item in ET.fromstring(archive.read(relpath))}
                    blips = body.findall('.//{http://schemas.openxmlformats.org/drawingml/2006/main}blip')
                    assert len(blips) == 1
                    target = relations[blips[0].attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed']]
                    resource = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(posixpath.dirname(part), target))
                    assert archive.read(resource) == (root / 'red.png').read_bytes()
                    extent = body.find('.//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent') if kind == 'docx' else body.find('.//{http://schemas.openxmlformats.org/presentationml/2006/main}pic/{http://schemas.openxmlformats.org/presentationml/2006/main}spPr/{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm/{http://schemas.openxmlformats.org/drawingml/2006/main}ext')
                    assert int(extent.attrib['cx']) == int(geometry['width'])
            else:
                # Independent reader verifies the active image, not an unused
                # original XObject that may legitimately remain in the PDF.
                from pypdf import PdfReader
                from pypdf.generic import ContentStream
                reader = PdfReader(io.BytesIO(output)); page = reader.pages[0]
                assert new_text in page.extract_text()
                operations = ContentStream(page.get_contents(), reader).operations
                active = [operands[0] for operands, operator in operations if operator == b'Do']
                assert len(active) == 1
                actual_image = page['/Resources']['/XObject'][active[0]].get_object()
                assert actual_image.get_data() == bytes([255, 0, 0])
                assert any(operator == b'cm' and [float(v) for v in operands] == [1.25, 0, 0, 1, 0, 0] for operands, operator in operations)
            blue = request(doc, '/staged-assets?extension=png', png([0, 0, 255]))
            later = copy.deepcopy(patch); later.update(baseRevision=1, patchId='later-image')
            later['operations'] = [{'op': 'image.replace', 'nodeId': image['nodeId'], 'assetHash': blue['hash'], 'precondition': {'visualHash': saved['images'][0]['visualHash']}}]
            request(doc, '/edits', later)
            replay = request(doc, '/edits', patch)
            assert replay['revision'] == 1 and replay['idempotentReplay'] and replay['images'] == saved['images']
            resolved = request(doc, '/edits/receipt', patch)
            assert resolved['status'] == 'committed' and resolved['revision'] == 1
            assert resolved['images'] == saved['images'] and resolved['nodeHashes'] == saved['nodeHashes']
            changed = copy.deepcopy(patch); changed['operations'][0]['insertText'] = 'Wrong request body'
            request(doc, '/edits/receipt', changed, expected=409)
            assert request(doc, '')['revision'] == 2
            assert command('validate', bundle)['valid']
            evidence.append({'format': kind, 'atomicRevision': 1, 'laterHead': 2, 'immutableResourceReceipt': True, 'readOnlyReceiptQueryVerified': True, 'actualFileExported': True, 'officeReferencedMediaBytesAndWidthChecked': kind != 'pdf', 'pdfNativeTextActiveImageAndTransformChecked': kind == 'pdf'})
        (root / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print(json.dumps({'workDir': str(root), 'cases': evidence}, indent=2))
    finally:
        server.terminate(); server.wait(timeout=15)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--officecli', type=Path, default=Path('target/debug/officecli'))
    parser.add_argument('--work-dir', type=Path)
    args = parser.parse_args()
    exercise(args.officecli.resolve(), args.work_dir.resolve() if args.work_dir else Path(tempfile.mkdtemp(prefix='hcd-fixed-save-')))
