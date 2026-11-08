#!/usr/bin/env python3
"""Read only the browser-created resource revision in an owned fixture."""
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
    args = parser.parse_args()
    root = args.root.resolve()
    assert root.parent == repo / 'target/hcd-preview-runtime' and root.name.startswith('hcd-inline-editor-')
    binary = repo / 'target/debug/officecli'
    bundle = root / 'inline-native.hcd'
    output = repo / 'docs/assets/hcd-resource-performance-2026-10-27'
    output.mkdir(parents=True, exist_ok=True)
    def cli(*values):
        run = subprocess.run([str(binary), 'hdoc', *map(str, values), '--json'], cwd=root,
                             env={**os.environ, 'NO_COLOR': '1'}, capture_output=True, text=True, check=True, timeout=120)
        return json.loads(run.stdout)['data']
    def nodes(value):
        result = {}
        def visit(item):
            if isinstance(item, dict):
                node = item.get('extension', {})
                if node.get('schemaVersion') == 'hcd.extension/3':
                    result[node['instanceId']] = item
                for child in item.values():
                    visit(child)
            elif isinstance(item, list):
                for child in item:
                    visit(child)
        visit(value)
        return result
    def blocks(state):
        return [{key: value for key, value in block.items() if key != 'blockHash'} for block in state['blocks']]
    previous = cli('editor-state', bundle, '--revision', 26)
    current = cli('editor-state', bundle, '--revision', 27)
    assert cli('editor-state', bundle)['revision'] == 27
    node_id = 'x_564cb56e25a04b8d86502701271ce805'
    current_node = nodes(current)[node_id]
    assert current_node['extension']['data']['title'] == '附件恢复字段'
    resources = {r['name']: r for r in current_node['extension']['resources']}
    assert set(resources) == {'main-resource.txt', 'recovered-resource.txt'}
    expected = json.loads(json.dumps(previous))
    nodes(expected)[node_id]['extension']['resources'] = current_node['extension']['resources']
    assert blocks(expected) == blocks(current)
    fixture = repo / 'target/hcd-preview-runtime/hcd-inline-editor-qlhj7qrd'
    with tempfile.TemporaryDirectory(prefix='resource-readback-', dir=root) as temp:
        temp = Path(temp)
        archive, offline = temp / 'offline.hcdz', temp / 'offline.hcd'
        cli('pack', bundle, '--revision', 27, '--output', archive)
        cli('unpack', archive, '--output', offline)
        assert cli('editor-state', offline, '--revision', 26) == previous
        assert cli('editor-state', offline, '--revision', 27) == current
        assert cli('validate', offline)['valid']
        for name, resource in resources.items():
            raw = (fixture / name).read_bytes()
            assert len(raw) == resource['byteLength'] and hashlib.sha256(raw).hexdigest() == resource['hash']
            file = temp / name
            cli('get-asset', offline, resource['hash'], '--revision', 27, '--output', file)
            assert file.read_bytes() == raw
    result = {'head': 27, 'otherContentExact': True, 'peerTitlePreserved': True,
              'offlineRevisionsExact': [26, 27], 'resourceHashes': {name: r['hash'] for name, r in resources.items()}}
    (output / 'native-readback.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
