#!/usr/bin/env python3
"""Validate immutable files produced by the owned production-editor UI run.

This does not drive a browser or synthesize its edits. The four required
revisions must already exist from the actual Alice/Bob main-page operations.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    assert root.parent == repo / 'target/hcd-preview-runtime'
    assert root.name.startswith('hcd-inline-editor-')
    bundle = root / 'inline-native.hcd'
    binary = repo / 'target/debug/officecli'
    assets = repo / 'docs/assets/hcd-inline-main-acceptance-2026-10-27'
    assets.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix='readback-', dir=root))
    env = {**os.environ, 'NO_COLOR': '1'}

    def cli(*arguments):
        result = subprocess.run([str(binary), 'hdoc', *map(str, arguments), '--json'],
                                cwd=work, env=env, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)['data']

    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def files():
        return {str(path.relative_to(bundle)): digest(path)
                for path in bundle.rglob('*') if path.is_file() and path.name != '.hcd-write-lock'}

    def field(state):
        value = state['blocks'][-1]['content']['inlines'][0]['content']
        assert value['extension']['type'] == 'example.ui_field'
        assert value['extension']['schemaVersion'] == 'hcd.extension/3'
        return value['extension'], ''.join(part['text'] for part in value['inlines'])

    before = files()
    states = {revision: cli('editor-state', bundle, '--revision', revision)
              for revision in [8, 11, 12, 13, 14]}
    assert field(states[11])[1] == '主编辑正文😀'
    assert field(states[12])[1] == '主编辑正文😀回执后'
    assert field(states[13])[0]['data']['title'] == '主页面字段'
    extension, text = field(states[14])
    assert text == '主编辑正文同伴输入😀回执后'
    for revision in [11, 12, 13, 14]:
        assert len(states[revision]['blocks']) == 4
        assert states[revision]['blocks'][:3] == states[8]['blocks']
    assert cli('validate', bundle)['valid']
    exports = {}
    for format in ['docx', 'pdf', 'pptx', 'md']:
        output = work / ('main-r14.' + format)
        report = cli('export', bundle, '--to', format, '--revision', 14, '--output', output)
        if format == 'pdf':
            visible = subprocess.run(['pdftotext', str(output), '-'], check=True,
                                     capture_output=True, text=True).stdout
        elif format == 'md':
            visible = output.read_text()
        else:
            with zipfile.ZipFile(output) as archive:
                parts = ['word/document.xml'] if format == 'docx' else [
                    name for name in archive.namelist()
                    if name.startswith('ppt/slides/slide') and name.endswith('.xml')]
                visible = ''.join(''.join(ET.fromstring(archive.read(name)).itertext()) for name in parts)
        normalized = ''.join(visible.split())
        # PDF font fallback may replace emoji, but may never drop the body.
        assert '主页面字段' in normalized and text.replace('😀', '') in normalized.replace('😀', '')
        (assets / output.name).write_bytes(output.read_bytes())
        exports[format] = {'sha256': digest(output), 'byteLength': output.stat().st_size,
                           'level': report['level'], 'warnings': report.get('warnings', [])}
    packed = work / 'main-r14.hcdz'
    cli('pack', bundle, '--revision', 14, '--output', packed)
    offline = work / 'offline.hcd'
    cli('unpack', packed, '--output', offline)
    assert cli('validate', offline)['valid']
    assert cli('editor-state', offline) == states[14]
    (assets / packed.name).write_bytes(packed.read_bytes())
    assert files() == before, 'Verification changed the original test bundle'
    result = {'scope': 'Actual main-page UI edits; native immutable file readback, no desktop Office claim',
              'fixture': root.name, 'bodyFirstSave': 11, 'bodyEditAfterReceipt': 12,
              'propertySave': 13, 'peerBodySave': 14, 'originalThreeBlocksExact': True,
              'canonicalRootCount': 4, 'offlineCanonicalExact': True,
              'instanceId': extension['instanceId'], 'exports': exports,
              'verificationDidNotChangeBundle': True, 'nativeBinarySha256': digest(binary)}
    (assets / 'file-evidence.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'fixture': root.name, 'verifiedRevisions': [11, 12, 13, 14],
                      'exports': list(exports), 'offlineCanonicalExact': True}, ensure_ascii=False))


if __name__ == '__main__':
    main()
