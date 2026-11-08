#!/usr/bin/env python3
"""Native Word HTML artifacts from owned archives, with no editor/server dependency.

Only creates new synthetic bundles. Browser acceptance is performed separately.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


def port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--preview', action='store_true')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    binary = repo / 'target/debug/officecli'
    root = Path(tempfile.mkdtemp(prefix='hcd-word-html-', dir=repo / 'target/hcd-preview-runtime'))
    site = root / 'site'
    site.mkdir()
    evidence = repo / 'docs/assets/hcd-word-html-export-2026-10-27'
    evidence.mkdir(exist_ok=True)
    env = {**os.environ, 'NO_COLOR': '1', 'HCD_TOKEN_SECRET': os.urandom(32).hex()}
    for name in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        env.pop(name, None)

    def cli(*values, ok=True):
        result = subprocess.run([str(binary), 'hdoc', *map(str, values), '--json'], cwd=root,
                                env=env, capture_output=True, text=True, timeout=120)
        value = json.loads(result.stdout)
        if ok:
            assert result.returncode == 0 and value['success'], (values[0], value, result.stderr)
        return value.get('data', value)

    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def hashes(bundle):
        return {str(path.relative_to(bundle)): digest(path) for path in bundle.rglob('*')
                if path.is_file() and path.name != '.hcd-write-lock'}

    Page = runpy.run_path(str(repo / 'scripts/hcd-html-export-verify.py'))['Page']

    def extensions(state):
        found = []
        def walk(value):
            if isinstance(value, dict):
                if isinstance(value.get('extension'), dict):
                    found.append(value['extension'])
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
        walk(state['blocks'])
        return found

    exports = []
    before = {}
    states = {}
    bundles = {}
    for document, archive, revisions in [
        ('rich', 'hcd-word-node-resource-recovery-2026-10-27/browser-node-resource-r7.hcdz', range(1, 8)),
        ('nodes', 'hcd-word-nodes-regional-2026-10-27/browser-nodes-r10.hcdz', [10]),
    ]:
        bundle = root / ('node-catalog/rich.hcd' if document == 'nodes' else document + '.hcd')
        bundle.parent.mkdir(exist_ok=True)
        bundles[document] = bundle
        cli('unpack', repo / 'docs/assets' / archive, '--output', bundle)
        before[document] = hashes(bundle)
        states[document] = {}
        for revision in revisions:
            state = cli('editor-state', bundle, '--revision', revision)
            states[document][revision] = state
            output = site / f'{document}-r{revision}.html'
            report = cli('export', bundle, '--revision', revision, '--to', 'html', '--output', output,
                         '--fidelity-report', root / f'{document}-r{revision}-fidelity.json')
            html = output.read_text()
            plan = json.loads(re.search(r'id="hcd-word-export-plan">(.*?)</script>', html, re.S)[1])
            assert plan['layout'] == state['flowLayout']
            page = Page()
            page.feed(html)
            assert page.nodes == extensions(state), (document, revision, 'node payload changed')
            assert page.images and all(uri.startswith('data:image/') for uri in page.images)
            resource_hashes = {hashlib.sha256(base64.b64decode(uri.split(',', 1)[1])).hexdigest()
                               for uri in re.findall(r'(?:src|href)="(data:[^"]+)"', html)}
            required_resources = {resource['hash'] for node in page.nodes for resource in node.get('resources', [])}
            assert required_resources <= resource_hashes
            assert 'HCD_WORD_HTML_BROWSER_PAGINATION' in [warning['code'] for warning in report['warnings']]
            exports.append({'document': document, 'revision': revision, 'file': output.name,
                            'sha256': digest(output), 'bytes': output.stat().st_size,
                            'layoutExactlyPreserved': True, 'nodePayloadsExactlyPreserved': True,
                            'imagesEmbedded': len(page.images), 'resourceHashes': sorted(required_resources)})

    # Two source sections: first/even/default and inherited story bindings,
    # explicit number restart, portrait/landscape, missing first/even stories.
    w = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    source = root / 'pagination-source.docx'
    template = repo / 'docs/assets/hcd-flow-regions-2026-10-26/image-source.docx'
    with zipfile.ZipFile(template) as original, zipfile.ZipFile(source, 'w') as out:
        for name in original.namelist():
            data = original.read(name)
            if name == 'word/document.xml':
                document = ET.fromstring(data)
                body = document.find(w + 'body')
                boundary = next(child for child in body if child.find(w + 'pPr/' + w + 'sectPr') is not None)
                end = body.find(w + 'sectPr')
                for section, anchor in [(1, boundary), (2, end)]:
                    for index in range(1, 66):
                        paragraph = ET.Element(w + 'p')
                        run = ET.SubElement(paragraph, w + 'r')
                        ET.SubElement(run, w + 't').text = f'S{section}-P{index:03} — ' + 'Browser section export keeps this unique paragraph and story binding. ' * 3
                        body.insert(list(body).index(anchor), paragraph)
                    if section == 1:
                        paragraph = ET.Element(w + 'p')
                        run = ET.SubElement(paragraph, w + 'r')
                        ET.SubElement(run, w + 't').text = 'S1-OVERSIZED — ' + 'An oversized block must remain readable without cropping. ' * 400
                        body.insert(list(body).index(anchor), paragraph)
                data = ET.tostring(document, encoding='utf-8', xml_declaration=True)
            out.writestr(name, data)
    bundle = root / 'pagination.hcd'
    bundles['pagination'] = bundle
    cli('import', source, '--word-regions', '--document-id', 'pagination', '--output', bundle)
    cli('project-editor', bundle, '--word-regions', '--expected-revision', 0)
    state = cli('editor-state', bundle)
    assert len(state['flowLayout']['sections']) == 2
    before['pagination'] = hashes(bundle)
    states['pagination'] = {1: state}
    output = site / 'pagination.html'
    cli('export', bundle, '--revision', 1, '--to', 'html', '--output', output,
        '--fidelity-report', root / 'pagination-fidelity.json')
    plan = json.loads(re.search(r'id="hcd-word-export-plan">(.*?)</script>', output.read_text(), re.S)[1])
    assert plan['layout'] == state['flowLayout']
    assert plan['sections'][0]['header']['even'] is None
    assert plan['sections'][0]['footer']['firstOdd'] is None
    assert plan['sections'][1]['header']['firstEven'] == plan['sections'][0]['header']['firstOdd']
    assert plan['sections'][1]['numberStart'] == 4
    # The derived fault fixture fails after moving real nodes into pages; its
    # browser acceptance must demonstrate restoration of the original order.
    html = output.read_text()
    assert html.count('if(++total>20000)') == 1
    (site / 'pagination-failure.html').write_text(html.replace('if(++total>20000)', 'if(++total>2)'))
    source.unlink()  # Materialized HTML no longer needs the source DOCX.
    exports.append({'document': 'pagination', 'revision': 1, 'file': output.name,
                    'sha256': digest(output), 'bytes': output.stat().st_size,
                    'layoutExactlyPreserved': True, 'uniqueBodyParagraphs': 130})

    legacy = root / 'legacy.hcd'
    cli('unpack', repo / 'docs/assets/hcd-flow-layout-2026-10-26/layout-r1.hcdz', '--output', legacy)
    sentinel = site / 'legacy.html'
    sentinel.write_text('existing user output')
    rejected = cli('export', legacy, '--to', 'html', '--output', sentinel, ok=False)
    assert not rejected.get('success', True) and sentinel.read_text() == 'existing user output'
    sentinel.unlink()

    native_port = port()
    log = open(root / 'native.log', 'wb')
    native = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{native_port}'],
                              env=env, cwd=root, stdout=log, stderr=subprocess.STDOUT)
    nodes_port = port()
    nodes_log = open(root / 'native-nodes.log', 'wb')
    nodes_native = subprocess.Popen([str(binary), 'hdoc', 'serve', '--root', str(root / 'node-catalog'), '--bind', f'127.0.0.1:{nodes_port}'],
                                    env=env, cwd=root, stdout=nodes_log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 30
        while True:
            assert native.poll() is None, 'native server exited'
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{native_port}/health', timeout=1).close()
                break
            except OSError:
                assert time.monotonic() < deadline
                time.sleep(.1)
        def get(document, route, authorized=True):
            api_port = nodes_port if document == 'nodes' else native_port
            document = 'rich' if document == 'nodes' else document
            token = cli('issue-token', '--document-id', document, '--scope', 'read', '--user-id', 'html-reader', '--ttl-seconds', 600)['token']
            headers = {'X-HCD-Flow-Layout-Version': '2', 'X-HCD-Node-Edits-Version': '7',
                       'X-HCD-Extension-Version': '2', 'X-HCD-Custom-Marks-Version': '1'}
            if authorized:
                headers['Authorization'] = 'Bearer ' + token
            request = urllib.request.Request(f'http://127.0.0.1:{api_port}/v1/documents/{document}' + route,
                                             headers=headers)
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        for exported in exports:
            actual = get(exported['document'], f'/export/html?revision={exported["revision"]}')
            assert actual == (site / exported['file']).read_bytes()
        options = json.loads(get('rich', '/export-options?revision=7'))
        assert 'html' in options['semanticFormats']
        try:
            get('rich', '/export/html?revision=7', False)
            raise AssertionError('anonymous export accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 401
    finally:
        native.terminate()
        nodes_native.terminate()
        native.wait(timeout=20)
        nodes_native.wait(timeout=20)
        log.close()
        nodes_log.close()
    assert native.poll() is not None and nodes_native.poll() is not None
    for document, revisions in states.items():
        bundle = bundles[document]
        assert hashes(bundle) == before[document]
        for revision, state in revisions.items():
            assert cli('editor-state', bundle, '--revision', revision) == state
    for name in ['rich-r7.html', 'nodes-r10.html', 'pagination.html']:
        shutil.copy2(site / name, evidence / name)
    shutil.copy2(root / 'pagination-fidelity.json', evidence / 'pagination-fidelity.json')
    result = {'scope': 'Actual local CLI/HTTP and source-free native archives; browser acceptance recorded separately. No exact Microsoft Word pagination or production claim.',
              'root': str(root), 'nativeBinarySha256': digest(binary), 'exports': exports,
              'cliHttpIdentical': True, 'anonymousDenied': True, 'legacyLayoutRejectedAtomically': True,
              'canonicalFilesAndVersionsUnchanged': True, 'nativeServerStoppedBeforeBrowserReview': True}
    (evidence / 'file-evidence.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    if not args.preview:
        print(json.dumps(result, ensure_ascii=False))
        return
    preview_port = port()
    log = open(root / 'static.log', 'wb')
    static = subprocess.Popen(['python3', '-m', 'http.server', str(preview_port), '--bind', '127.0.0.1', '--directory', str(site)],
                              cwd=root, stdout=log, stderr=subprocess.STDOUT)
    print(json.dumps({'root': str(root), 'pagination': f'http://127.0.0.1:{preview_port}/pagination.html',
                      'paginationFailure': f'http://127.0.0.1:{preview_port}/pagination-failure.html',
                      'rich': f'http://127.0.0.1:{preview_port}/rich-r7.html',
                      'nodes': f'http://127.0.0.1:{preview_port}/nodes-r10.html'}), flush=True)
    try:
        while static.poll() is None:
            time.sleep(.5)
    finally:
        static.terminate()
        static.wait(timeout=10)
        log.close()


if __name__ == '__main__':
    main()
