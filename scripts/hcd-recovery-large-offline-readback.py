#!/usr/bin/env python3
"""Read back a browser-created large attachment sample without altering its source."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    assert root.parent == (repo / 'target/hcd-preview-runtime').resolve()
    assert root.name.startswith('hcd-inline-editor-')
    assert json.loads((root / 'private.json').read_text())['root'] == str(root)
    bundle = root / 'inline-native.hcd'
    binary = repo / 'target/debug/officecli'

    def cli(*parts):
        result = subprocess.run([str(binary), 'hdoc', *map(str, parts), '--json'],
                                cwd=root, env={**os.environ, 'NO_COLOR': '1'},
                                capture_output=True, text=True, check=True, timeout=120)
        return json.loads(result.stdout)['data']

    def visit(value):
        if isinstance(value, dict):
            node = value.get('extension')
            if isinstance(node, dict) and node.get('schemaVersion') == 'hcd.extension/3':
                yield node
            for child in value.values():
                yield from visit(child)
        elif isinstance(value, list):
            for child in value:
                yield from visit(child)

    before = {str(p.relative_to(bundle)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in bundle.rglob('*') if p.is_file() and p.name != '.hcd-write-lock'}
    states = {n: cli('editor-state', bundle, '--revision', n) for n in (8, 9)}
    assert cli('editor-state', bundle)['revision'] == 9
    candidates = [node for node in visit(states[9])
                  if {'large-1.bin', 'large-2.bin'} <= {r['name'] for r in node.get('resources', [])}]
    assert len(candidates) == 1
    resources = {r['name']: r for r in candidates[0]['resources'] if r['name'].startswith('large-')}
    assert len(resources) == 2
    with tempfile.TemporaryDirectory(prefix='large-recovery-offline-', dir=root) as tmp:
        work = Path(tmp)
        archive, offline = work / 'saved.hcdz', work / 'offline.hcd'
        cli('pack', bundle, '--revision', 9, '--output', archive)
        cli('unpack', archive, '--output', offline)
        assert cli('validate', bundle)['valid'] and cli('validate', offline)['valid']
        for n, state in states.items():
            assert cli('editor-state', offline, '--revision', n) == state
        for i in (1, 2):
            resource = resources[f'large-{i}.bin']
            output = work / f'asset-{i}'
            cli('get-asset', offline, resource['hash'], '--revision', 9, '--output', output)
            data = output.read_bytes()
            assert len(data) == resource['byteLength'] == 6 * 1024 * 1024
            assert hashlib.sha256(data).hexdigest() == resource['hash']
            assert data == bytes([i]) * len(data)
        archive_size = archive.stat().st_size
    after = {str(p.relative_to(bundle)): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in bundle.rglob('*') if p.is_file() and p.name != '.hcd-write-lock'}
    assert after == before
    result = {'scope': 'isolated browser-generated synthetic sample', 'revision': 9,
              'historicalRevisionsVerified': [8, 9], 'attachmentBytesEach': 6 * 1024 * 1024,
              'resourceHashes': {name: r['hash'] for name, r in resources.items()},
              'archiveBytes': archive_size, 'offlineAssetsVerified': True,
              'sourceUnchanged': True}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
