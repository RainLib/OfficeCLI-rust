#!/usr/bin/env python3
"""Read back the dedicated real-socket inline reference fixture; no head edits."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--browser-revision', type=int, choices=[28])
    args = parser.parse_args()
    root = args.root.resolve()
    head = args.browser_revision or 27
    assert root.parent == repo / 'target/hcd-preview-runtime'
    assert root.name == 'hcd-inline-editor-riw31kza', 'Dedicated fixture only'
    bundle = root / 'inline-native.hcd'
    assets = repo / 'docs/assets/hcd-inline-reference-retarget-2026-10-27'
    binary = repo / 'target/debug/officecli'
    work = Path(tempfile.mkdtemp(prefix='reference-files-', dir=root))

    def sha(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def files():
        return {str(p.relative_to(bundle)): sha(p) for p in bundle.rglob('*')
                if p.is_file() and p.name != '.hcd-write-lock'}

    def cli(*args):
        result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'],
                                capture_output=True, text=True, check=True, timeout=120)
        return json.loads(result.stdout)['data']

    def indexed(value, key):
        result = {}
        def visit(value):
            if isinstance(value, dict):
                if isinstance(value.get(key), dict):
                    item = value[key]
                    result[item['instanceId' if key == 'extension' else 'mentionId']] = value
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        visit(value)
        return result

    def text(value):
        if isinstance(value, dict):
            if value.get('kind') == 'reference':
                return '@' + value['reference']['snapshot']['label']
            if 'text' in value:
                return value['text']
            return ''.join(text(v) for k, v in value.items() if k != 'extension')
        return ''.join(text(v) for v in value) if isinstance(value, list) else ''

    before = files()
    states = {n: cli('editor-state', bundle, '--revision', n) for n in [26, 27] + ([28] if head == 28 else [])}
    refs = {n: indexed(state, 'reference') for n, state in states.items()}
    mention = 'm_32ff10a0d643474bbf1338cc7eaaf5c6'
    inner = 'x_a357e63c178742a4a1d1e43a6590605f'
    assert refs[26].keys() == refs[27].keys()
    for key in refs[26]:
        if key != mention:
            assert refs[26][key] == refs[27][key]
    assert refs[26][mention]['reference']['target']['id'] == 'bob'
    assert refs[27][mention]['reference']['target']['id'] == 'carol'
    containers = {n: indexed(state, 'extension') for n, state in states.items()}
    assert containers[26].keys() == containers[27].keys()
    for key in containers[26]:
        assert containers[26][key]['extension'] == containers[27][key]['extension']
    for old, new in zip(states[26]['blocks'], states[27]['blocks']):
        if inner not in json.dumps(old):
            assert old == new
    assert text(containers[27][inner]) == 'Socket peer NestedUI @Carol 陈 '
    assert [v['text'] for v in containers[27][inner]['inlines'] if v.get('bold')] == ['es']
    if head == 28:
        assert refs[28][mention]['reference']['target']['id'] == 'alice'
        expected = json.loads(json.dumps(states[27]))
        expected_mention = indexed(expected, 'reference')[mention]
        expected_mention['reference'] = refs[28][mention]['reference']
        expected_mention['text'] = refs[28][mention]['text']
        without_hash = lambda s: [{k: v for k, v in b.items() if k != 'blockHash'} for b in s['blocks']]
        assert without_hash(expected) == without_hash(states[28])
        private = json.loads((root / 'private.json').read_text())
        request = urllib.request.Request(f"http://127.0.0.1:{private['ports'][0]}/v1/documents/inline-native/references?revision=28&locations=true", headers={
            'Authorization': 'Bearer ' + private['tokens']['reader'], 'X-HCD-Node-Edits-Version': '7',
            'X-HCD-Inline-Containers-Version': '1', 'X-HCD-Extension-Version': '3', 'X-HCD-Custom-Marks-Version': '1'})
        with urllib.request.urlopen(request, timeout=15) as response:
            reference_report = json.load(response)
        assert reference_report['reminders']['enabled'] is False
        assert len(reference_report['transition']['events']) == 1
        event = reference_report['transition']['events'][0]
        assert event['kind'] == 'reference.retargeted' and event['context']['actorId'] == 'alice'
        (assets / 'references-r28.json').write_text(json.dumps(reference_report, ensure_ascii=False, indent=2) + '\n')
    outputs = {}
    for fmt in ['docx', 'pptx', 'pdf', 'md']:
        output = work / (f'retarget-r{head}.' + fmt)
        report = cli('export', bundle, '--revision', head, '--to', fmt, '--output', output)
        if fmt in ['docx', 'pptx']:
            with zipfile.ZipFile(output) as archive:
                visible = ''.join(''.join(ET.fromstring(archive.read(n)).itertext())
                                  for n in archive.namelist() if n.endswith('.xml'))
        elif fmt == 'pdf':
            visible = subprocess.check_output(['pdftotext', str(output), '-'], text=True)
        else:
            visible = re.sub(r'</?(?:strong|em|u|s)>', '', output.read_text())
        visible = re.sub(r'\s+', '', visible)
        for required in ['SocketpeerNestedUI@' + ('Alice王' if head == 28 else 'Carol陈'), 'BobUIretained', '附件恢复字段']:
            assert required in visible, (fmt, required)
        assert visible.count('NestedUI') == 2
        outputs[fmt] = {'sha256': sha(output), 'level': report['level'], 'warnings': report.get('warnings', [])}
        shutil.copyfile(output, assets / output.name)
    archive = work / f'retarget-r{head}.hcdz'
    cli('pack', bundle, '--revision', head, '--output', archive)
    offline = work / 'offline.hcd'
    cli('unpack', archive, '--output', offline)
    for revision, state in states.items():
        assert cli('editor-state', offline, '--revision', revision) == state
    resources = {r['hash']: r for value in containers[head].values()
                 for r in value['extension'].get('resources', [])}
    for digest, resource in resources.items():
        output = work / (digest + '.bin')
        cli('get-asset', offline, digest, '--revision', head, '--output', output)
        assert sha(output) == digest and output.stat().st_size == resource['byteLength']
    assert cli('validate', offline)['valid']
    shutil.copyfile(archive, assets / archive.name)
    assert files() == before
    result = {'scope': 'Real socket-produced native revisions and source-free files; no browser or desktop Office claim',
              'head': head, 'sameMentionIds': True, 'unchangedContainerEnvelopesAndResources': True,
              'unchangedOtherReferencesAndBlocks': True, 'peerTextAndBoldRetained': True,
              'offlineVersionsExact': list(states), 'offlineResourceHashesExact': list(resources),
              'exports': outputs, 'verificationDidNotChangeBundle': True}
    (assets / ('browser-file-evidence.json' if head == 28 else 'file-evidence.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(f'PASS through r{head} reference and container identities, peer text/bold, four real exports and offline resource bytes')


if __name__ == '__main__':
    main()
