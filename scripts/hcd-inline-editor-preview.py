#!/usr/bin/env python3
"""Owned production embedded-editor preview for inline1. No user room writes."""
import argparse
import json
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', type=Path, default=repo / 'docs/assets/hcd-inline-content-native-2026-10-26/inline-native-r8.hcdz', help='Owned inline-native test archive to clone; the source is never edited')
    parser.add_argument('--collaboration-from', type=Path, help='Copy collaboration state from an owned, stopped inline-editor fixture')
    parser.add_argument('--enable-native-field', action='store_true', help='Register the synthetic native fixture field for attachment recovery verification')
    args = parser.parse_args()
    archive = args.bundle.resolve()
    assert archive.is_file(), archive
    root = Path(tempfile.mkdtemp(prefix='hcd-inline-editor-', dir=repo / 'target/hcd-preview-runtime'))
    editor = root / 'editor'
    shutil.copytree(repo / 'examples/hdoc/editor', editor, ignore=shutil.ignore_patterns('node_modules', 'dist', 'dist-embed', '.hcd-*'))
    (editor / 'node_modules').symlink_to(repo / 'examples/hdoc/editor/node_modules', target_is_directory=True)
    env = {**os.environ, 'NO_COLOR': '1', 'HCD_TOKEN_SECRET': secrets.token_hex(32), 'HCD_INLINE_ROOMS': '1'}
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        env.pop(key, None)
    binary = repo / 'target/debug/officecli'

    def cli(*args):
        result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], cwd=root, env=env, check=True, capture_output=True, text=True)
        return json.loads(result.stdout)['data']

    cli('unpack', archive, '--output', root / 'inline-native.hcd')
    if args.collaboration_from:
        source = args.collaboration_from.resolve()
        preview_root = (repo / 'target/hcd-preview-runtime').resolve()
        if source.parent != preview_root or not source.name.startswith('hcd-inline-editor-') or not (source / 'collaboration/inline-native.epoch').is_file():
            raise ValueError('Expected an owned inline-editor fixture with collaboration state')
        source_private = json.loads((source / 'private.json').read_text())
        if source_private.get('root') != str(source):
            raise ValueError('Fixture identity does not match its path')
        env['HCD_TOKEN_SECRET'] = source_private['secret']
        shutil.copytree(source / 'collaboration', root / 'collaboration')
        if (source / 'sidecar').is_dir():
            shutil.copytree(source / 'sidecar', root / 'sidecar')
    (root / 'people').mkdir()
    (root / 'people/inline-native.json').write_text(json.dumps({'schemaVersion': 'hcd-people/1', 'generation': 1, 'people': [{'id': 'alice', 'label': 'Alice 王', 'active': True}, {'id': 'bob', 'label': 'Bob 李', 'active': True}]}))
    tokens = {user: cli('issue-token', '--document-id', 'inline-native', '--scope', 'read' if user == 'reader' else 'write', '--user-id', user, '--display-name', name, '--ttl-seconds', 3600)['token'] for user, name in [('alice', 'Alice 王'), ('bob', 'Bob 李'), ('reader', '只读访客')]}
    native, collab, vite = free_port(), free_port(), free_port()
    env.update(HCD_API_URL=f'http://127.0.0.1:{native}', HCD_COLLAB_PORT=str(collab), HCD_SIDECAR_STATE_DIR=str(root / 'sidecar'))
    config = root / 'preview.config.ts'
    config.write_text('export default ' + json.dumps({'root': str(editor), 'server': {'host': '127.0.0.1', 'port': vite, 'strictPort': True, 'fs': {'allow': [str(repo)]}, 'proxy': {'/v1': {'target': f'http://127.0.0.1:{native}', 'ws': True}, '/health': f'http://127.0.0.1:{native}'}}}))
    pages = {}
    for user, suffix in [('alice', 'writer'), ('bob', 'peer'), ('reader', 'reader')]:
        props = {'documentId': 'inline-native', 'token': tokens[user], 'apiUrl': '/v1/documents', 'collabUrl': f'ws://127.0.0.1:{collab}', 'locale': 'zh-CN'}
        name = f'inline-{suffix}.html'
        page = '''<!doctype html><html><meta charset="utf-8"><title>行内容器主编辑页</title><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style><div id="root"></div><script type="module">
import React from 'react';import{createRoot}from'react-dom/client';import{EmbeddedHcdEditor}from'/src/embed.tsx';
const adapter=({data})=>({support:'semantic',includeContent:true,blocks:[{kind:'paragraph',runs:[{text:data.title+': '}]}]});
const definition={type:'example.ui_field',version:1,display:'inline',contentModel:'inline',label:{'zh-CN':'业务字段','en-US':'Business field'},defaultData:{title:'新字段'},validate:data=>typeof data.title==='string'&&!!data.title,fallback:data=>data.title,properties:[{key:'title',label:'名称',kind:'text',required:true}],exportAdapters:{docx:adapter,pdf:adapter,pptx:adapter,md:adapter}};
const blockDefinition={...definition,type:'example.command_field',version:2,label:{'zh-CN':'块字段','en-US':'Block field'}};
createRoot(document.getElementById('root')).render(React.createElement(EmbeddedHcdEditor,{...''' + json.dumps(props, ensure_ascii=False) + ''',inlineContainerExtensions:{nodes:[definition,blockDefinition]}}));</script></html>'''
        if args.enable_native_field:
            page = page.replace('createRoot(document.getElementById', "const nativeAdapter=({resources})=>({support:'semantic',includeContent:true,blocks:[{kind:'paragraph',runs:[...(resources.some(value=>value.key==='badge')?[{resource:'badge',alt:'状态徽标',widthPt:12,heightPt:12}]:[]),{text:'[项目] '}]}]});\nconst nativeDefinition={...definition,type:'example.inline_field',version:77,defaultData:{project:'P-1'},validate:data=>typeof data.project==='string',fallback:()=> 'Field label',properties:[],exportAdapters:Object.fromEntries(['docx','html','md','pdf','pptx','txt'].map(format=>[format,nativeAdapter]))};\ncreateRoot(document.getElementById").replace('nodes:[definition,blockDefinition]', 'nodes:[definition,blockDefinition,nativeDefinition]')
        (editor / name).write_text(page)
        pages[suffix] = f'http://127.0.0.1:{vite}/{name}'
    private = root / 'private.json'
    private.write_text(json.dumps({'root': str(root), 'ports': [native, collab, vite], 'secret': env['HCD_TOKEN_SECRET'], 'tokens': tokens, 'pages': pages}))
    private.chmod(0o600)
    children, logs = [], []
    try:
        for command, cwd, name in [([str(binary), 'hdoc', 'serve', '--root', str(root), '--bind', f'127.0.0.1:{native}'], root, 'native'), (['node', '--import', 'tsx', 'sidecar.ts'], editor, 'sidecar'), ([str(editor / 'node_modules/.bin/vite'), '--config', str(config)], editor, 'vite')]:
            log = open(root / (name + '.log'), 'w')
            logs.append(log)
            children.append(subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=log))
        deadline = time.monotonic() + 45
        while True:
            assert all(child.poll() is None for child in children), f'Owned preview exited: {root}'
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{vite}/health', timeout=1).close()
                break
            except OSError:
                assert time.monotonic() < deadline
                time.sleep(.1)
        print(json.dumps({'root': str(root), **pages}), flush=True)
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
