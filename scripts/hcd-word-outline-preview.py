#!/usr/bin/env python3
"""Reopen only an owned outline fixture for actual browser inspection."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.request
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('fixture', type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    root = args.fixture.resolve()
    if root.parent != repo / 'target/hcd-preview-runtime' or not root.name.startswith('word-outline-'):
        raise ValueError('owned outline fixture required')
    c = json.loads((root / 'private.json').read_text())
    assert c['root'] == str(root) and (root / 'outline-evidence.json').exists()
    editor = repo / 'examples/hdoc/editor'
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    config = root / 'preview.config.ts'
    config.write_text('export default ' + json.dumps({'root': str(editor), 'server': {'port': port, 'host': '127.0.0.1', 'strictPort': True, 'fs': {'allow': [str(repo)]}, 'proxy': {'/v1': {'target': c['origin'], 'ws': True}}}}))
    urls = {}
    for user in ['alice', 'bob']:
        name = '.hcd-' + root.name + '-' + user + '.html'
        props = {'documentId': 'outline', 'token': c[user], 'apiUrl': '/v1/documents', 'collabUrl': f'ws://127.0.0.1:{c["collabPort"]}', 'locale': 'zh-CN'}
        (editor / name).write_text('<!doctype html><html><head><meta charset="UTF-8"><title>Word outline '+user+'</title><style>html,body,#root{margin:0;height:100%;overflow:hidden}</style></head><body><div id="root"></div><script type="module">import React from "react";import{createRoot}from"react-dom/client";import{EmbeddedHcdEditor}from"/src/embed.tsx";createRoot(document.getElementById("root")).render(React.createElement(EmbeddedHcdEditor,'+json.dumps(props)+'));</script></body></html>')
        urls[user] = f'http://127.0.0.1:{port}/{name}'
    env = {**os.environ, 'HCD_WORD_ROOMS': '1', 'HCD_TOKEN_SECRET': c['secret'], 'HCD_API_URL': c['origin'], 'HCD_COLLAB_PORT': str(c['collabPort']), 'HCD_SIDECAR_STATE_DIR': str(root / 'sidecar')}
    for key in ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_S3_ENDPOINT']:
        env.pop(key, None)
    children, logs = [], []
    try:
        for command, label in [([str(repo / 'target/debug/officecli'), 'hdoc', 'serve', '--root', str(root), '--bind', urlparse(c['origin']).netloc], 'native-preview'), (['node', '--import', 'tsx', 'sidecar.ts'], 'sidecar-preview'), ([str(editor / 'node_modules/.bin/vite'), '--config', str(config)], 'vite-preview')]:
            log = open(root / (label + '.log'), 'w')
            logs.append(log)
            children.append(subprocess.Popen(command, cwd=editor, env=env, stdout=log, stderr=log))
        deadline = time.monotonic() + 30
        while True:
            assert all(child.poll() is None for child in children)
            try:
                urllib.request.urlopen(urls['alice'], timeout=1).close()
                break
            except OSError:
                assert time.monotonic() < deadline
                time.sleep(.1)
        print(json.dumps({'root': str(root), **urls}), flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(.5)
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        for log in logs:
            log.close()


if __name__ == '__main__':
    main()
