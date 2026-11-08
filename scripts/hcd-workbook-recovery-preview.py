#!/usr/bin/env python3
"""Owned local workbook, two editors/reader and transport fault controls.

Copies the current editor source so no existing user preview is hot-reloaded.
Tokens remain in a mode-0700 fixture and are never printed.
"""
import json
import hashlib
import argparse
import os
import runpy
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
import zipfile


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def fixture(path, many_cells=False, stored_blank=False, wide_blank=False, window_failure=False, multi_sheet=False, frozen_row=False, frozen_column=False, protected=False):
    ns = 'http://schemas.openxmlformats.org'
    parts = {
        '[Content_Types].xml': f'<Types xmlns="{ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        '_rels/.rels': f'<Relationships xmlns="{ns}/package/2006/relationships"><Relationship Id="rId1" Type="{ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': f'<workbook xmlns="{ns}/spreadsheetml/2006/main" xmlns:r="{ns}/officeDocument/2006/relationships"><sheets><sheet name="Recovery" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{ns}/package/2006/relationships"><Relationship Id="rId1" Type="{ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{ns}/spreadsheetml/2006/main"><dimension ref="A1:C300"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="1" max="2" width="32" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Original Alice</t></is></c><c r="B1" t="inlineStr"><is><t>Original Bob</t></is></c><c r="C1"><f>1+2</f><v>3</v></c></row><row r="2"><c r="A2"><v>12</v></c><c r="B2" t="inlineStr"><is><t>Numeric and formula stay intact</t></is></c></row><row r="300"><c r="A300" t="inlineStr"><is><t>Offscreen draft</t></is></c></row></sheetData></worksheet>',
    }
    if many_cells:
        rows = ''.join(f'<row r="{i}"><c r="A{i}" t="inlineStr"><is><t>Original {i}</t></is></c></row>' for i in range(1, 14))
        parts['xl/worksheets/sheet1.xml'] = f'<worksheet xmlns="{ns}/spreadsheetml/2006/main"><dimension ref="A1:A300"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="1" max="1" width="32" customWidth="1"/></cols><sheetData>{rows}</sheetData></worksheet>'
    if window_failure:
        rows = ''.join(f'<row r="{i}"><c r="A{i}" t="inlineStr"><is><t>Window row {i}</t></is></c>' + (f'<c r="Z{i}" t="inlineStr"><is><t>Far column {i}</t></is></c>' if frozen_column else '') + '</row>' for i in range(1, 601))
        parts['xl/worksheets/sheet1.xml'] = f'<worksheet xmlns="{ns}/spreadsheetml/2006/main"><dimension ref="A1:A600"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>{rows}</sheetData></worksheet>'
    if multi_sheet:
        parts['[Content_Types].xml'] = parts['[Content_Types].xml'].replace('</Types>', '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        parts['xl/workbook.xml'] = parts['xl/workbook.xml'].replace('</sheets>', '<sheet name="Second" sheetId="2" r:id="rId2"/></sheets>')
        parts['xl/_rels/workbook.xml.rels'] = parts['xl/_rels/workbook.xml.rels'].replace('</Relationships>', f'<Relationship Id="rId2" Type="{ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
        rows = ''.join(f'<row r="{i}"><c r="A{i}" t="inlineStr"><is><t>Second row {i}</t></is></c></row>' for i in range(1, 601))
        parts['xl/worksheets/sheet2.xml'] = f'<worksheet xmlns="{ns}/spreadsheetml/2006/main"><dimension ref="A1:A600"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>{rows}</sheetData></worksheet>'
    if frozen_row or frozen_column:
        pane = ('xSplit="1" ' if frozen_column else '') + ('ySplit="1" ' if frozen_row else '')
        pane += f'topLeftCell="{"B" if frozen_column else "A"}{2 if frozen_row else 1}" activePane="{"bottomRight" if frozen_row and frozen_column else "topRight" if frozen_column else "bottomLeft"}" state="frozen"'
        parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('<sheetView workbookViewId="0"/>', f'<sheetView workbookViewId="0"><pane {pane}/></sheetView>')
        if frozen_column:
            parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('ref="A1:A600"', 'ref="A1:Z600"')
    if stored_blank:
        parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('</row><row r="2">', '<c r="D1"/></row><row r="2">', 1)
    if wide_blank:
        def column(value):
            result = ''
            while value:
                value, digit = divmod(value - 1, 26)
                result = chr(65 + digit) + result
            return result
        cells = ''.join(f'<c r="{column(value)}1"/>' for value in range(4, 16385))
        parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('</row><row r="2">', cells + '</row><row r="2">', 1)
    if protected:
        parts['xl/worksheets/sheet1.xml'] = parts['xl/worksheets/sheet1.xml'].replace('</sheetData>', '</sheetData><sheetProtection sheet="1"/>')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, value in parts.items():
            archive.writestr(name, value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--many-cells', action='store_true', help='Use 13 mapped text cells for recovery pagination validation')
    parser.add_argument('--window-failure', action='store_true', help='Use 600 rows for lazy window failure testing')
    parser.add_argument('--multi-sheet', action='store_true', help='Add a second 600-row sheet to the window fixture')
    parser.add_argument('--frozen-row', action='store_true', help='Freeze the first row of the 600-row window fixture')
    parser.add_argument('--frozen-column', action='store_true', help='Freeze the first column and add distant-column cells')
    parser.add_argument('--protected', action='store_true', help='Protect the first worksheet in the synthetic workbook')
    parser.add_argument('--legacy-protected', action='store_true', help='Simulate a legacy editable map for a protected source workbook')
    parser.add_argument('--stored-blank', action='store_true', help='Add a physically stored blank D1 cell to the workbook fixture')
    parser.add_argument('--wide-blank', action='store_true', help='Create a legal wide row to test blank mapping limits')
    parser.add_argument('--pptx', action='store_true', help='Use the owned PPTX image fixture for fixed-layout recovery validation')
    parser.add_argument('--pdf', action='store_true', help='Use the owned PDF fixture for fixed-layout recovery validation')
    parser.add_argument('--pdf-rotation', type=int, choices=[0, 90, 180, 270], default=0, help='Rotate the owned PDF page for preview validation')
    parser.add_argument('--dual-origin', action='store_true', help='Use separate localhost and 127.0.0.1 browser stores against one synthetic service')
    parser.add_argument('--collaboration', action='store_true', help='Start an isolated awareness sidecar for workbook collaboration')
    args = parser.parse_args()
    if (args.protected or args.legacy_protected) and (args.pptx or args.pdf):
        parser.error('worksheet protection requires an XLSX fixture')
    if args.protected and args.legacy_protected:
        parser.error('--protected and --legacy-protected are mutually exclusive')
    if args.pdf_rotation and not args.pdf:
        parser.error('--pdf-rotation requires --pdf')
    if args.multi_sheet and not args.window_failure:
        parser.error('--multi-sheet requires --window-failure')
    if (args.frozen_row or args.frozen_column) and not args.window_failure:
        parser.error('--frozen-row and --frozen-column require --window-failure')
    if sum([args.many_cells, args.window_failure, args.pptx, args.pdf]) > 1:
        parser.error('--many-cells, --pptx and --pdf cannot be combined')
    if (args.stored_blank or args.wide_blank) and (args.many_cells or args.window_failure or args.pptx or args.pdf) or args.stored_blank and args.wide_blank:
        parser.error('--stored-blank and --wide-blank require distinct default workbook fixtures')
    repo = Path(__file__).resolve().parents[1]
    parent = repo / 'target/hcd-preview-runtime'
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='hcd-workbook-', dir=parent))
    root.chmod(0o700)
    native, proxy, vite = port(), port(), port()
    collab = port() if args.collaboration else None
    binary = repo / 'target/debug/officecli'
    env = {**os.environ, 'HCD_TOKEN_SECRET': secrets.token_hex(32)}
    if collab is not None:
        env.update(HCD_API_URL=f'http://127.0.0.1:{native}', HCD_COLLAB_PORT=str(collab), HCD_SIDECAR_STATE_DIR=str(root/'sidecar'))
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        env.pop(key, None)
    if args.pptx or args.pdf:
        runpy.run_path(str(repo / 'scripts/hcd-fixed-image-transaction.py'))['fixtures'](root)
        source = root / ('fixture.pdf' if args.pdf else 'fixture.pptx')
        if args.pdf_rotation:
            from pypdf import PdfReader, PdfWriter
            original = PdfReader(source)
            writer = PdfWriter()
            for page in original.pages:
                page.rotate(args.pdf_rotation)
                writer.add_page(page)
            rotated = root / 'rotated.pdf'
            with rotated.open('wb') as output:
                writer.write(output)
            source = rotated
    else:
        source = root / 'source.xlsx'
        fixture(source, args.many_cells, args.stored_blank, args.wide_blank, args.window_failure, args.multi_sheet, args.frozen_row, args.frozen_column, args.protected)
    subprocess.run([str(binary), 'hdoc', 'import', str(source), '--output', str(root / 'book.hcd'), '--document-id', 'book', '--chunk-blocks', '32'], env=env, check=True, capture_output=True)
    if args.legacy_protected:
        # Only the owned synthetic fixture is changed: preserve the legacy map,
        # while pointing its source identity at an equivalent protected XLSX.
        fixture(source, args.many_cells, args.stored_blank, args.wide_blank, args.window_failure, args.multi_sheet, args.frozen_row, args.frozen_column, True)
        data = source.read_bytes()
        manifest_path = root / 'book.hcd/manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['source']['sha256'] = hashlib.sha256(data).hexdigest()
        manifest['source']['sizeBytes'] = len(data)
        manifest_path.write_text(json.dumps(manifest))
    (root / 'sources').mkdir()
    shutil.copyfile(source, root / ('sources/book' + source.suffix))
    tokens = {}
    for user, scope in [('alice', 'write'), ('bob', 'write'), ('reader', 'read')]:
        result = subprocess.run([str(binary), 'hdoc', 'issue-token', '--document-id', 'book', '--scope', scope, '--user-id', user, '--display-name', user.title(), '--ttl-seconds', '3600', '--json'], env=env, capture_output=True, text=True, check=True)
        tokens[user] = json.loads(result.stdout)['data']['token']
    original = repo / 'examples/hdoc/editor'
    editor = root / 'editor'
    editor.mkdir()
    shutil.copytree(original / 'src', editor / 'src')
    shutil.copyfile(original / 'package.json', editor / 'package.json')
    shutil.copyfile(original / 'tsconfig.json', editor / 'tsconfig.json')
    (editor / 'node_modules').symlink_to(original / 'node_modules', target_is_directory=True)
    (root / 'xlsx-univer-viewer').symlink_to(repo / 'examples/hdoc/xlsx-univer-viewer', target_is_directory=True)
    config = root / 'vite.config.ts'
    config.write_text('export default ' + json.dumps({'root': str(editor), 'server': {'host': '127.0.0.1', 'port': vite, 'strictPort': True, 'fs': {'allow': [str(repo)]}, 'proxy': {'/v1': {'target': f'http://127.0.0.1:{proxy}', 'ws': True}, '/__fixture': f'http://127.0.0.1:{proxy}'}}}))
    pages = {}
    for user in tokens:
        props = {'documentId': 'book', 'token': tokens[user], 'apiUrl': f'http://127.0.0.1:{vite}/v1/documents' if args.dual_origin else '/v1/documents', 'locale': 'zh-CN'}
        if collab is not None: props['collabUrl']=f'ws://127.0.0.1:{collab}'
        html = '''<!doctype html><meta charset="utf-8"><title>文档保存恢复验收</title><style>html,body{margin:0;height:100%;font:13px system-ui}#root{height:calc(100% - 36px)}aside{height:36px;display:flex;gap:12px;align-items:center;padding:0 12px;background:#fff8eb}</style><aside>隔离测试：USER <button id="online">恢复保存连接</button><button id="offline">阻断保存与回执</button><button id="lost">提交后丢失响应</button><button id="stage">阻断图片上传</button><button id="capability">阻断兼容检查</button><button id="oversize">超限兼容响应</button><output id="status">正常连接</output></aside><div id="root"></div><script type="module">
import React from 'react';import{createRoot}from'react-dom/client';import{EmbeddedHcdEditor}from'/src/embed.tsx';
createRoot(document.getElementById('root')).render(React.createElement(EmbeddedHcdEditor,PROPS));
for(const [id,mode]of [['online','online'],['offline','offline'],['lost','lost'],['stage','stage-offline'],['capability','capability-offline'],['oversize','capability-oversize']])document.getElementById(id).onclick=async()=>{const r=await fetch('/__fixture/control?user=USER&mode='+mode,{method:'POST'});document.getElementById('status').textContent=(await r.json()).mode};
</script>'''.replace('PROPS', json.dumps(props)).replace('USER', user)
        (editor / f'{user}.html').write_text(html)
        (editor / f'{user}.html').chmod(0o600)
        pages[user] = f'http://127.0.0.1:{vite}/{user}.html'
    private = root / 'private.json'
    private.write_text(json.dumps({'root': str(root), 'ports': [native, proxy, vite], 'secret': env['HCD_TOKEN_SECRET'], 'tokens': tokens, 'pages': pages}))
    private.chmod(0o600)
    # A second synthetic document provides an already-canonical attachment for
    # the reuse verifier, independently of workbook content and its versions.
    resource_dir = root / 'resource-fixture'
    resource_dir.mkdir()
    runpy.run_path(str(repo / 'scripts/hcd-fixed-image-transaction.py'))['fixtures'](resource_dir)
    with zipfile.ZipFile(resource_dir / 'fixture.docx') as archive:
        (root / 'canonical-resource.png').write_bytes(archive.read('word/media/image.png'))
    subprocess.run([str(binary), 'hdoc', 'import', str(resource_dir / 'fixture.docx'), '--output', str(root / 'resource-reuse.hcd'), '--document-id', 'resource-reuse'], check=True, capture_output=True, env=env)
    issued = subprocess.run([str(binary), 'hdoc', 'issue-token', '--document-id', 'resource-reuse', '--scope', 'write', '--user-id', 'alice', '--ttl-seconds', '3600', '--json'], check=True, capture_output=True, text=True, env=env)
    resource_private = root / 'resource-private.json'
    resource_private.write_text(json.dumps({'apiUrl': f'http://127.0.0.1:{native}/v1/documents', 'writer': json.loads(issued.stdout)['data']['token']}))
    resource_private.chmod(0o600)
    children, logs = [], []
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        commands = [([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{native}'], 'native'), (['node', str(repo / 'scripts/hcd-workbook-recovery-proxy.mjs'), str(root)], 'proxy'), ([str(original / 'node_modules/.bin/vite'), '--config', str(config)], 'vite')]
        if collab is not None: commands.append(([str(original/'node_modules/.bin/tsx'), str(original/'sidecar.ts')], 'sidecar'))
        for command, label in commands:
            log = open(root / f'{label}.log', 'w')
            logs.append(log)
            children.append(subprocess.Popen(command, cwd=editor, env=env, stdout=log, stderr=log))
        deadline = time.monotonic() + 45
        while True:
            if any(child.poll() is not None for child in children):
                raise RuntimeError(f'Owned preview exited; inspect logs in {root}')
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{vite}/__fixture/status', timeout=1).close()
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise RuntimeError(f'Owned preview did not start: {root}')
                time.sleep(.1)
        print(json.dumps({'root': str(root), 'pages': pages, **({'alternateAlice': pages['alice'].replace('127.0.0.1', 'localhost')} if args.dual_origin else {})}), flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(.5)
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        for log in logs:
            log.close()


if __name__ == '__main__':
    main()
