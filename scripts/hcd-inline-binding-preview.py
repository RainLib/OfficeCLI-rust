#!/usr/bin/env python3
"""Own isolated Vite UI for internal inline binding. No native/user room writes."""
import argparse
import json
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--commands',action='store_true');parser.add_argument('--resources',action='store_true');parser.add_argument('--scope',action='store_true');parser.add_argument('--token',action='store_true');parser.add_argument('--uncertain-resource',action='store_true');args=parser.parse_args();args.commands=args.commands or args.resources
    repo = Path(__file__).resolve().parents[1]
    root = Path(tempfile.mkdtemp(prefix='hcd-inline-binding-ui-', dir=repo / 'target/hcd-preview-runtime'))
    editor = root / 'editor'
    shutil.copytree(repo / 'examples/hdoc/editor', editor, ignore=shutil.ignore_patterns('node_modules', 'dist', 'dist-embed', '.hcd-*'))
    (editor / 'node_modules').symlink_to(repo / 'examples/hdoc/editor/node_modules', target_is_directory=True)
    page = editor / 'inline-binding.html'
    page.write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>行内正文绑定验证</title>
<style>body{margin:0;background:#edf1f6;color:#24344d;font:14px system-ui}header{padding:18px 24px;background:white;border-bottom:1px solid #dbe2ed}h1{font-size:20px;margin:0 0 8px}p{line-height:1.8}.panes{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:24px}.pane{background:white;padding:24px;border:1px solid #dbe2ed;border-radius:8px;min-height:260px}.pane h2{font-size:15px;margin-top:0}.ProseMirror{font:18px/2 Georgia,serif;min-height:150px;outline:none;padding:12px 0}[data-hcd-inline-container]{background:#eef5ff;border:1px solid #a9c7f4;border-radius:3px;padding:2px 3px}button{padding:7px 12px;border:1px solid #cad6e6;border-radius:5px;background:white;color:inherit;cursor:pointer}pre{white-space:pre-wrap;margin:0 24px;padding:16px;background:white;border:1px solid #dbe2ed;line-height:1.8}#errors{color:#b21b28;border:0;background:transparent}small{color:#66768c}</style>
<header><h1>行内正文 · 扩展视图验证</h1><small>独立宿主 SDK 测试入口：两份真实编辑器通过本机 Yjs 更新交换；未启用活动协作房间或原生保存。</small><p><button id="offline">断开副本</button> <button id="sync">同步副本</button> <button id="unload">卸载 Alice 扩展</button> <button id="reload">重新注册 Alice 扩展</button> <button id="receipt">应用来源回执</button> <button id="readonly">Alice 只读</button> <button id="editable">Alice 可编辑</button> <span id="connection"></span></p><span id="rejected" role="status"></span></header>
<main class="panes"><section class="pane"><h2>Alice</h2><div id="editor-0"></div><button id="undo-0">撤销 Alice</button> <button id="redo-0">重做 Alice</button></section><section class="pane"><h2>Bob</h2><div id="editor-1"></div><button id="undo-1">撤销 Bob</button> <button id="redo-1">重做 Bob</button></section></main><pre id="status" aria-live="polite"></pre><pre id="errors" role="alert"></pre><script type="module" src="/fixtures/inlineBindingPreview.ts"></script></html>''')
    if args.commands:
        page.write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>行内容器统一命令验证</title><style>body{margin:0;background:#edf1f6;color:#24344d;font:14px system-ui}.hcd-surface{padding:20px}h1{font-size:20px}.inline-command-panes{display:grid;grid-template-columns:1fr 1fr;gap:20px}.inline-command-pane{background:white;padding:18px;border:1px solid #dbe2ed;border-radius:8px}.inline-command-pane h2{font-size:16px}.inline-command-pane nav{display:flex;gap:8px;margin:16px 0}.inline-command-pane button{padding:6px 9px;border:1px solid #cbd6e8;background:white;border-radius:4px;cursor:pointer}.inline-command-pane button:disabled{opacity:.4;cursor:default}.inline-command-editor .ProseMirror{min-height:180px;border:1px solid #dbe2ed;padding:16px;font-size:17px;line-height:2;outline:none}.inline-command-pane input{padding:6px;border:1px solid #cbd6e8;margin:8px}.inline-command-pane [role=alert]{color:#b51b2b}</style><div id="root"></div><script type="module" src="/fixtures/inlineCommandsPreview.tsx"></script></html>''')
    if args.scope:
        page.write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>文档任务隔离验证</title><style>body{font:15px system-ui;background:#f2f5fa;color:#24344d}main{max-width:800px;margin:40px auto;padding:28px;background:white}button{padding:8px;margin:4px}</style><div id="root"></div><script type="module" src="/fixtures/semanticScopePreview.tsx"></script></html>''')
    if args.token:
        page.write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>附件令牌刷新验证</title><style>body{font:15px system-ui;background:#f2f5fa;color:#24344d}main{max-width:800px;margin:40px auto;padding:28px;background:white}button{padding:8px;margin:4px}</style><div id="root"></div><script type="module" src="/fixtures/resourceTokenPreview.tsx"></script></html>''')
    if args.uncertain_resource:
        page.write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>附件设备写入验证</title><style>body{font:15px system-ui;background:#f2f5fa;color:#24344d}main{max-width:800px;margin:40px auto;padding:28px;background:white}button{padding:8px;margin:4px}</style><main><h1>附件设备写入验证</h1><p>设备写入成功后注入错误；此页面没有服务端上传。</p><button id="start">模拟结果不明</button><button id="read" disabled>读取原文件</button><button id="save" disabled>保存</button><p id="status" role="status">正在打开设备日志…</p></main><script type="module" src="/fixtures/nodeResourceUncertainPreview.ts"></script></html>''')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    config = root / 'preview.config.ts'
    config.write_text('export default ' + json.dumps({'root': str(editor), 'server': {'host': '127.0.0.1', 'port': port, 'strictPort': True, 'fs': {'allow': [str(repo)]}}}))
    log = open(root / 'vite.log', 'w')
    process = subprocess.Popen([str(editor / 'node_modules/.bin/vite'), '--config', str(config)], cwd=editor, stdout=log, stderr=log)
    try:
        url = f'http://127.0.0.1:{port}/inline-binding.html'+('?resources=1' if args.resources else '')
        deadline = time.monotonic() + 30
        while True:
            assert process.poll() is None, 'preview stopped'
            try:
                urllib.request.urlopen(url, timeout=1).close()
                break
            except OSError:
                assert time.monotonic() < deadline
                time.sleep(.1)
        print(json.dumps({'root': str(root), 'preview': url}), flush=True)
        while process.poll() is None:
            time.sleep(.5)
    finally:
        process.terminate()
        process.wait(timeout=10)
        log.close()


if __name__ == '__main__':
    main()
