#!/usr/bin/env python3
"""Verify the transitional Word layout fence on a disposable archive copy."""
import hashlib
import hmac
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
import zipfile

repo = Path(__file__).resolve().parents[1]
binary = repo / 'target/debug/officecli'
archive = repo / 'docs/assets/hcd-word-layout-receipt-2026-10-27/layout-r7.hcdz'
evidence = repo / 'docs/assets/hcd-word-layout-server-fence-2026-10-27/http.json'
env = {**os.environ, 'HCD_TOKEN_SECRET': secrets.token_hex(32), 'NO_COLOR': '1'}

def cli(*args):
    result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], env=env, capture_output=True, text=True, check=True, timeout=120)
    return json.loads(result.stdout)['data']

with tempfile.TemporaryDirectory(prefix='hcd-layout-http-', dir=repo / 'target') as directory:
    root = Path(directory)
    bundle = root / 'region-test.hcd'
    cli('unpack', archive, '--output', bundle)
    before = (bundle / 'manifest.json').read_bytes()
    reader = cli('issue-token', '--document-id', 'region-test', '--scope', 'read', '--user-id', 'reader')['token']
    writer = cli('issue-token', '--document-id', 'region-test', '--scope', 'write', '--user-id', 'alice')['token']
    coordinator = cli('issue-token', '--document-id', 'region-test', '--scope', 'write', '--user-id', 'hcd-collaboration')['token']
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}/v1/documents/region-test'
    process = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{port}'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def request(path, token=None, body=None, extra=None):
        headers = {'X-HCD-Flow-Layout-Version': '2', **(extra or {})}
        if token: headers['Authorization'] = 'Bearer ' + token
        if body is not None: headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(origin + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as response: return response.status, response.read()
        except urllib.error.HTTPError as error: return error.code, error.read()
    try:
        deadline = time.monotonic() + 30
        while True:
            assert process.poll() is None
            try:
                if request('', reader)[0] == 200: break
            except urllib.error.URLError: pass
            assert time.monotonic() < deadline
            time.sleep(.05)
        manifest = json.loads(request('', reader)[1])
        assert manifest['revision'] == 7 and manifest['capabilities']['wordLayoutEdits'] == 1
        assert request('/editor', reader)[0] == 426
        assert request('/editor?revision=7', reader)[0] == 426
        status, raw = request('/editor?revision=4', reader)
        assert status == 200
        historical = json.loads(raw)
        assert historical['revision'] == 4
        changes = {'expectedRevision': 7, 'text': 'do not save', 'patchId': 'blocked-http-comment'}
        assert request('/comments', writer, changes)[0] == 426
        assert request('/images/n_00000000000000000000000000000000', writer, {'expectedRevision': 7, 'assetHash': 'a' * 64})[0] == 426
        regions = []
        layout = historical['flowLayout']
        for item in layout['sections'] + layout['stories']:
            blocks = [{'blockId': block['blockId'], 'content': block['content']} for block in historical['blocks'] if block.get('flowRegionId') == item['id']]
            regions.append({'regionId': item['id'], 'blocks': blocks, 'images': []})
        checkpoint = {'coordinatorVersion': 5, 'coordinatorId': 'a' * 32, 'checkpointId': 'b' * 32, 'coordinatorDigest': 'c' * 64, 'expectedRevision': 7, 'layoutHash': historical['flowLayoutHash'], 'typographyVersion': 2, 'regions': regions, 'contributors': [{'userId': 'alice', 'displayName': 'Alice'}]}
        assert request('/word/checkpoints', coordinator, checkpoint, {'X-HCD-Collaboration-Epoch': '0'})[0] == 426
        status, content = request('/export/docx?revision=7', reader)
        assert status == 200
        with zipfile.ZipFile(io.BytesIO(content)) as document:
            assert b'upperRoman' in document.read('word/document.xml')
        assert request('/export/docx?revision=7')[0] == 401
        # Opt in only this disposable server to the regional owner protocol.
        collab = root / 'collaboration'
        collab.mkdir(exist_ok=True)
        (collab / 'region-test.epoch').write_text(json.dumps({'epoch': 0, 'protocol': 'hcd-word-regions/1'}))
        control = {'X-HCD-Collaboration-Epoch': '0', 'X-HCD-Coordinator-Version': '5', 'X-HCD-Collaboration-Protocol': 'hcd-word-regions/1'}
        owner = {'version': 1, 'epoch': 0, 'ownerId': 'a' * 32, 'storeId': 'b' * 32, 'action': 'acquire', 'journalHashes': ['none']}
        status, raw = request('/collaboration/word-owner', coordinator, owner, control)
        assert status == 200
        lease = json.loads(raw)
        native = json.loads((repo / 'docs/assets/hcd-word-layout-receipt-2026-10-27/native-and-files.json').read_text())
        projections = repo / 'docs/assets/hcd-word-layout-transition-2026-10-27'
        fixture_path = root / 'layout-journal-fixture.json'
        fixture = {'previous': json.loads((projections / 'projection-r6.json').read_text()), 'next': json.loads((projections / 'projection-r7.json').read_text()), 'previousRoot': cli('get-revision', bundle, 6)['rootHash'], 'request': native['finalRequest'], 'record': native['finalRecord'], 'apiUrl': origin}
        env['HCD_TEST_TOKEN'] = coordinator
        fixture_path.write_text(json.dumps(fixture, ensure_ascii=False)); fixture_path.chmod(0o600)
        journal_script = repo / 'scripts/hcd-word-layout-journal-http.mts'
        def run_journal(stage):
            result = subprocess.run(['node', '--import', 'tsx', str(journal_script), stage, str(root / 'journal'), str(fixture_path)], cwd=repo / 'examples/hdoc/editor', env=env, capture_output=True, text=True, timeout=30)
            if result.returncode: raise RuntimeError(result.stderr[-4000:])
            return json.loads(result.stdout)
        prepared = run_journal('prepare')
        journal_hash = prepared['tip']
        owner.update({'action': 'record', 'leaseId': lease['leaseId'], 'journalHashes': ['none', journal_hash]})
        status, raw = request('/collaboration/word-owner', coordinator, owner, control)
        assert status == 200
        lease = json.loads(raw)
        fenced = {**control, 'X-HCD-Word-Owner': lease['leaseId'], 'X-HCD-Word-Owner-Id': lease['ownerId'], 'X-HCD-Word-Journal-Hash': journal_hash}
        payload = {'coordinatorId': 'e' * 32, 'transaction': native['finalRequest']}
        status, raw = request('/word/layout-receipt', coordinator, payload, fenced)
        assert status == 200
        receipt = json.loads(raw)
        projection = receipt.pop('projection')
        assert projection['revision'] == 7 and projection['flowLayoutHash'] == fixture['next']['flowLayoutHash']
        fixture['next'] = projection
        import base64
        message = f"hcd-layout-receipt/1:region-test:0:{'e'*32}:{journal_hash}:6:7:{payload['transaction']['transactionId']}:{receipt['requestHash']}:{receipt['rootHash']}"
        signature = base64.urlsafe_b64encode(hmac.new(env['HCD_TOKEN_SECRET'].encode(), message.encode(), hashlib.sha256).digest()).decode().rstrip('=')
        assert hmac.compare_digest(signature, receipt['signature'])
        proof_file = root / 'signature-check.json'
        proof_file.write_text(json.dumps({'record': native['finalRecord'], 'request': payload['transaction'], 'receipt': receipt}))
        proof_file.chmod(0o600)
        subprocess.run(['node', '--import', 'tsx', str(repo / 'scripts/hcd-word-layout-http-signature-check.mts'), str(proof_file)], cwd=repo / 'examples/hdoc/editor', env=env, capture_output=True, check=True, timeout=30)
        fixture.update({'receipt': receipt, 'header': prepared['header']})
        fixture_path.write_text(json.dumps(fixture, ensure_ascii=False))
        altered = json.loads(json.dumps(payload)); altered['transaction']['edits']['changes'][0]['value'] = 'portrait'
        assert request('/word/layout-receipt', coordinator, altered, fenced)[0] == 409
        assert request('/word/layout-receipt', coordinator, payload, {**fenced, 'X-HCD-Word-Journal-Hash': 'd'*64})[0] == 409
        assert request('/word/layout-receipt', writer, payload, fenced)[0] == 403
        assert request('/word/layout-receipt', None, payload, fenced)[0] == 401
        owner['action'] = 'release'
        assert request('/collaboration/word-owner', coordinator, owner, control)[0] == 200
        interrupted = run_journal('recover')
        assert interrupted['tcpResponseDropped'] and interrupted['receiptCalls'] == 1
        binding = json.loads((root / 'collaboration/word-owners/region-test.0.store.json').read_text())
        assert binding['journalHash'] == interrupted['tip']
        recovered = run_journal('resume')
        assert recovered['tip'] == interrupted['tip'] and recovered['revision'] == 7 and recovered['receiptCalls'] == 0 and recovered['lateTextPreserved']
        restarted = run_journal('verify')
        assert restarted['revision'] == 7 and restarted['lateTextPreserved'] and restarted['legacyReaderRejected']
        assert (bundle / 'manifest.json').read_bytes() == before
        assert cli('validate', bundle)['valid']
        evidence.write_text(json.dumps({'head': 7, 'latestProjection': 426, 'explicitHeadProjection': 426, 'historicalProjection': 200, 'legacyCheckpoint': 426, 'comment': 426, 'image': 426, 'authenticatedDocxExport': 200, 'unauthenticatedExport': 401, 'docxContainsPageNumberFormat': True, 'signedLayoutReceipt': 200, 'signatureVerified': True, 'typescriptVerifier': True, 'signedJournalCrossProcessRecovery': True, 'ownerRecordResponseTcpDropped': interrupted['tcpResponseDropped'], 'newOwnerResumedWithoutReceiptRequest': recovered['receiptCalls'] == 0, 'lateHeaderPreserved': restarted['lateTextPreserved'], 'legacyJournalReaderRejected': restarted['legacyReaderRejected'], 'alteredRequest': 409, 'wrongLeaseJournal': 409, 'ordinaryWriter': 403, 'unauthenticatedReceipt': 401, 'manifestUnchanged': True, 'bundleValid': True, 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest()}, indent=2) + '\n')
    finally:
        process.terminate()
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
