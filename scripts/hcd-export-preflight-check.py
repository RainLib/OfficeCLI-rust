#!/usr/bin/env python3
"""Verify revision-specific source preflight against the real owned PPTX fixture."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    root = args.root.resolve()
    assert root.parent == repo / 'target/hcd-preview-runtime' and root.name.startswith('hcd-workbook-')
    config = json.loads((root / 'private.json').read_text())
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    env = {**os.environ, 'HCD_TOKEN_SECRET': config['secret']}
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        env.pop(key, None)
    process = subprocess.Popen([str(repo / 'target/debug/officecli'), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{port}'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://127.0.0.1:{port}/v1/documents/book'
    def get(path):
        request = urllib.request.Request(url + path, headers={'Authorization': 'Bearer ' + config['tokens']['reader']})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()
    try:
        deadline = time.monotonic() + 30
        while True:
            if process.poll() is not None:
                raise RuntimeError('owned native service exited')
            try:
                head = json.loads(get(''))
                break
            except urllib.error.URLError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.1)
        assert head['revision'] == 2
        options = [json.loads(get(f'/export-options?revision={revision}')) for revision in (0, 1, 2)]
        assert all(option['sourceAvailable'] for option in options)
        assert options[0]['sourceEditsSupported'] and options[0]['reasonCode'] is None
        for option in options[1:]:
            assert not option['sourceEditsSupported'] and option['reasonCode'] == 'IMAGE_SOURCE_UNSUPPORTED'
        for revision in (1, 2):
            try:
                get(f'/export/pptx?revision={revision}&source=true')
                raise AssertionError('unsafe source export was not rejected')
            except urllib.error.HTTPError as error:
                assert error.code == 400
            assert get(f'/export/pptx?revision={revision}&source=false')[:2] == b'PK'
        assert json.loads(get(''))['revision'] == 2
        args.output.mkdir(parents=True, exist_ok=True)
        result = {'revision': 2, 'options': options, 'sourceRejectionMatchesPreflight': True, 'semanticPptxAvailable': True}
        (args.output / 'export-preflight.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(result, ensure_ascii=False))
    finally:
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


if __name__ == '__main__':
    main()
