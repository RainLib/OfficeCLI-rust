#!/usr/bin/env python3
"""Verify selective saved undo/redo through the real editor controller/API and files.
Requires the editor's npm dependencies, built officecli, and pypdf.
"""
import argparse
import io
import json
import os
from pathlib import Path
import posixpath
import runpy
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


def verify_exports(root, evidence):
    for item in evidence:
        kind = item['format']
        for direction, revision in [('undo', 5), ('redo', 8)]:
            data = (root / f'history-{direction}.{kind}').read_bytes()
            expected_text = item['originalText'] if direction == 'undo' else item['editedText']
            width = item['originalGeometry']['width'] * (1 if direction == 'undo' else 1.25)
            height = item['peerHeight']
            if kind != 'pdf':
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    part = 'word/document.xml' if kind == 'docx' else 'ppt/slides/slide1.xml'
                    body = ET.fromstring(archive.read(part))
                    assert expected_text in ''.join(body.itertext())
                    relpath = posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part) + '.rels')
                    relations = {node.attrib['Id']: node.attrib['Target'] for node in ET.fromstring(archive.read(relpath))}
                    blips = body.findall('.//{http://schemas.openxmlformats.org/drawingml/2006/main}blip')
                    assert len(blips) == 1
                    target = relations[blips[0].attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed']]
                    media = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(posixpath.dirname(part), target))
                    # Compare bytes referenced by the active blip relationship.
                    import hashlib
                    assert hashlib.sha256(archive.read(media)).hexdigest() == (item['originalAsset'] if direction == 'undo' else item['editedAsset'])
                    extent = body.find('.//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent') if kind == 'docx' else body.find('.//{http://schemas.openxmlformats.org/presentationml/2006/main}pic/{http://schemas.openxmlformats.org/presentationml/2006/main}spPr/{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm/{http://schemas.openxmlformats.org/drawingml/2006/main}ext')
                    assert int(extent.attrib['cx']) == int(width)
                    assert int(extent.attrib['cy']) == int(height)
            else:
                from pypdf import PdfReader
                from pypdf.generic import ContentStream
                reader = PdfReader(io.BytesIO(data)); page = reader.pages[0]
                assert expected_text in page.extract_text()
                operations = ContentStream(page.get_contents(), reader).operations
                # Evaluate only the graphics-state CTM active at an actual Do.
                matrix = (1., 0., 0., 1., 0., 0.); stack = []; active = []
                for operands, operator in operations:
                    if operator == b'q': stack.append(matrix)
                    elif operator == b'Q': matrix = stack.pop()
                    elif operator == b'cm':
                        a, b, c, d, e, f = map(float, operands); A, B, C, D, E, F = matrix
                        matrix = (a*A+b*C, a*B+b*D, c*A+d*C, c*B+d*D, e*A+f*C+E, e*B+f*D+F)
                    elif operator == b'Do': active.append((operands[0], matrix))
                assert len(active) == 1
                name, ctm = active[0]
                image = page['/Resources']['/XObject'][name].get_object()
                assert image.get_data() == (bytes([0, 0, 255]) if direction == 'undo' else bytes([255, 0, 0]))
                assert abs(abs(ctm[0]) - width) < .001, (ctm, width)
                assert abs(abs(ctm[3]) - height) < .001, (ctm, height)
                if direction == 'undo':
                    # The source image is reused, including its original identity.
                    assert name == '/Im1', name
            print(f'PASS {kind} {direction} r{revision}: active image, text, own width and peer height')
        item['independentFileVerification'] = True


def verify_field_exports(root, evidence):
    import hashlib
    from pypdf import PdfReader
    from pypdf.generic import ContentStream
    for item in evidence:
        kind = item['format']
        for phase, suffix in [('merged', 'merged'), ('choice', 'choice')]:
            data = (root / f'field-{suffix}.{kind}').read_bytes()
            geometry = item[phase]['geometry']
            if kind != 'pdf':
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    part = 'word/document.xml' if kind == 'docx' else 'ppt/slides/slide1.xml'
                    body = ET.fromstring(archive.read(part))
                    assert item['expectedText'] in ''.join(body.itertext())
                    relations = {node.attrib['Id']: node.attrib['Target'] for node in ET.fromstring(archive.read(posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part) + '.rels')))}
                    blip = body.find('.//{http://schemas.openxmlformats.org/drawingml/2006/main}blip')
                    target = relations[blip.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed']]
                    media = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(posixpath.dirname(part), target))
                    assert hashlib.sha256(archive.read(media)).hexdigest() == item[phase]['assetHash']
                    extent = body.find('.//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent') if kind == 'docx' else body.find('.//{http://schemas.openxmlformats.org/presentationml/2006/main}pic/{http://schemas.openxmlformats.org/presentationml/2006/main}spPr/{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm/{http://schemas.openxmlformats.org/drawingml/2006/main}ext')
                    assert int(extent.attrib['cx']) == int(geometry['width'])
                    assert int(extent.attrib['cy']) == int(geometry['height'])
                    if kind == 'pptx':
                        offset = body.find('.//{http://schemas.openxmlformats.org/presentationml/2006/main}pic/{http://schemas.openxmlformats.org/presentationml/2006/main}spPr/{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm/{http://schemas.openxmlformats.org/drawingml/2006/main}off')
                        assert int(offset.attrib['x']) == int(geometry['x'])
                        assert int(offset.attrib['y']) == int(geometry['y'])
            else:
                reader = PdfReader(io.BytesIO(data)); page = reader.pages[0]
                assert item['expectedText'] in page.extract_text()
                matrix = (1.,0.,0.,1.,0.,0.); stack = []; active = []
                for operands, operator in ContentStream(page.get_contents(), reader).operations:
                    if operator == b'q': stack.append(matrix)
                    elif operator == b'Q': matrix = stack.pop()
                    elif operator == b'cm':
                        a,b,c,d,e,f = map(float, operands); A,B,C,D,E,F = matrix
                        matrix = (a*A+b*C,a*B+b*D,c*A+d*C,c*B+d*D,e*A+f*C+E,e*B+f*D+F)
                    elif operator == b'Do': active.append((operands[0], matrix))
                assert len(active) == 1
                name, ctm = active[0]
                assert page['/Resources']['/XObject'][name].get_object().get_data() == bytes(item[phase]['rgb'])
                assert abs(abs(ctm[0])-geometry['width']) < .001
                assert abs(abs(ctm[3])-geometry['height']) < .001
                assert abs(ctm[4]-geometry['x']) < .001
                assert abs(ctm[5]-(200-geometry['y']-geometry['height'])) < .001
            print(f'PASS {kind} {phase}: actual active resource, text and merged geometry')
        item['independentFileVerification'] = True


