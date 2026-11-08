#!/usr/bin/env python3
"""Exercise PPTX geometry source preflight and export using an isolated HTTP server."""
import io
import json
import os
from pathlib import Path
import runpy
import secrets
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[1]
BIN = REPO / 'target/debug/officecli'
SOURCE = REPO / 'examples/ppt/pictures/pictures-basic.pptx'
root = Path(tempfile.mkdtemp(prefix='hcd-pptx-source-http-'))
doc = 'picture-http'
secret = secrets.token_hex(32)
env = {**os.environ, 'HCD_TOKEN_SECRET': secret}
for key in ('HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT'):
    env.pop(key, None)

def command(*args):
    result = subprocess.run([str(BIN), 'hdoc', *map(str, args), '--json'], env=env,
                            capture_output=True, text=True, timeout=180, check=True)
    return json.loads(result.stdout)['data']

command('import', SOURCE, '--output', root / f'{doc}.hcd', '--document-id', doc)
(root / 'sources').mkdir()
(root / 'sources' / f'{doc}.pptx').write_bytes(SOURCE.read_bytes())
token = command('issue-token', '--document-id', doc, '--scope', 'write', '--user-id', 'tester', '--ttl-seconds', 3600)['token']
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
log = open(root / 'api.log', 'wb')
server = subprocess.Popen([str(BIN), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{port}'], env=env, stdout=log, stderr=log)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
children = []
pages = []
signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))

def request(route, body=None, raw=False):
    payload = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/documents/{doc}{route}', data=payload,
                                 headers={'Authorization': 'Bearer ' + token,
                                          'Content-Type': 'application/octet-stream' if isinstance(body, bytes) else 'application/json'})
    with opener.open(req, timeout=120) as response:
        data = response.read()
    return data if raw else json.loads(data)

