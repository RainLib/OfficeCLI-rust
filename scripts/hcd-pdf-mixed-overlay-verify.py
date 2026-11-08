#!/usr/bin/env python3
"""Verify two independent source-free PDF text overlays and actual export."""
import json
import argparse
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from reportlab.pdfgen import canvas


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence-dir', type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    binary = repo / 'target/debug/officecli'
    with tempfile.TemporaryDirectory(prefix='hcd-pdf-overlays-') as directory:
        root = Path(directory)
        source, bundle = root / 'source.pdf', root / 'doc.hcd'
        pdf = canvas.Canvas(str(source), pagesize=(300, 300))
        pdf.setFont('Helvetica', 12)
        pdf.drawString(20, 250, 'First')
        pdf.drawString(20, 180, 'Second')
        pdf.setFillColorRGB(0, 0, 1)
        pdf.rect(180, 80, 40, 30, fill=1, stroke=0)
        pdf.save()

        def cli(*args):
            result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], capture_output=True, text=True, check=True)
            return json.loads(result.stdout)['data']

        cli('import', source, '--output', bundle, '--document-id', 'doc')
        entries = cli('extract-text', bundle)['entries']
        first = next(item for item in entries if item['text'] == 'First')
        second = next(item for item in entries if item['text'] == 'Second')
        def edit(node, text):
            return {'op': 'text.splice', 'nodeId': node['nodeId'], 'start': 0, 'deleteCount': len(node['text']), 'insertText': text, 'precondition': {'nodeHash': node['nodeHash']}}
        def apply(patch_id, revision, operations):
            patch = root / 'patch.json'
            patch.write_text(json.dumps({'schemaVersion': 'hcd-patch/1', 'documentId': 'doc', 'patchId': patch_id, 'baseRevision': revision, 'operations': operations}))
            return cli('apply', bundle, '--patch', patch, '--expected-revision', revision)

        apply('both-overlay', 0, [edit(first, 'A\nB'), edit(second, 'C\nD')])
        updated = cli('extract-text', bundle)['entries']
        apply('first-repaint', 1, [edit(next(item for item in updated if item['nodeId'] == first['nodeId']), 'A')])
        output = root / 'offline.pdf'
        blocked = subprocess.run([str(binary), 'hdoc', 'export', str(bundle), '--output', str(output), '--json'], capture_output=True, text=True)
        assert blocked.returncode != 0 and 'PDF_UNPAINTED_TEXT' in blocked.stdout + blocked.stderr
        assert not output.exists()

        # Exercise the actual authenticated API as well as the CLI. In particular,
        # source=true must not bypass the guard when converting to another format.
        env = {**os.environ, 'HCD_TOKEN_SECRET': secrets.token_hex(32)}
        for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
            env.pop(key, None)
        issued = subprocess.run([str(binary), 'hdoc', 'issue-token', '--document-id', 'doc', '--scope', 'read', '--user-id', 'reader', '--ttl-seconds', '300', '--json'], env=env, capture_output=True, text=True, check=True)
        token = json.loads(issued.stdout)['data']['token']
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        process = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{port}'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def request(path):
            req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/documents/doc/{path}', headers={'Authorization': f'Bearer {token}'})
            try:
                with urllib.request.urlopen(req, timeout=30) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()
        try:
            deadline = time.monotonic() + 20
            while True:
                try:
                    status, body = request('export-options?revision=2')
                    break
                except OSError:
                    if process.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError('isolated HCD server failed to start')
                    time.sleep(0.1)
            options = json.loads(body)
            assert status == 200 and options['semanticReasonCode'] == 'PDF_UNPAINTED_TEXT' and not options['semanticExportSupported'], (status, options)
            status, body = request('export-options?revision=0')
            assert status == 200 and json.loads(body)['semanticExportSupported'], (status, body)
            for fmt in ['pdf', 'html', 'md', 'txt', 'docx', 'pptx', 'xlsx']:
                for source_flag in ([False] if fmt == 'pdf' else [False, True]):
                    status, body = request(f'export/{fmt}?revision=2&source={str(source_flag).lower()}')
                    assert status == 422 and b'PDF_UNPAINTED_TEXT' in body, (fmt, source_flag, status, body)
            status, body = request('export/hcdz?revision=2')
            assert status == 200 and body.startswith(b'PK'), (status, body[:100])
            # Supplying the exact original must retain a source-backed route;
            # validate the actual resulting PDF, not only its HTTP status.
            (root / 'sources').mkdir()
            shutil.copyfile(source, root / 'sources/doc.pdf')
            status, body = request('export-options?revision=2')
            options = json.loads(body)
            assert status == 200 and options['sourceAvailable'] and not options['sourceEditsSupported'] and options['reasonCode'] == 'PDF_MULTILINE_SOURCE_UNSUPPORTED', (status, options)
            status, body = request('export/pdf?revision=2&source=true')
            # Multiline source replacement is currently unsupported. If that
            # changes, accept success only after checking the actual content.
            if status == 200:
                assert body.startswith(b'%PDF')
                source_export = root / 'source-backed.pdf'
                source_export.write_bytes(body)
                source_text = subprocess.run(['pdftotext', str(source_export), '-'], capture_output=True, text=True, check=True).stdout
                assert 'First' not in source_text and 'Second' not in source_text, source_text
                assert 'A' in source_text and 'C' in source_text and 'D' in source_text, source_text
            else:
                assert status == 400 and b'unsupported mode' in body, (status, body[:200])
            source_multiline_status = status

            updated = cli('extract-text', bundle)['entries']
            apply('second-repaint', 2, [edit(next(item for item in updated if item['nodeId'] == second['nodeId']), 'C')])
            status, body = request('export-options?revision=3')
            options = json.loads(body)
            assert status == 200 and options['semanticExportSupported'] and options['sourceEditsSupported'], (status, options)
            status, body = request('export/pdf?revision=2')
            assert status == 422 and b'PDF_UNPAINTED_TEXT' in body, (status, body)
            status, body = request('export/pdf?revision=3')
            assert status == 200 and body.startswith(b'%PDF'), (status, body[:100])
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        result = cli('export', bundle, '--output', output)
        assert result.get('level') == 'VISUAL', result
        extracted = subprocess.run(['pdftotext', str(output), '-'], capture_output=True, text=True, check=True).stdout
        for character in ['A', 'C']:
            assert character in extracted, (character, extracted)
        assert 'Second' not in extracted and 'D' not in extracted
        if args.evidence_dir:
            args.evidence_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(output, args.evidence_dir / 'export.pdf')
            subprocess.run(['pdftoppm', '-f', '1', '-l', '1', '-scale-to', '900', '-png', '-singlefile', str(output), str(args.evidence_dir / 'export')], check=True, capture_output=True)
        print(json.dumps({'scope': 'local synthetic PDF, CLI and authenticated HTTP export', 'blockedBeforeRepaint': True, 'historicalRevisionBlocked': True, 'crossFormatSourceFlagBlocked': True, 'hcdArchiveAvailable': True, 'sourceBackedMultilineStatus': source_multiline_status, 'revision': 3, 'text': extracted.strip(), 'fidelity': result.get('level')}))


if __name__ == '__main__':
    main()