def exercise(binary, root):
    repo = Path(__file__).resolve().parents[1]
    root.mkdir(parents=True, exist_ok=True)
    if any(root.iterdir()): raise RuntimeError('use an empty work directory')
    helpers = runpy.run_path(str(repo / 'scripts/hcd-fixed-image-transaction.py'))
    helpers['fixtures'](root); (root / 'sources').mkdir()
    (root / 'red.png').write_bytes(helpers['png']([255, 0, 0]))
    (root / 'green.png').write_bytes(helpers['png']([0, 255, 0]))
    (root / 'blue.png').write_bytes(helpers['png']([0, 0, 255]))
    env = {**os.environ, 'HCD_TOKEN_SECRET': secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']: env.pop(key, None)
    def cli(*args):
        result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], env=env, capture_output=True, text=True, check=True, timeout=120)
        return json.loads(result.stdout)['data']
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
    config = {'root': str(root), 'apiUrl': f'http://127.0.0.1:{port}/v1/documents', 'documents': []}
    for kind in ['pptx', 'pdf', 'docx']:
        doc = 'history-' + kind; source = root / f'fixture.{kind}'; bundle = root / f'{doc}.hcd'
        cli('import', source, '--output', bundle, '--document-id', doc)
        (root / 'sources' / f'{doc}.{kind}').write_bytes(source.read_bytes())
        token = cli('issue-token', '--document-id', doc, '--scope', 'write', '--user-id', 'history-writer', '--ttl-seconds', 3600)['token']
        peer = cli('issue-token', '--document-id', doc, '--scope', 'write', '--user-id', 'history-peer', '--ttl-seconds', 3600)['token']
        text = next(entry for entry in cli('extract-text', bundle)['entries'] if entry['text'].strip())
        config['documents'].append({'documentId': doc, 'format': kind, 'token': token, 'peerToken': peer, 'text': text})
    private = root / 'history-env.json'; private.write_text(json.dumps(config)); private.chmod(0o600)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with open(root / 'api.log', 'wb') as log:
        server = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{port}'], env=env, stdout=log, stderr=log)
    try:
        for _ in range(100):
            try:
                first = config['documents'][0]
                opener.open(urllib.request.Request(config['apiUrl'] + '/' + first['documentId'] + '/auth', headers={'Authorization': 'Bearer ' + first['token']}), timeout=5).close(); break
            except urllib.error.URLError:
                if server.poll() is not None: raise RuntimeError('fixture API exited')
                time.sleep(.05)
        subprocess.run(['node', '--import', str(repo / 'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'), str(repo / 'scripts/hcd-fixed-history.mts'), str(private)], cwd=repo, check=True, timeout=300)
        subprocess.run(['node', '--import', str(repo / 'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'), str(repo / 'scripts/hcd-fixed-field-merge.mts'), str(private)], cwd=repo, check=True, timeout=300)
        evidence = json.loads((root / 'history-evidence.json').read_text())
        verify_exports(root, evidence)
        field_evidence = json.loads((root / 'field-merge-evidence.json').read_text())
        verify_field_exports(root, field_evidence)
        (root / 'field-merge-evidence.json').write_text(json.dumps(field_evidence, ensure_ascii=False, indent=2) + '\n')
        for item in config['documents']:
            assert cli('validate', root / (item['documentId'] + '.hcd'))['valid']
        (root / 'history-evidence.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'workDir': str(root), 'formatsVerified': [item['format'] for item in evidence]}))
    finally:
        server.terminate(); server.wait(timeout=15)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--officecli', type=Path, default=Path('target/debug/officecli'))
    parser.add_argument('--work-dir', type=Path)
    parser.add_argument('--verify-existing', type=Path)
    args = parser.parse_args()
    if args.verify_existing:
        evidence = json.loads((args.verify_existing / 'history-evidence.json').read_text()); verify_exports(args.verify_existing, evidence)
    else:
        exercise(args.officecli.resolve(), args.work_dir.resolve() if args.work_dir else Path(tempfile.mkdtemp(prefix='hcd-fixed-history-')))
