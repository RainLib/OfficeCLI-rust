#!/usr/bin/env python3
"""Owned Word outline/native/room fixture. No browser or user document writes."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


def main():
    repo = Path(__file__).resolve().parents[1]
    root = Path(tempfile.mkdtemp(prefix='word-outline-', dir=repo / 'target/hcd-preview-runtime'))
    assets = repo / 'docs/assets/hcd-word-outline-2026-10-27'
    assets.mkdir(exist_ok=True)
    binary = repo / 'target/debug/officecli'
    env = {**os.environ, 'NO_COLOR': '1', 'HCD_TOKEN_SECRET': secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        env.pop(key, None)

    def cli(*args):
        result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'],
                                cwd=root, env=env, capture_output=True, text=True, check=True, timeout=120)
        return json.loads(result.stdout)['data']

    def heading(text, level=0):
        return f'<w:p><w:pPr><w:outlineLvl w:val="{level}"/></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>'

    source = root / 'source.docx'
    with zipfile.ZipFile(repo / 'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx') as original, zipfile.ZipFile(source, 'w') as generated:
        for name in original.namelist():
            content = original.read(name)
            if name == 'word/document.xml':
                text = content.decode().replace('<w:body>', '<w:body>' + heading('Repeated title'), 1)
                at = text.rfind('<w:sectPr')
                text = text[:at] + heading('Repeated title', 1) + heading('Second section title') + ''.join(heading(f'Long outline {i:03}', 2) for i in range(1, 181)) + text[at:]
                content = text.encode()
            elif name == 'word/header1.xml':
                content = content.decode().replace('</w:hdr>', heading('Header heading excluded') + '</w:hdr>').encode()
            generated.writestr(name, content)
    bundle = root / 'outline.hcd'
    cli('import', source, '--word-regions', '--document-id', 'outline', '--output', bundle)
    cli('project-editor', bundle, '--word-regions', '--expected-revision', 0)
    (root / 'collaboration').mkdir()
    (root / 'collaboration/outline.epoch').write_text(json.dumps({'epoch': 1, 'protocol': 'hcd-word-regions/1', 'nodeEdits': 7}))
    ports = []
    for _ in range(2):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            ports.append(probe.getsockname()[1])
    config = {'root': str(root), 'secret': env['HCD_TOKEN_SECRET'], 'origin': f'http://127.0.0.1:{ports[0]}', 'apiUrl': f'http://127.0.0.1:{ports[0]}/v1/documents/outline', 'collabPort': ports[1]}
    for user in ['alice', 'bob', 'reader']:
        config[user] = cli('issue-token', '--document-id', 'outline', '--scope', 'read' if user == 'reader' else 'write', '--user-id', user, '--ttl-seconds', 3600)['token']
    private = root / 'private.json'
    private.write_text(json.dumps(config)); private.chmod(0o600)
    with open(root / 'native.log', 'w') as log:
        native = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{ports[0]}'], env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 30
            while True:
                assert native.poll() is None
                try:
                    urllib.request.urlopen(urllib.request.Request(config['apiUrl'] + '/auth', headers={'Authorization': 'Bearer ' + config['reader']}), timeout=1).close()
                    break
                except OSError:
                    assert time.monotonic() < deadline
                    time.sleep(.1)
            worker = subprocess.run(['node', '--import', str(repo / 'examples/hdoc/editor/node_modules/tsx/dist/loader.mjs'), str(repo / 'scripts/hcd-word-outline.mts'), str(private)], cwd=repo, env=env, capture_output=True, text=True, timeout=180)
            (assets / 'socket-test.log').write_text(worker.stdout + worker.stderr)
            if worker.returncode:
                raise RuntimeError(worker.stdout + worker.stderr)
            evidence = json.loads((root / 'outline-evidence.json').read_text())
            head = evidence['head']
            states = {n: cli('editor-state', bundle, '--revision', n) for n in [1, head]}
            output = root / f'outline-r{head}.docx'
            cli('export', bundle, '--revision', head, '--output', output)
            with zipfile.ZipFile(output) as exported:
                body = ''.join(ET.fromstring(exported.read('word/document.xml')).itertext())
                assert 'Peer renamed heading' in body and 'Before heading' in body and 'Long outline 180' in body
                assert 'Header heading excluded' not in body
                headers = [''.join(ET.fromstring(exported.read(n)).itertext()) for n in exported.namelist() if n.startswith('word/header') and n.endswith('.xml')]
                assert any('Header heading excluded' in text for text in headers)
            archive = root / 'outline-history.hcdz'
            cli('pack', bundle, '--output', archive)
            offline = root / 'offline.hcd'
            cli('unpack', archive, '--output', offline)
            for revision, state in states.items():
                assert cli('editor-state', offline, '--revision', revision) == state
            assert cli('validate', offline)['valid']
            for path in [source, output, archive]:
                shutil.copyfile(path, assets / path.name)
            evidence.update(actualDocxStoryPlacement=True, offlineVersionsExact=list(states), sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(), fixture=str(root))
            (assets / 'native-and-files.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps(evidence, ensure_ascii=False))
        finally:
            native.terminate()
            try:
                native.wait(timeout=5)
            except subprocess.TimeoutExpired:
                native.kill(); native.wait()


if __name__ == '__main__':
    main()
