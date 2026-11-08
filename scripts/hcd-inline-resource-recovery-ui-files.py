#!/usr/bin/env python3
"""Read immutable files made by the owned main-page resource/recovery UI run.

This verifies existing browser results; it never creates edits or attaches a
pending file in place of the user-facing confirmation.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request
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
    assets = repo / 'docs/assets/hcd-inline-resource-recovery-ui-2026-10-27'
    binary = repo / 'target/debug/officecli'
    work = Path(tempfile.mkdtemp(prefix='resource-files-', dir=root))

    def sha(data):
        return hashlib.sha256(data).hexdigest()

    def cli(*arguments):
        result = subprocess.run([str(binary), 'hdoc', *map(str, arguments), '--json'],
                                cwd=work, env={**os.environ, 'NO_COLOR': '1'},
                                capture_output=True, text=True, check=True, timeout=120)
        return json.loads(result.stdout)['data']

    def files():
        return {str(p.relative_to(bundle)): sha(p.read_bytes())
                for p in bundle.rglob('*') if p.is_file() and p.name != '.hcd-write-lock'}

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
        # Content hashes necessarily change with the edited envelope; native
        # validation below verifies them. Keep IDs, sources and all content.
        return [{k: v for k, v in block.items() if k != 'blockHash'}
                for block in state['blocks']]

    before = files()
    states = {n: cli('editor-state', bundle, '--revision', n) for n in [24, 25, 26]}
    outer = 'x_564cb56e25a04b8d86502701271ce805'
    original = nodes(states[24])[outer]
    attached = nodes(states[25])[outer]
    renamed = nodes(states[26])[outer]
    resource = attached['extension']['resources'][0]
    expected = json.loads(json.dumps(states[24]))
    nodes(expected)[outer]['extension']['resources'] = [resource]
    assert blocks(expected) == blocks(states[25]), 'Attachment changed unrelated content'
    expected = json.loads(json.dumps(states[25]))
    nodes(expected)[outer]['extension'] = renamed['extension']
    assert blocks(expected) == blocks(states[26]), 'Peer property edit changed body or other nodes'
    assert renamed['inlines'] == original['inlines']
    assert renamed['extension']['data']['title'] == '附件恢复字段'
    assert renamed['extension']['resources'] == [resource]
    assert (assets / 'main-resource.txt').read_bytes() == (root / 'main-resource.txt').read_bytes()
    assert sha((assets / 'main-resource.txt').read_bytes()) == resource['hash']

    packet = json.loads((assets / 'pending-file.hcd-recovery').read_bytes())
    assert packet['scope']['revision'] == 25
    assert packet['scope']['model'] == 'structure3-inline1'
    assert len(packet['pendingFiles']) == 1
    pending = packet['pendingFiles'][0]
    assert pending['expected']['instanceId'] == outer
    assert pending['expected']['data']['title'] == '新字段'
    assert pending['expected']['resources'] == [resource]
    assert pending['phase'] == 'chosen'
    decoded = {}
    for entry in [packet['canonical'], packet['state'], *packet['resources']]:
        raw = base64.b64decode(entry['base64'], validate=True)
        assert len(raw) == entry['byteLength'] and sha(raw) == entry['sha256']
        decoded[entry['sha256']] = raw
    assert decoded[pending['resource']['hash']] == (root / 'recovered-resource.txt').read_bytes()
    assert pending['resource']['hash'] not in json.dumps(states[26])
    canonical = work / 'packet-canonical.hcdz'
    canonical.write_bytes(decoded[packet['canonical']['sha256']])
    offline_packet = work / 'packet.hcd'
    cli('unpack', canonical, '--output', offline_packet)
    assert cli('editor-state', offline_packet) == states[25]

    private = json.loads((root / 'private.json').read_text())
    base = f"http://127.0.0.1:{private['ports'][0]}/v1/documents/inline-native"
    headers = {'Authorization': 'Bearer ' + private['tokens']['reader'],
               'X-HCD-Node-Edits-Version': '7', 'X-HCD-Inline-Containers-Version': '1',
               'X-HCD-Extension-Version': '3', 'X-HCD-Custom-Marks-Version': '1'}
    references = []
    for revision in [24, 25, 26]:
        request = urllib.request.Request(base + f'/references?revision={revision}&locations=true', headers=headers)
        with urllib.request.urlopen(request, timeout=15) as response:
            report = json.load(response)
        assert report['reminders']['enabled'] is False
        assert report['transition']['events'] == [], 'Attachment/property edit repeated a reference event'
        references.append(report['items'])
        (assets / f'references-r{revision}.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    assert references[0] == references[1] == references[2]
    request = urllib.request.Request(base + f"/assets/{resource['hash']}?revision=26", headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        assert response.read() == (assets / 'main-resource.txt').read_bytes()

    outputs = {}
    for fmt in ['docx', 'pptx', 'pdf', 'md']:
        output = work / ('resources-r26.' + fmt)
        report = cli('export', bundle, '--revision', 26, '--to', fmt, '--output', output)
        if fmt in ['docx', 'pptx']:
            with zipfile.ZipFile(output) as archive:
                visible = ''.join(''.join(ET.fromstring(archive.read(n)).itertext())
                                  for n in archive.namelist() if n.endswith('.xml'))
        elif fmt == 'pdf':
            visible = subprocess.check_output(['pdftotext', str(output), '-'], text=True)
        else:
            visible = re.sub(r'</?(?:strong|em|u|s)>', '', output.read_text())
        visible = re.sub(r'\s+', '', visible)
        for required in ['附件恢复字段', 'NestedUI', '@Bob李', 'BobUIretained']:
            assert required in visible, (fmt, required)
        assert visible.count('NestedUI') == 2
        outputs[fmt] = {'sha256': sha(output.read_bytes()), 'level': report['level'],
                        'warnings': report.get('warnings', [])}
        shutil.copyfile(output, assets / output.name)

    archive = work / 'resource-history-r26.hcdz'
    cli('pack', bundle, '--revision', 26, '--output', archive)
    offline = work / 'offline.hcd'
    cli('unpack', archive, '--output', offline)
    for revision, state in states.items():
        assert cli('editor-state', offline, '--revision', revision) == state
    resource_output = work / 'offline-main-resource.txt'
    cli('get-asset', offline, resource['hash'], '--revision', 26, '--output', resource_output)
    assert resource_output.read_bytes() == (assets / 'main-resource.txt').read_bytes()
    assert cli('validate', offline)['valid']
    shutil.copyfile(archive, assets / archive.name)
    assert files() == before, 'Readback changed the source bundle'
    result = {'scope': 'Actual main-page file choice/download/recovery export and native immutable files',
              'attachmentRevision': 25, 'peerRenameRevision': 26,
              'nestedBodyAndOtherBlocksExact': True, 'downloadBytesExact': True,
              'pendingFileInRecoveryPacketOnly': True,
              'packetCanonicalRevisionExact': 25, 'packetResourceHashesExact': list(decoded),
              'offlineVersionsExact': list(states), 'offlineAttachmentBytesExact': True,
              'readOnlyHttpAttachmentBytesExact': True,
              'savedReferencesExactNoNewEvents': [24, 25, 26], 'remindersSent': False,
              'exports': outputs, 'verificationDidNotChangeBundle': True,
              'pendingFileAttachmentAndResave': 'Not established by this file verifier'}
    (assets / 'file-evidence.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'exports'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
