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
        inspect = {'expectedRevision': 0, 'sourceSha256': manifest['source']['sha256'], 'cells': [{'sheetId': grid['sheetId'], 'row': 3, 'column': 3}]}
        assert document('/grid/cells/inspect', 'reader', inspect)[0] == 403
        status, observed = document('/grid/cells/inspect', 'alice', inspect)
        assert status == 200 and observed['revision'] == 0 and observed['cells'][0]['sheetPart'] == 'xl/worksheets/sheet1.xml'
        assert observed['cells'][0]['address'] == 'C3' and observed['cells'][0]['sheetId'] == grid['sheetId']
        duplicate = {**inspect, 'cells': inspect['cells'] * 2}
        assert document('/grid/cells/inspect', 'alice', duplicate)[0] == 400
        invalid = {**inspect, 'cells': [{'sheetId': grid['sheetId'], 'row': 0, 'column': 1}]}
        assert document('/grid/cells/inspect', 'alice', invalid)[0] == 400
        occupied = {**inspect, 'cells': [{'sheetId': grid['sheetId'], 'row': 1, 'column': 1}]}
        assert document('/grid/cells/inspect', 'alice', occupied)[0] in (400, 409, 422)
        attempt = {'documentId': 'book', 'patchId': 'create-http', 'baseRevision': 0, 'sourceSha256': manifest['source']['sha256'], 'actor': {'userId': 'forged'}, 'cells': [{'sheetId': grid['sheetId'], 'sheetPart': 'xl/worksheets/sheet1.xml', 'row': 3, 'column': 3, 'text': 'HTTP 新格 😀'}]}
        route = '/grid/cells'
        assert document(route, 'reader', attempt)[0] == 403
        assert document(route + '/receipt', 'alice', attempt)[1]['status'] == 'missing'
        status, result = document(route, 'alice', attempt)
        assert status == 200 and result['revision'] == 1 and not result['idempotentReplay']
        assert result['dirtyNodeIds'] == [observed['cells'][0]['nodeId']]
        assert document('/grid/cells/inspect', 'alice', inspect)[0] == 409
        status, receipt = document(route + '/receipt', 'alice', attempt)
        assert status == 200 and receipt['status'] == 'committed' and receipt['revision'] == 1
        event_request = urllib.request.Request(base + '/v1/documents/book/events?afterRevision=0', headers={'Authorization': 'Bearer ' + tokens['bob']})
        with urllib.request.urlopen(event_request, timeout=20) as stream:
            for line in stream:
                if line.startswith(b'data:'):
                    event = json.loads(line[5:].strip())
                    break
            else:
                raise AssertionError('missing revision event')
        assert event['revision'] == 1 and event['reset'] and any(node['text'] == 'HTTP 新格 😀' for node in event['nodes'])
        assert document(route + '/receipt', 'bob', attempt)[0] == 403
        assert document('/revisions/1')[1]['authorId'] == 'alice'
        altered = json.loads(json.dumps(attempt)); altered['cells'][0]['text'] = 'different'
        assert document(route + '/receipt', 'alice', altered)[0] == 409
        stale = json.loads(json.dumps(attempt)); stale['patchId'] = 'stale'
        assert document(route, 'bob', stale)[0] == 409
        existing = json.loads(json.dumps(attempt)); existing['patchId'] = 'occupied'; existing['baseRevision'] = 1; existing['cells'][0].update(row=1, column=1)
        assert document(route, 'bob', existing)[0] in (400, 409, 422)
        assert document()[1]['revision'] == 1
        status, proof = document('/xlsx/formula-audit', 'alice', {'expectedRevision': 1})
        assert status == 200 and proof['sourceFreeEditsAuthorized']
        status, node = document('/text/' + result['dirtyNodeIds'][0])
        assert status == 200 and node['text'] == 'HTTP 新格 😀'
        (root / 'sources/book.xlsx').unlink()
        status, replay = document(route, 'alice', attempt)
        assert status == 200 and replay['idempotentReplay'] and replay['revision'] == 1
        new = json.loads(json.dumps(attempt)); new['patchId'] = 'missing-source'; new['baseRevision'] = 1; new['cells'][0]['column'] = 4
        assert document(route, 'alice', new)[0] == 422
        edit = {'schemaVersion': 'hcd-patch/3', 'documentId': 'book', 'patchId': 'source-free-edit', 'baseRevision': 1, 'actor': {}, 'metadata': {}, 'operations': [{'op': 'text.splice', 'nodeId': node['nodeId'], 'start': 0, 'deleteCount': 0, 'insertText': 'offline ', 'precondition': {'nodeHash': node['nodeHash']}}]}
        status, saved = document('/edits', 'alice', edit)
        assert status == 200 and saved['revision'] == 2
        shutil.copyfile(source, root / 'sources/book.xlsx')
        next_cell = json.loads(json.dumps(attempt)); next_cell['patchId'] = 'new-mapping'; next_cell['baseRevision'] = 2; next_cell['cells'][0].update(column=4, text='second')
        assert document(route, 'alice', next_cell)[1]['revision'] == 3
        current = document('/text/' + result['dirtyNodeIds'][0])[1]
        (root / 'sources/book.xlsx').unlink()
        stale_proof_edit = json.loads(json.dumps(edit)); stale_proof_edit.update(patchId='stale-proof-edit', baseRevision=3); stale_proof_edit['operations'][0]['precondition']['nodeHash'] = current['nodeHash']
        status, rejected = document('/edits', 'alice', stale_proof_edit)
        assert status == 422 and rejected['error'] == 'XLSX_FORMULA_PROOF_REQUIRED'
        shutil.copyfile(source, root / 'sources/book.xlsx')
        for revision in (0, 1, 2):
            status, data = request(f'/v1/documents/book/export/xlsx?revision={revision}&source=true')
            assert status == 200
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                sheet = archive.read('xl/worksheets/sheet1.xml').decode()
                assert ('HTTP 新格 😀' in sheet) == (revision >= 1)
                assert ('offline HTTP 新格 😀' in sheet) == (revision == 2)
                assert '<f>1+2</f>' in sheet
        assert document()[1]['revision'] == 3
        print(json.dumps({'http': 'passed', 'sourceInspection': True, 'readOnlyDenied': True, 'exactReceipt': True, 'authorEnforced': True, 'peerRevisionEvent': True, 'staleRejected': True, 'occupiedRejected': True, 'missingSourceReplay': True, 'sourceFreeSaved': True, 'changedMappingRequiresReaudit': True, 'xlsxRevisions': [0, 1, 2]}, ensure_ascii=False))
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait()