try:
    for _ in range(200):
        try:
            request('/auth')
            break
        except urllib.error.URLError:
            if server.poll() is not None:
                raise RuntimeError('fixture server exited')
            time.sleep(.1)
    image = request('/images')['entries'][0]
    geometry = {**image['geometry'], 'width': image['geometry']['width'] + 127000}
    patch = {'schemaVersion': 'hcd-patch/3', 'documentId': doc, 'patchId': 'geometry', 'baseRevision': 0,
             'operations': [{'op': 'image.geometry', 'nodeId': image['nodeId'], 'geometry': geometry,
                             'precondition': {'visualHash': image['visualHash']}}]}
    saved = request('/edits', patch)
    assert saved['revision'] == 1
    options = request('/export-options?revision=1')
    assert options['sourceAvailable'] and options['sourceEditsSupported'], options
    if os.environ.get('HCD_PPTX_SOURCE_HOLD_BROWSER') == '1':
        editor = REPO / 'examples/hdoc/editor'
        ports = []
        for _ in range(2):
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                ports.append(probe.getsockname()[1])
        suffix = secrets.token_hex(8)
        page = editor / f'.hcd-picture-geometry-{suffix}.html'
        props = {'documentId': doc, 'token': token, 'apiUrl': '/v1/documents',
                 'collabUrl': f'ws://127.0.0.1:{ports[0]}', 'locale': 'zh-CN'}
        page.write_text('<meta charset="utf-8"><style>html,body,#root{margin:0;height:100%}</style><div id="root"></div><script type="module">import React from"react";import{createRoot}from"react-dom/client";import{EmbeddedHcdEditor}from"/src/embed.tsx";createRoot(document.getElementById("root")).render(React.createElement(EmbeddedHcdEditor,' + json.dumps(props) + '));</script>')
        page.chmod(0o600)
        pages.append(page)
        vite = root / 'vite.mjs'
        vite.write_text('import{createServer}from' + json.dumps(str(editor / 'node_modules/vite/dist/node/index.js')) + ';const s=await createServer({root:' + json.dumps(str(editor)) + ',configFile:false,server:{host:"127.0.0.1",port:' + str(ports[1]) + ',strictPort:true,proxy:{"/v1":{target:"http://127.0.0.1:' + str(port) + '",ws:true}}}});await s.listen();')
        sidecar_env = {**env, 'HCD_API_URL': f'http://127.0.0.1:{port}', 'HCD_COLLAB_PORT': str(ports[0]), 'HCD_SIDECAR_STATE_DIR': str(root / 'sidecar')}
        children.append(subprocess.Popen(['node', '--import', 'tsx', 'sidecar.ts'], cwd=editor, env=sidecar_env, stdout=log, stderr=log))
        children.append(subprocess.Popen(['node', str(vite)], cwd=editor, env=env, stdout=log, stderr=log))
        for check_port in ports:
            for _ in range(200):
                with socket.socket() as probe:
                    if probe.connect_ex(('127.0.0.1', check_port)) == 0:
                        break
                if any(child.poll() is not None for child in children):
                    raise RuntimeError('browser fixture exited; inspect api.log')
                time.sleep(.1)
            else:
                raise RuntimeError('browser fixture port unavailable')
        print(json.dumps({'browser': f'http://127.0.0.1:{ports[1]}/{page.name}', 'workDir': str(root)}), flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(1)
        raise RuntimeError('browser fixture exited unexpectedly')
    output = request('/export/pptx?revision=1&source=true', raw=True)
    (root / 'exported.pptx').write_bytes(output)
    with zipfile.ZipFile(SOURCE) as original, zipfile.ZipFile(io.BytesIO(output)) as exported:
        changed = [name for name in original.namelist() if not name.endswith('/') and original.read(name) != exported.read(name)]
        assert len(changed) == 1 and changed[0].startswith('ppt/slides/'), changed
        slide = ET.fromstring(exported.read(changed[0]))
        p = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
        a = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
        widths = [int(item.attrib['cx']) for item in slide.findall(f'.//{p}pic/{p}spPr/{a}xfrm/{a}ext')]
        assert int(geometry['width']) in widths, widths
    replacement = runpy.run_path(str(REPO / 'scripts/hcd-fixed-image-transaction.py'))['png']([255, 0, 0])
    new_image = request('/staged-assets?extension=png', replacement)
    next_patch = {'schemaVersion': 'hcd-patch/3', 'documentId': doc, 'patchId': 'replacement', 'baseRevision': 1,
                  'operations': [{'op': 'image.replace', 'nodeId': image['nodeId'], 'assetHash': new_image['hash'],
                                  'precondition': {'visualHash': saved['images'][0]['visualHash']}}]}
    assert request('/edits', next_patch)['revision'] == 2
    options = request('/export-options?revision=2')
    assert options['sourceEditsSupported'], options
    assert request('/export-options?revision=1')['sourceEditsSupported']
    replaced = request('/export/pptx?revision=2&source=true', raw=True)
    (root / 'replaced.pptx').write_bytes(replaced)
    with zipfile.ZipFile(SOURCE) as original, zipfile.ZipFile(io.BytesIO(replaced)) as result:
        media = [name for name in result.namelist() if name.startswith('ppt/media/hcd-')]
        assert len(media) == 1 and result.read(media[0]) == replacement
        for name in original.namelist():
            if name.startswith('ppt/media/') and not name.endswith('/'):
                assert result.read(name) == original.read(name)
        assert media[0].encode() in result.read('[Content_Types].xml')
        assert media[0].encode() in result.read('ppt/slides/_rels/slide1.xml.rels')
    print(json.dumps({'workDir': str(root), 'revision': saved['revision'], 'sourcePreflight': True,
                      'changedSlide': changed[0], 'widthEmu': int(geometry['width']),
                      'replacementExported': True, 'originalMediaPreserved': True, 'historicalPreflightAllowed': True}))
except KeyboardInterrupt:
    pass
finally:
    for child in children:
        child.terminate()
    for child in children:
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    for page in pages:
        page.unlink(missing_ok=True)
    server.terminate()
    server.wait(timeout=20)
    log.close()
