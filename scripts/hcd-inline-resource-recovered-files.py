#!/usr/bin/env python3
"""Read back the r27 browser-confirmed resource recovery in an owned fixture."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    root = parser.parse_args().root.resolve()
    assert root.parent == repo / 'target/hcd-preview-runtime' and root.name == 'hcd-inline-editor-qlhj7qrd'
    bundle = root / 'inline-native.hcd'
    assets = repo / 'docs/assets/hcd-inline-resource-recovery-ui-2026-10-27'
    binary = repo / 'target/debug/officecli'
    work = Path(tempfile.mkdtemp(prefix='recovered-files-', dir=root))

    def cli(*args):
        value = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], cwd=work,
                               env={**os.environ, 'NO_COLOR': '1'}, capture_output=True,
                               text=True, check=True, timeout=120)
        return json.loads(value.stdout)['data']

    def sha(value):
        return hashlib.sha256(value).hexdigest()

    def files():
        return {str(path.relative_to(bundle)): sha(path.read_bytes()) for path in bundle.rglob('*')
                if path.is_file() and path.name != '.hcd-write-lock'}

    def nodes(value):
        found = {}
        def visit(item):
            if isinstance(item, dict):
                envelope = item.get('extension', {})
                if envelope.get('schemaVersion') == 'hcd.extension/3':
                    found[envelope['instanceId']] = item
                for child in item.values():
                    visit(child)
            elif isinstance(item, list):
                for child in item:
                    visit(child)
        visit(value)
        return found

    def blocks(state):
        return [{key: value for key, value in block.items() if key != 'blockHash'} for block in state['blocks']]

    before = files()
    states = {revision: cli('editor-state', bundle, '--revision', revision) for revision in (24, 25, 26, 27)}
    assert cli('editor-state', bundle)['revision'] == 27
    outer = 'x_564cb56e25a04b8d86502701271ce805'
    old, current = nodes(states[26])[outer], nodes(states[27])[outer]
    assert current['extension']['data']['title'] == '附件恢复字段'
    resources = {resource['name']: resource for resource in current['extension']['resources']}
    assert set(resources) == {'main-resource.txt', 'recovered-resource.txt'}
    expected = json.loads(json.dumps(states[26]))
    nodes(expected)[outer]['extension']['resources'] = current['extension']['resources']
    assert blocks(expected) == blocks(states[27]), 'Recovery changed unrelated content'
    assert old['inlines'] == current['inlines']
    for name, resource in resources.items():
        raw = (root / name).read_bytes()
        assert sha(raw) == resource['hash'] and len(raw) == resource['byteLength']
        saved = work / ('verified-' + name)
        cli('get-asset', bundle, resource['hash'], '--revision', 27, '--output', saved)
        assert saved.read_bytes() == raw

    outputs = {}
    for fmt in ('docx', 'pptx', 'pdf', 'md'):
        output = work / ('recovered-r27.' + fmt)
        report = cli('export', bundle, '--revision', 27, '--to', fmt, '--output', output)
        if fmt in ('docx', 'pptx'):
            with zipfile.ZipFile(output) as archive:
                visible = ''.join(''.join(ET.fromstring(archive.read(name)).itertext())
                                  for name in archive.namelist() if name.endswith('.xml'))
        elif fmt == 'pdf':
            visible = subprocess.check_output(['pdftotext', str(output), '-'], text=True)
        else:
            visible = re.sub(r'</?(?:strong|em|u|s)>', '', output.read_text())
        visible = re.sub(r'\s+', '', visible)
        for value in ('附件恢复字段', 'NestedUI', '@Bob李', 'BobUIretained'):
            assert value in visible, (fmt, value)
        outputs[fmt] = {'sha256': sha(output.read_bytes()), 'level': report['level'], 'warnings': report.get('warnings', [])}
        shutil.copyfile(output, assets / output.name)

    archive, offline = work / 'recovered-r27.hcdz', work / 'recovered-offline.hcd'
    cli('pack', bundle, '--revision', 27, '--output', archive)
    cli('unpack', archive, '--output', offline)
    for revision, state in states.items():
        assert cli('editor-state', offline, '--revision', revision) == state
    for name, resource in resources.items():
        output = work / ('offline-' + name)
        cli('get-asset', offline, resource['hash'], '--revision', 27, '--output', output)
        assert output.read_bytes() == (root / name).read_bytes()
    assert cli('validate', offline)['valid'] and cli('validate', bundle)['valid']
    assert files() == before, 'Read-only verification changed the source bundle'
    shutil.copyfile(archive, assets / archive.name)
    evidence = {'head': 27, 'peerTitlePreserved': True, 'otherContentExact': True,
                'resourceHashes': {name: resource['hash'] for name, resource in resources.items()},
                'offlineRevisionsExact': list(states), 'offlineBytesExact': True,
                'exports': outputs, 'verificationDidNotChangeBundle': True}
    (assets / 'r27-native-files.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(evidence, ensure_ascii=False))


if __name__ == '__main__':
    main()
