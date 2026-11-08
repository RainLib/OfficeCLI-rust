#!/usr/bin/env python3
"""Owned inline coordinator HTTP, real lost TCP response and separate processes.
No existing room, user document, manager UI or reminder delivery is changed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--deletions', action='store_true', help='Exercise removed inline bodies, late edits and coordinator restoration')
    modes.add_argument('--properties', action='store_true', help='Also exercise internal property candidates, resolution and late property recovery')
    parser.add_argument('--recovery-archive', action='store_true', help='Carry canonical HCDZ, pending review and resources through a portable file; requires --deletions')
    args = parser.parse_args()
    if args.recovery_archive and not args.deletions:
        parser.error('--recovery-archive requires --deletions')
    repo = Path(__file__).resolve().parents[1]
    editor = repo / 'examples/hdoc/editor'
    binary = repo / 'target/debug/officecli'
    root = Path(tempfile.mkdtemp(prefix='hcd-semantic-recovery-' if args.recovery_archive else 'hcd-inline-deletion-' if args.deletions else 'hcd-inline-properties-' if args.properties else 'hcd-inline-save-', dir=repo / 'target/hcd-preview-runtime'))
    assets = repo / ('docs/assets/hcd-semantic-recovery-2026-10-27' if args.recovery_archive else 'docs/assets/hcd-inline-deletion-2026-10-27' if args.deletions else 'docs/assets/hcd-inline-properties-2026-10-27' if args.properties else 'docs/assets/hcd-inline-save-2026-10-27')
    assets.mkdir(exist_ok=True)
    env = {**os.environ, 'NO_COLOR': '1', 'HCD_TOKEN_SECRET': os.urandom(32).hex()}
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        env.pop(key, None)

    def cli(*args):
        result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], cwd=root,
                                env=env, capture_output=True, text=True, check=True, timeout=120)
        return json.loads(result.stdout)['data']

    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    archive = repo / 'docs/assets/hcd-inline-content-native-2026-10-26/inline-native-r8.hcdz'
    archive_hash = digest(archive)
    bundle = root / 'inline-native.hcd'
    cli('unpack', archive, '--output', bundle)
    before = cli('editor-state', bundle)
    assert before['revision'] == 8
    (root / 'people').mkdir()
    (root / 'people/inline-native.json').write_text(json.dumps({'schemaVersion': 'hcd-people/1', 'generation': 1,
        'people': [{'id': 'alice', 'label': 'Alice 王', 'active': True}, {'id': 'bob', 'label': 'Bob 李', 'active': True}]}))
    native_port = port()
    origin = f'http://127.0.0.1:{native_port}'
    api_url = origin + '/v1/documents/inline-native'
    config = {'root': str(root), 'secret': env['HCD_TOKEN_SECRET'], 'apiUrl': api_url, 'propertyEdits': args.properties, 'deletionReview': args.deletions, 'recoveryArchive': args.recovery_archive, 'binary': str(binary)}
    for name, user, scope in [('service', 'hcd-collaboration', 'write'), ('alice', 'alice', 'write'), ('bob', 'bob', 'write'), ('reader', 'reader', 'read')]:
        config[name] = cli('issue-token', '--document-id', 'inline-native', '--scope', scope, '--user-id', user,
                           '--display-name', {'alice': 'Alice 王', 'bob': 'Bob 李'}.get(name, name), '--ttl-seconds', 1200)['token']

    class Drop(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            data = self.rfile.read(int(self.headers['Content-Length']))
            headers = {key: value for key, value in self.headers.items() if key.lower() not in ['host', 'connection', 'content-length']}
            request = urllib.request.Request(api_url + '/checkpoints', data=data, headers=headers, method='POST')
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    result, status = response.read(), response.status
            except urllib.error.HTTPError as error:
                result, status = error.read(), error.code
            (root / 'committed-response.json').write_bytes(result)
            (root / 'committed-status.json').write_text(json.dumps({'status': status}))
            if status != 200:
                self.send_response(status)
                self.end_headers()
                self.wfile.write(result)
                return
            deadline = time.monotonic() + 60
            while not (root / 'release-drop').exists() and time.monotonic() < deadline:
                time.sleep(.025)
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()

    proxy = ThreadingHTTPServer(('127.0.0.1', 0), Drop)
    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    config['dropUrl'] = f'http://127.0.0.1:{proxy.server_port}/drop'
    private = root / 'private.json'
    private.write_text(json.dumps(config))
    private.chmod(0o600)
    log = open(root / 'native.log', 'w')
    native = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{native_port}'],
                              cwd=root, env=env, stdout=log, stderr=log)
    try:
        deadline = time.monotonic() + 30
        while True:
            assert native.poll() is None, 'native server exited'
            try:
                urllib.request.urlopen(origin + '/health', timeout=1).close()
                break
            except OSError:
                assert time.monotonic() < deadline
                time.sleep(.1)
        for stage in ['prepare', 'resume']:
            if args.recovery_archive and stage == 'resume':
                cli('pack', bundle, '--revision', 9, '--output', root / 'recovery-canonical.hcdz')
                extra = json.loads((root / 'uncommitted-resource.json').read_text())
                with zipfile.ZipFile(root / 'recovery-canonical.hcdz') as canonical_zip:
                    assert not any(extra['hash'] in name for name in canonical_zip.namelist()), 'uncommitted bytes unexpectedly became canonical'
                record = cli('get-revision', bundle, 9)
                config['recoveryScope'] = {'documentId': 'inline-native', 'epoch': 0, 'model': 'structure3-inline1', 'revision': 9, 'rootHash': record['rootHash']}
                private.write_text(json.dumps(config))
                archived = subprocess.run(['node', '--import', 'tsx', 'fixtures/semanticRecoveryArchiveFiles.ts', str(private), 'archive'], cwd=editor, capture_output=True, text=True, timeout=120)
                (root / 'archive.log').write_text(archived.stdout + archived.stderr)
                if archived.returncode:
                    raise RuntimeError(archived.stdout + archived.stderr)
            completed = subprocess.run(['node', '--import', 'tsx', 'fixtures/inlineDeletionSaveFiles.ts' if args.deletions else 'fixtures/inlineSaveFiles.ts', str(private), stage],
                                       cwd=editor, capture_output=True, text=True, timeout=150)
            (root / (stage + '.log')).write_text(completed.stdout + completed.stderr)
            if completed.returncode:
                raise RuntimeError(completed.stdout + completed.stderr)
        assert json.loads((root / 'committed-status.json').read_text())['status'] == 200
        after = cli('editor-state', bundle)
        assert after['revision'] == 10 and cli('validate', bundle)['valid']
        packed = root / 'inline-save-r10.hcdz'
        cli('pack', bundle, '--output', packed)
        reopened = root / 'offline.hcd'
        cli('unpack', packed, '--output', reopened)
        for revision in [8, 9, 10]:
            assert cli('editor-state', reopened, '--revision', revision) == cli('editor-state', bundle, '--revision', revision)
        if args.properties:
            def wrappers(value):
                if isinstance(value, dict):
                    if value.get('schemaVersion') == 'hcd.extension/3':
                        yield value
                    for child in value.values():
                        yield from wrappers(child)
                elif isinstance(value, list):
                    for child in value:
                        yield from wrappers(child)
            chosen = json.loads((root / 'prepare-evidence.json').read_text())['chosen']
            for revision, label in [(9, 'Bob'), (10, '迟到属性')]:
                value = next(v for v in wrappers(cli('editor-state', reopened, '--revision', revision)) if v['instanceId'] == chosen)
                assert value['data']['reviewTitle'] == label and value['data']['reviewDone'] is True
                assert 'project' in value['data']
        exports = []
        for revision in [9, 10]:
            for fmt in ['docx', 'pptx', 'pdf', 'md']:
                output = root / f'inline-save-r{revision}.{fmt}'
                cli('export', reopened, '--revision', revision, '--to', fmt, '--output', output)
                if fmt == 'md':
                    imported = root / f'markdown-r{revision}.hcd'
                    cli('import', output, '--output', imported, '--document-id', f'markdown-r{revision}')
                    text = ''.join(entry['text'] for entry in cli('extract-text', imported)['entries'])
                else:
                    text = subprocess.check_output([str(binary), 'view', str(output), 'text'], text=True)
                checks = [('迟到删除正文😀', int(revision == 10)), ('[恢复属性]', int(revision == 10)), ('@Alice 王', 4 if revision == 10 else 2), ('Edited中😀', 2 if revision == 10 else 1), ('Nested😀', 2 if revision == 10 else 1)] if args.deletions else [('保存捕获😀', 1), ('迟到输入😀', int(revision == 10)), ('@Bob 李', 1), ('@Alice 王', 4), ('Edited中😀', 2), ('Nested😀', 2)]
                for needle, count in checks:
                    assert text.count(needle) == count, (revision, fmt, needle, text)
                if args.properties:
                    assert text.count('[属性：' + ('Bob' if revision == 9 else '迟到属性') + ' · 已确认]') == 1, (revision, fmt, text)
                    assert text.count('属性协同正文😀') == 1, (revision, fmt, text)
                exports.append({'revision': revision, 'format': fmt, 'sha256': digest(output), 'bytes': output.stat().st_size})
                shutil.copy2(output, assets / output.name)
        resources = []
        def walk(value):
            if isinstance(value, dict):
                if value.get('schemaVersion') == 'hcd.extension/3':
                    resources.extend(value.get('resources', []))
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
        walk(after['blocks'])
        for resource in resources:
            output = root / (resource['hash'] + '.asset')
            if not output.exists():
                cli('get-asset', reopened, resource['hash'], '--output', output)
            assert digest(output) == resource['hash'] and output.stat().st_size == resource['byteLength']
        assert digest(archive) == archive_hash
        result = {'scope': 'Actual native authenticated HTTP and coordinator HMAC/durable Yjs state with a dropped TCP response and two Node processes; no active Hocuspocus/browser inline room, production or Office visual acceptance.',
                  'root': str(root), 'nativeBinarySha256': digest(binary), 'originalArchiveUnchanged': True,
                  'sourceFreeOfflineVersionsExact': [8, 9, 10], 'resourceBytesExact': True,
                  'resourceOccurrences': len(resources), 'uniqueResources': len({r['hash'] for r in resources}), 'exports': exports,
                  'coordinator': json.loads((root / 'resume-evidence.json').read_text()), 'propertyCandidatesAndLatePropertyRecovery': args.properties, 'inlineDeletionRestoration': args.deletions}
        for name in ['prepare-evidence.json', 'resume-evidence.json', 'references-r9.json', 'references-r10.json', 'request-r9.json', 'request-r10.json', 'postreceipt.json', 'recovered-before-save.json', 'lost-state.yjs', 'saved-state.yjs', 'inline-save-r10.hcdz']:
            shutil.copy2(root / name, assets / name)
        (assets / 'file-evidence.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'head': 10, 'exports': len(exports), 'report': str(assets / 'file-evidence.json')}), flush=True)
    finally:
        native.terminate()
        native.wait(timeout=15)
        log.close()
        proxy.shutdown()
        proxy.server_close()
        thread.join(timeout=5)
    if args.recovery_archive:
        offline = subprocess.run(['node', '--import', 'tsx', 'fixtures/semanticRecoveryArchiveFiles.ts', str(private), 'offline'], cwd=editor, capture_output=True, text=True, timeout=120)
        (root / 'offline.log').write_text(offline.stdout + offline.stderr)
        if offline.returncode:
            raise RuntimeError(offline.stdout + offline.stderr)
        for name in ['pending-collaboration.hcd-recovery', 'recovery-canonical.hcdz', 'recovery-archive-create.json', 'recovery-archive-offline.json', 'uncommitted-resource.json']:
            shutil.copy2(root / name, assets / name)
        report = json.loads((assets / 'file-evidence.json').read_text())
        report['portableRecovery'] = {'created': json.loads((root / 'recovery-archive-create.json').read_text()), 'offline': json.loads((root / 'recovery-archive-offline.json').read_text())}
        (assets / 'file-evidence.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'portableRecovery': True, 'offlineAfterNativeServerStopped': True, 'report': str(assets / 'file-evidence.json')}), flush=True)


if __name__ == '__main__':
    main()
