#!/usr/bin/env python3
"""Exercise XLSX cell creation against an isolated native HTTP server."""
import io
import json
import os
from pathlib import Path
import runpy
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

repo = Path(__file__).resolve().parents[1]
binary = repo / 'target/debug/officecli'
with tempfile.TemporaryDirectory(prefix='hcd-grid-http-') as directory:
    root = Path(directory)
    source = root / 'fixture.xlsx'
    runpy.run_path(str(repo / 'scripts/hcd-workbook-recovery-preview.py'))['fixture'](source)
    env = {**os.environ, 'HCD_TOKEN_SECRET': secrets.token_hex(32)}
    for key in ('HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT'):
        env.pop(key, None)
    subprocess.run([str(binary), 'hdoc', 'import', str(source), '--output', str(root / 'book.hcd'), '--document-id', 'book'], env=env, check=True, capture_output=True)
    (root / 'sources').mkdir()
    shutil.copyfile(source, root / 'sources/book.xlsx')
    tokens = {}
    for user, scope in [('alice', 'write'), ('bob', 'write'), ('reader', 'read')]:
        response = subprocess.run([str(binary), 'hdoc', 'issue-token', '--document-id', 'book', '--scope', scope, '--user-id', user, '--ttl-seconds', '600', '--json'], env=env, check=True, capture_output=True, text=True)
        tokens[user] = json.loads(response.stdout)['data']['token']
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    process = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{port}'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f'http://127.0.0.1:{port}'
    def request(path, user='alice', payload=None):
        headers = {'Authorization': 'Bearer ' + tokens[user]}
        data = None
        if payload is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(payload).encode()
        req = urllib.request.Request(base + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()
    def document(path='', user='alice', payload=None):
        status, body = request('/v1/documents/book' + path, user, payload)
        try:
            return status, json.loads(body)
        except json.JSONDecodeError:
            raise AssertionError(f'{path}: HTTP {status}: {body.decode(errors="replace")[:500]}')
    try:
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError('server exited during startup')
            try:
                if request('/health')[0] == 200:
                    break
            except urllib.error.URLError:
                time.sleep(.1)
        else:
            raise RuntimeError('server did not become ready')
        status, manifest = document()
        assert status == 200
        status, page = document('/index/0')
        assert status == 200
        grid = next(item['grid'] for item in page['chunks'] if item.get('grid', {}).get('kind') == 'cells')
        targets = [{'sheetId': grid['sheetId'], 'row': 3, 'column': 3}, {'sheetId': grid['sheetId'], 'row': 3, 'column': 4}]
        inspected = {'expectedRevision': 0, 'sourceSha256': manifest['source']['sha256'], 'cells': targets}
        status, observed = document('/grid/cells/inspect', 'alice', inspected)
        assert status == 200 and len(observed['cells']) == 2
        cells = [{**target, 'sheetPart': cell['sheetPart'], 'text': value} for target, cell, value in zip(targets, observed['cells'], ['批量甲😀', '批量乙'])]
        attempt = {'documentId': 'book', 'patchId': 'grid-batch-http', 'baseRevision': 0, 'sourceSha256': manifest['source']['sha256'], 'actor': {}, 'cells': cells}
        bad = json.loads(json.dumps(attempt)); bad['patchId'] = 'grid-batch-occupied'; bad['cells'][1].update(row=1, column=1)
        assert document('/grid/cells', 'alice', bad)[0] in (400, 409, 422)
        assert document()[1]['revision'] == 0
        status, saved = document('/grid/cells', 'alice', attempt)
        assert status == 200 and saved['revision'] == 1 and set(saved['dirtyNodeIds']) == {cell['nodeId'] for cell in observed['cells']}
        status, replay = document('/grid/cells/receipt', 'alice', attempt)
        assert status == 200 and replay['status'] == 'committed' and replay['revision'] == 1
        stale = json.loads(json.dumps(attempt)); stale['patchId'] = 'grid-never-committed'
        status, superseded = document('/grid/cells/receipt', 'alice', stale)
        assert status == 200 and superseded == {'status': 'superseded', 'patchId': stale['patchId'], 'baseRevision': 0, 'observedRevision': 1}
        assert document('/grid/cells', 'alice', stale)[0] in (400, 409, 422)
        altered = json.loads(json.dumps(attempt)); altered['cells'][1]['text'] = 'changed'
        assert document('/grid/cells/receipt', 'alice', altered)[0] == 409
        status, data = request('/v1/documents/book/export/xlsx?revision=1&source=true')
        assert status == 200
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            sheet = archive.read('xl/worksheets/sheet1.xml').decode()
            assert '批量甲😀' in sheet and '批量乙' in sheet and '<f>1+2</f>' in sheet
        evidence = {'scope': 'isolated native HTTP and synthetic XLSX', 'twoCellsOneRevision': True, 'mixedOccupiedRejectedAtomically': True, 'exactReceipt': True, 'supersededReceiptAndLateRejection': True, 'alteredReceiptRejected': True, 'xlsxReadback': True, 'formulaPreserved': True, 'browserOrEditorConnected': False}
        out = repo / 'docs/assets/hcd-workbook-batch-blank-2026-10-29'; out.mkdir(parents=True, exist_ok=True)
        (out / 'native.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps(evidence, ensure_ascii=False))
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait()
