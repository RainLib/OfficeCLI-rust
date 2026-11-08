#!/usr/bin/env python3
"""Verify saved-revision conversion declarations against real fixture files.

Run after hcd-mention-preview.py --extension-nodes --node-conflicts --node-sdk.
Only the explicitly supplied disposable preview bundle can be seeded.
"""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--seed-reference', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    assert root.name.startswith('hcd-mention-preview-')
    private = json.loads((root / 'private.json').read_text())
    assert Path(private['root']).resolve() == root
    assert private['origin'].startswith('http://127.0.0.1:')
    repo = Path(__file__).resolve().parents[1]
    binary = repo / 'target/debug/officecli'
    bundle = root / 'mentions-docx.hcd'
    base = private['origin'] + '/v1/documents/mentions-docx'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(path, actor='reader', body=None, expected=200):
        headers = {'Content-Type': 'application/json', 'X-HCD-Reference-Version': '1',
                   'X-HCD-Extension-Version': '2', 'X-HCD-Node-Edits-Version': '4'}
        if actor:
            headers['Authorization'] = 'Bearer ' + private[actor]
        req = urllib.request.Request(base + path, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
        try:
            with opener.open(req, timeout=120) as response:
                status, raw, reply_headers = response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            status, raw, reply_headers = error.code, error.read(), error.headers
        assert status == expected, (path, status, raw[:300])
        return (json.loads(raw) if raw[:1] in [b'{', b'['] else raw), reply_headers

    def projection():
        return request('/editor')[0]

    def envelopes(value):
        extensions, references = [], []
        for block in value['blocks']:
            content = block['content']
            if content.get('extension'):
                extensions.append(content['extension'])
            for inline in content['inlines']:
                if inline.get('extension'):
                    extensions.append(inline['extension'])
                if inline.get('reference'):
                    references.append(inline['reference'])
        return sorted(extensions, key=lambda item: item['instanceId']), sorted(references, key=lambda item: item['mentionId'])

    if args.seed_reference:
        current = projection()
        if not envelopes(current)[1]:
            reference = {'type': 'hcd.mention', 'version': 1, 'mentionId': 'm_' + 'c' * 32,
                         'target': {'kind': 'person', 'id': 'person:产品/甲'}, 'snapshot': {'label': '张三'}}
            request('/patch', 'alice', {'schemaVersion': 'hcd-patch/4', 'documentId': 'mentions-docx',
                    'patchId': 'export-capability-reference-fixture', 'baseRevision': current['revision'], 'actor': {},
                    'operations': [{'op': 'block.insert', 'afterBlockId': current['blocks'][0]['blockId'],
                                    'block': {'kind': 'paragraph', 'inlines': [{'text': '@张三', 'reference': reference}]}}]})

    current = projection()
    extensions, references = envelopes(current)
    assert len(extensions) == 4 and len(references) == 1, 'use the documented four-extension fixture'
    revision = current['revision']
    manifest = (bundle / 'manifest.json').read_bytes()
    report, headers = request(f'/export-capabilities?revision={revision}')
    assert report['revision'] == revision and report['scope'] == 'business-nodes'
    assert headers['Cache-Control'] == 'private, no-store'
    assert {item['kind']: item['count'] for item in report['features']} == {'extension_inline': 2, 'extension_block': 2, 'reference': 1}
    assert all(len(item['examples']) <= 3 for item in report['features'])
    for item in report['features']:
        assert item['nativeBundle'] == {'support': 'native', 'dataRetention': 'native'}
        assert item['source']['support'] == 'unsupported'
        assert item['formats']['html'] == {'support': 'static', 'dataRetention': 'embedded'}
        assert all(item['formats'][fmt] == {'support': 'static', 'dataRetention': 'omitted'} for fmt in ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'txt'])
    assert 'unavailableCodec' not in json.dumps(report) and 'person:产品/甲' not in json.dumps(report, ensure_ascii=False)
    request('/export-capabilities', actor=None, expected=401)
    assert request('/export-capabilities?revision=1')[0]['features'] == []
    request(f'/export-capabilities?revision={revision + 1}', expected=409)

    output = Path(tempfile.mkdtemp(prefix='hcd-export-capability-files-'))
    evidence = {'scope': 'Isolated local native HTTP, read-only export and actual file readback. Business-node declarations only; no full-layout, Office-device or production acceptance.',
                'revision': revision, 'report': report, 'files': [], 'output': str(output)}
    labels = [item['fallback']['text'] for item in extensions] + ['@' + references[0]['snapshot']['label']]
    for fmt in ['docx', 'pdf', 'md', 'txt', 'html']:
        raw, export_headers = request(f'/export/{fmt}?revision={revision}')
        assert isinstance(raw, bytes)
        path = output / f'exported-r{revision}.{fmt}'
        path.write_bytes(raw)
        if fmt == 'html':
            class Metadata(HTMLParser):
                def __init__(self):
                    super().__init__()
                    self.extensions, self.references = [], []
                    self.text = []

                def handle_data(self, text):
                    self.text.append(text)

                def handle_starttag(self, tag, attrs):
                    attrs = dict(attrs)
                    if 'data-hcd-extension' in attrs:
                        self.extensions.append(json.loads(attrs['data-hcd-extension']))
                    if 'data-hcd-reference' in attrs:
                        self.references.append(json.loads(attrs['data-hcd-reference']))

            metadata = Metadata()
            metadata.feed(raw.decode())
            assert sorted(metadata.extensions, key=lambda item: item['instanceId']) == extensions
            assert sorted(metadata.references, key=lambda item: item['mentionId']) == references
            assert all(''.join(metadata.text).count(label) == 1 for label in labels)
        else:
            text = path.read_text() if fmt in ['md', 'txt'] else subprocess.check_output([str(binary), 'view', str(path), 'text'], text=True)
            assert all(text.count(label) == 1 for label in labels), (fmt, text)
            assert 'unavailableCodec' not in text
            if fmt == 'docx':
                with zipfile.ZipFile(path) as package:
                    assert all(b'unavailableCodec' not in package.read(name) for name in package.namelist())
        evidence['files'].append({'format': fmt, 'sha256': hashlib.sha256(raw).hexdigest(), 'fidelity': export_headers.get('x-hcd-fidelity-level'), 'readableFallbacksPreserved': True, 'businessData': 'embedded' if fmt == 'html' else 'omitted'})
    offline = output / 'offline.hcd'
    shutil.copytree(bundle, offline)
    offline_projection = json.loads(subprocess.check_output([str(binary), 'hdoc', 'editor-state', str(offline), '--json'], text=True))['data']
    assert envelopes(offline_projection) == (extensions, references)
    assert (bundle / 'manifest.json').read_bytes() == manifest
    evidence['checks'] = {'historicalRevisionPinned': True, 'unauthenticatedRejected': True, 'futureRevisionRejected': True,
                          'nativePayloadsRetainedOffline': True, 'htmlEmbeddedPayloadsRetained': True, 'manifestUnchanged': True,
                          'reportOmitsPrivateBusinessData': True}
    target = repo / 'docs/assets/hcd-extensions-2026-10-24/export-capabilities-file-evidence.json'
    target.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'result': 'PASS', 'revision': revision, 'output': str(output), 'files': len(evidence['files'])}))


if __name__ == '__main__':
    main()
