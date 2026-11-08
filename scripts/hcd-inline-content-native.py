#!/usr/bin/env python3
"""Owned native/HTTP/offline verification; no browser collaboration claim."""
import base64
import copy
import hashlib
import json
import os
import secrets
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
import zlib
from pathlib import Path


def main():
    repo = Path(__file__).resolve().parents[1]
    binary = repo / 'target/debug/officecli'
    runtime = repo / 'target/hcd-preview-runtime'
    root = Path(tempfile.mkdtemp(prefix='hcd-inline-native-', dir=runtime))
    root.chmod(0o700)
    assets = repo / 'docs/assets/hcd-inline-content-native-2026-10-26'
    assets.mkdir(exist_ok=True)
    environment = {**os.environ, 'HCD_TOKEN_SECRET': secrets.token_hex(32)}
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        environment.pop(key, None)

    def cli(*args):
        return json.loads(subprocess.check_output([str(binary), 'hdoc', *map(str, args), '--json'], env=environment))['data']

    def apply(value, revision):
        path = root / f'patch-{revision}.json'
        path.write_text(json.dumps(value, ensure_ascii=False))
        return cli('apply', bundle, '--patch', path, '--expected-revision', revision)

    document = 'inline-native'
    bundle = root / (document + '.hcd')
    source = root / 'source.html'
    source.write_text('<!doctype html><meta charset="utf-8"><p>Initial正文</p>')
    cli('import', source, '--output', bundle, '--document-id', document)
    cli('project-editor', bundle, '--expected-revision', 0)
    # An owned one-pixel PNG fixture; no external assets or image services.
    def png_chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    png = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) + png_chunk(b'IDAT', zlib.compress(b'\x00\x20\x70\xdd\xff')) + png_chunk(b'IEND', b'')
    image = root / 'badge.png'
    image.write_bytes(png)
    staged = cli('put-asset', bundle, image)
    tokens = {user: cli('issue-token', '--document-id', document, '--scope', 'read' if user == 'reader' else 'write', '--user-id', user, '--display-name', user, '--ttl-seconds', 3600)['token'] for user in ['alice', 'reader', 'hcd-collaboration']}
    (root / 'people').mkdir()
    (root / 'people' / (document + '.json')).write_text(json.dumps({'schemaVersion': 'hcd-people/1', 'generation': 1, 'people': [{'id': 'alice', 'label': 'Alice 王', 'detail': 'Owned fixture', 'active': True}]}))
    with socket.socket() as port_socket:
        port_socket.bind(('127.0.0.1', 0))
        port = port_socket.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    private = root / 'private.json'
    private.write_text(json.dumps({'root': str(root), 'origin': origin, 'secret': environment['HCD_TOKEN_SECRET'], 'tokens': tokens}))
    private.chmod(0o600)
    log = open(root / 'server.log', 'ab')
    server = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{port}'], env=environment, stdout=log, stderr=log)
    records = []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    versions = {'X-HCD-Extension-Version': '3', 'X-HCD-Inline-Containers-Version': '1', 'X-HCD-Custom-Marks-Version': '1', 'X-HCD-Reference-Version': '1'}

    def request(route, body=None, headers=None, user='alice', status=200):
        extra = versions if headers is None else headers
        req = urllib.request.Request(origin + '/v1/documents/' + document + route, data=None if body is None else json.dumps(body, ensure_ascii=False).encode(), headers={'Authorization': 'Bearer ' + tokens[user], 'Content-Type': 'application/json', **extra})
        try:
            with opener.open(req, timeout=60) as response:
                code, value = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            code, value = error.code, json.load(error)
        records.append({'path': route, 'method': req.get_method(), 'status': code, 'revision': value.get('revision'), **({'error': value.get('error')} if code != 200 else {})})
        (root / 'http-evidence.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
        assert code == status, (route, code, status, value)
        return value

    def snapshot(revision, path=bundle):
        return cli('editor-state', path, '--revision', revision)

    def leaves(content):
        for inline in content['inlines']:
            if inline.get('content'):
                yield from leaves(inline['content'])
            else:
                yield inline
        for child in content.get('children', []):
            yield from leaves(child)

    def envelope(number):
        return {'schemaVersion': 'hcd.extension/3', 'instanceId': f'x_{number:032x}', 'type': 'example.inline_field', 'version': 77, 'display': 'inline', 'contentModel': 'inline', 'data': {'project': 'P-27'}, 'fallback': {'text': 'Field label'}}

    try:
        for _ in range(200):
            assert server.poll() is None
            with socket.socket() as probe:
                if probe.connect_ex(('127.0.0.1', port)) == 0:
                    break
            time.sleep(.05)
        else:
            raise RuntimeError('owned native server did not listen')
        initial = request('/editor')
        resource = {'key': 'badge', 'hash': staged['hash'], 'byteLength': len(png), 'name': 'badge.png', 'mediaType': 'image/png'}
        outer = envelope(27)
        outer['resources'] = [resource]
        outer['exports'] = {fmt: {'support': 'semantic', 'includeContent': True, 'blocks': [{'kind': 'paragraph', 'runs': [{'resource': 'badge', 'alt': '状态徽标', 'widthPt': 12, 'heightPt': 12}, {'text': '[项目] '}]}]} for fmt in ['docx', 'pptx', 'pdf', 'md', 'txt', 'html']}
        marker = {'schemaVersion': 'hcd.mark/1', 'type': 'example.review', 'version': 17, 'data': {'ticket': 'T-27'}, 'fallback': {'label': 'Review', 'style': {'backgroundColor': '#fff2a8'}}}
        container = {'text': '', 'content': {'kind': 'extension', 'extension': outer, 'inlines': [
            {'text': 'Shared中😀', 'bold': True, 'customMarks': [marker]},
            {'text': '@Alice 王', 'reference': {'type': 'hcd.mention', 'version': 1, 'mentionId': f'm_{27:032x}', 'target': {'kind': 'person', 'id': 'alice'}, 'snapshot': {'label': 'Alice 王'}}},
            {'text': '', 'content': {'kind': 'extension', 'extension': envelope(28), 'inlines': [{'text': 'Nested😀', 'italic': True}, {'text': '@Alice 王', 'reference': {'type': 'hcd.mention', 'version': 1, 'mentionId': f'm_{28:032x}', 'target': {'kind': 'person', 'id': 'alice'}, 'snapshot': {'label': 'Alice 王'}}}]}},
        ]}}
        content = {'kind': 'paragraph', 'inlines': [{'text': '字段：'}, container, {'text': ' 尾部。'}]}
        empty = {'kind': 'paragraph', 'inlines': [{'text': '空值：'}, {'text': '', 'content': {'kind': 'extension', 'extension': envelope(29), 'inlines': []}}]}
        patch = {'schemaVersion': 'hcd-patch/4', 'documentId': document, 'patchId': 'inline-install', 'baseRevision': 1, 'actor': {}, 'operations': [
            {'op': 'block.replace', 'blockId': initial['blocks'][0]['blockId'], 'block': content, 'precondition': {'blockHash': initial['blocks'][0]['blockHash']}},
            {'op': 'block.insert', 'afterBlockId': initial['blocks'][0]['blockId'], 'block': empty},
        ]}
        (assets / 'install-patch.json').write_text(json.dumps(patch, ensure_ascii=False, indent=2) + '\n')
        request('/patch', patch)
        saved = snapshot(2)
        before = (bundle / 'manifest.json').read_bytes()
        def bundle_bytes():
            return {str(path.relative_to(bundle)): hashlib.sha256(path.read_bytes()).hexdigest() for path in bundle.rglob('*') if path.is_file()}
        before_bytes = bundle_bytes()
        legacy = {key: value for key, value in versions.items() if key != 'X-HCD-Inline-Containers-Version'}
        request('/editor', headers=legacy, status=426)
        request('/editor', headers={**versions, 'X-HCD-Inline-Containers-Version': '2'}, status=426)
        request('/patch', {**patch, 'baseRevision': 2, 'patchId': 'old-inline-write'}, headers=legacy, status=426)
        request('/patch', {**patch, 'baseRevision': 2, 'patchId': 'old-envelope-write'}, headers={**versions, 'X-HCD-Extension-Version': '2'}, status=426)
        epoch = request('/auth')['collaborationEpoch']
        stripped = copy.deepcopy(saved['blocks'])
        for block in stripped:
            block['content']['inlines'] = [inline for inline in block['content']['inlines'] if not inline.get('content')]
        old_snapshot = {'coordinatorVersion': 4, 'coordinatorId': 'a' * 32, 'checkpointId': 'b' * 32, 'coordinatorDigest': 'c' * 64, 'expectedRevision': 2, 'blocks': [{'blockId': block['blockId'], 'content': block['content']} for block in stripped], 'images': [], 'extensionVersion': 1, 'typographyVersion': 2}
        rejected = request('/checkpoints', old_snapshot, headers={**legacy, 'X-HCD-Collaboration-Epoch': str(epoch), 'X-HCD-Node-Edits-Version': '7'}, user='hcd-collaboration', status=426)
        assert 'editable-inline-container-aware' in rejected['error']
        assert (bundle / 'manifest.json').read_bytes() == before
        assert bundle_bytes() == before_bytes
        refs = request('/references?locations=true')
        assert refs['items'][0]['inlinePath'] == [1] and refs['items'][0]['inlineIndex'] == 1
        assert refs['reminders']['enabled'] is False
        body = saved['blocks'][0]['content']['inlines'][1]['content']
        source_id = body['inlines'][0]['nodeId']
        apply({'schemaVersion': 'hcd-patch/1', 'documentId': document, 'patchId': 'inline-text', 'baseRevision': 2, 'operations': [{'op': 'text.splice', 'nodeId': source_id, 'start': 0, 'deleteCount': 6, 'insertText': 'Edited', 'precondition': {'nodeHash': hashlib.sha256('Shared中😀'.encode()).hexdigest()}}]}, 2)
        current = request('/editor')
        updated = copy.deepcopy(current['blocks'][0]['content'])
        updated['inlines'][1]['content']['extension']['data']['project'] = 'P-28'
        change = {'schemaVersion': 'hcd-patch/4', 'documentId': document, 'patchId': 'inline-properties', 'baseRevision': 3, 'actor': {}, 'operations': [{'op': 'block.replace', 'blockId': current['blocks'][0]['blockId'], 'block': updated, 'precondition': {'blockHash': current['blocks'][0]['blockHash']}}]}
        request('/patch', change, user='reader', status=403)
        request('/patch', change)
        request('/patch', {**change, 'patchId': 'stale-inline-properties'}, status=409)
        assert not request('/references')['transition']['events']
        current = request('/editor')
        duplicate = copy.deepcopy(current['blocks'][0]['content'])
        def renew(value):
            if isinstance(value, dict):
                value.pop('nodeId', None)
                if 'instanceId' in value:
                    value['instanceId'] = f"x_{int(value['instanceId'][2:],16)+100:032x}"
                if 'mentionId' in value:
                    value['mentionId'] = f"m_{int(value['mentionId'][2:],16)+100:032x}"
                for item in value.values():
                    renew(item)
            elif isinstance(value, list):
                for item in value:
                    renew(item)
        renew(duplicate)
        request('/patch', {'schemaVersion': 'hcd-patch/4', 'documentId': document, 'patchId': 'inline-copy', 'baseRevision': 4, 'actor': {}, 'operations': [{'op': 'block.insert', 'afterBlockId': current['blocks'][-1]['blockId'], 'block': duplicate}]})
        current = request('/editor')
        blank = current['blocks'][1]['content']['inlines'][1]['content']['inlines'][0]
        assert blank['text'] == ''
        apply({'schemaVersion': 'hcd-patch/1', 'documentId': document, 'patchId': 'inline-empty-fill', 'baseRevision': 5, 'operations': [{'op': 'text.splice', 'nodeId': blank['nodeId'], 'start': 0, 'deleteCount': 0, 'insertText': '新内容', 'precondition': {'nodeHash': hashlib.sha256(b'').hexdigest()}}]}, 5)
        cli('restore', bundle, '--revision', 2, '--expected-revision', 6)
        cli('restore', bundle, '--revision', 6, '--expected-revision', 7)
        versions_saved = {revision: snapshot(revision) for revision in range(1, 9)}
        assert versions_saved[2]['blocks'] == versions_saved[7]['blocks']
        assert versions_saved[6]['blocks'] == versions_saved[8]['blocks']
        for value in list(versions_saved.values())[1:]:
            first = value['blocks'][0]['content']['inlines'][1]['content']['inlines'][0]
            assert first['nodeId'] == source_id and first['customMarks'] == [marker] and first['bold']
            ids = [inline['nodeId'] for block in value['blocks'] for inline in leaves(block['content'])]
            assert len(ids) == len(set(ids))
        archive = root / 'inline-native-r8.hcdz'
        cli('pack', bundle, '--output', archive)
        offline = root / 'source-free/inline-native.hcd'
        offline.parent.mkdir()
        cli('unpack', archive, '--output', offline)
        assert not (offline.parent / 'sources').exists() and cli('validate', offline)['valid']
        for revision, value in versions_saved.items():
            assert snapshot(revision, offline) == value
        recovered = root / 'recovered.png'
        cli('get-asset', offline, staged['hash'], '--output', recovered)
        assert recovered.read_bytes() == png
        shutil.copyfile(archive, assets / archive.name)
        files = []
        for fmt in ['docx', 'pptx', 'pdf', 'md']:
            output = root / f'offline-r8.{fmt}'
            cli('export', offline, '--to', fmt, '--output', output)
            if fmt == 'md':
                parsed = root / 'markdown-readback.hcd'
                cli('import', output, '--output', parsed, '--document-id', 'markdown-readback')
                text = ''.join(entry['text'] for entry in cli('extract-text', parsed)['entries'])
            else:
                text = subprocess.check_output([str(binary), 'view', str(output), 'text'], text=True)
            for needle, count in [('Edited中😀', 2), ('Nested😀', 2), ('@Alice 王', 4), ('新内容', 1)]:
                assert text.count(needle) == count, (fmt, needle, text)
            assert 'Field label' not in text and 'P-28' not in text
            assert text.count('[项目]') == 2
            if fmt in ['docx', 'pptx']:
                with zipfile.ZipFile(output) as package:
                    assert not any(value in package.read(name) for name in package.namelist() for value in [b'P-28', b'T-27', b'example.inline_field'])
            shutil.copyfile(output, assets / output.name)
            files.append({'file': output.name, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()})
        cli('render-html', offline, '--output', assets / 'inspection-r8.html')
        capabilities = request('/export-capabilities?revision=8')
        inline_feature = next(feature for feature in capabilities['features'] if feature['kind'] == 'extension_inline')
        assert inline_feature['formats']['md']['support'] == 'static'
        assert inline_feature['formats']['pptx']['support'] == 'static'
        (assets / 'export-capabilities.json').write_text(json.dumps(capabilities, ensure_ascii=False, indent=2) + '\n')
        final_refs = request('/references?locations=true')
        assert len(final_refs['items']) == 4 and sorted(item['inlinePath'] for item in final_refs['items']) == [[1], [1], [1, 2], [1, 2]]
        (assets / 'references-r8.json').write_text(json.dumps(final_refs, ensure_ascii=False, indent=2) + '\n')
        (assets / 'projection-r8.json').write_text(json.dumps(versions_saved[8], ensure_ascii=False, indent=2) + '\n')
        (assets / 'http-evidence.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
        (assets / 'file-evidence.json').write_text(json.dumps({'scope': 'Native common model/direct authenticated HTTP/CLI/offline exports. Editable browser/CRDT inline carriers remain pending; no collaborative UI acceptance.', 'head': 8, 'canonicalEqualities': [[2, 7], [6, 8]], 'sourceFreeVersionsExact': list(versions_saved), 'stableOriginalSourcesAndIndependentCopySources': True, 'unknownBusinessVersion': 77, 'nestedInlineAndEmptyBodySupported': True, 'resourceBytesExact': True, 'nestedMentionsLocatedAndNoRemindersSent': True, 'legacyReadWriteAndStrippedSnapshotRejectedWithoutMutation': True, 'nativeBytesUnchangedByFences': True, 'readOnlyAndStaleWriteRejected': True, 'knownExportBoundaries': ['Markdown and PPTX base rich-run formatting is currently flattened; the feature report declares these targets static', 'Inline image adapter output may split paragraphs in DOCX/PPTX'], 'files': files}, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'root': str(root), 'head': 8, 'nativeBinarySha256': hashlib.sha256(binary.read_bytes()).hexdigest()}), flush=True)
        print('PASS native nested/empty inline bodies, source retention, resources, mentions, legacy-model fences, read-only/stale writes, exact restore/offline history and DOCX/PPTX/PDF/MD readback', flush=True)
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        log.close()


if __name__ == '__main__':
    main()
