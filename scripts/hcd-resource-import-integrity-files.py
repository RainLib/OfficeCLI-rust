#!/usr/bin/env python3
"""Read back actual UI downloads; never create browser edits or task records."""
import base64
import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    repo = Path(__file__).resolve().parents[1]
    evidence = repo / 'docs/assets/hcd-resource-import-integrity-2026-10-30'
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path, help='Owned inline-editor fixture used for the actual UI downloads')
    root = parser.parse_args().root.resolve()
    assert root.parent == (repo / 'target/hcd-preview-runtime').resolve()
    assert root.name.startswith('hcd-inline-editor-')
    private = json.loads((root / 'private.json').read_text())
    assert private['root'] == str(root)
    packet_bytes = (evidence / 'original.hcd-recovery').read_bytes()
    packet = json.loads(packet_bytes)
    assert packet['schemaVersion'] == 'hcd-semantic-recovery/1'
    assert len(packet['pendingFiles']) == 1
    file = packet['pendingFiles'][0]
    assert file['resource']['name'] == 'integrity-6MiB.bin'
    assert file['resource']['byteLength'] == 6 * 1024 * 1024

    def decode(entry):
        data = base64.b64decode(entry['base64'], validate=True)
        assert len(data) == entry['byteLength']
        assert sha(data) == entry['sha256']
        return data

    canonical = decode(packet['canonical'])
    decode(packet['state'])
    resources = {entry['sha256']: decode(entry) for entry in packet['resources']}
    data = resources[file['resource']['hash']]
    assert data == bytes((i * 31 + 17) % 251 for i in range(len(data)))
    assert (evidence / 'recovered-original.bin').read_bytes() == data
    observations = json.loads((evidence / 'repeat-resource-observations.json').read_text())
    assert observations['packetHash'] == sha(packet_bytes)
    assert observations['originalId'] == file['id']
    raw = sha(f"hcd-recovery-file/1:{sha(packet_bytes)}:{file['id']}".encode())[:32]
    recovered_id = '-'.join([raw[:8], raw[8:12], raw[12:16], raw[16:20], raw[20:]])
    assert observations['recoveredId'] == recovered_id
    records = observations['records']
    assert len(records) == 5
    assert [row['label'] for row in records] == ['inspected', 'recovered-task-corrupted', 'inspected', 'test-bytes-restored', 'inspected']
    for row in records:
        assert row['count'] == 1 and not row['initialPresent']
        assert row['id'] == recovered_id and row['phase'] == 'chosen'
        assert row['length'] == len(data) and row['declared'] == sha(data)
    assert records[0]['actual'] == records[3]['actual'] == records[4]['actual'] == sha(data)
    assert records[1]['actual'] == records[2]['actual'] == sha(bytes(len(data)))

    binary = repo / 'target/debug/officecli'

    def cli(*args):
        result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], check=True, capture_output=True, text=True)
        return json.loads(result.stdout)

    live = root / 'inline-native.hcd'
    manifest = json.loads((live / 'manifest.json').read_text())
    assert manifest['revision'] == packet['scope']['revision'] == 8
    assert manifest['rootHash'] == packet['scope']['rootHash']
    with tempfile.TemporaryDirectory(prefix='resource-integrity-', dir=repo / 'target') as temporary:
        temporary = Path(temporary)
        archive = temporary / 'canonical.hcdz'
        archive.write_bytes(canonical)
        unpacked = temporary / 'canonical.hcd'
        cli('unpack', archive, '--output', unpacked)
        validation = cli('validate', unpacked)
        assert validation['success'] and validation['data']['valid']
        offline = json.loads((unpacked / 'manifest.json').read_text())
        assert offline == manifest
        # Actual canonical files, including retained history and resources.
        paths = [path.relative_to(unpacked) for path in unpacked.rglob('*') if path.is_file()]
        for path in paths:
            assert (live / path).read_bytes() == (unpacked / path).read_bytes(), path
        file_count = len(paths)

    result = {'schemaVersion': 'hcd-resource-import-integrity-files/1', 'revision': 8,
              'rootHash': manifest['rootHash'], 'packetHash': sha(packet_bytes),
              'attachmentSha256': sha(data), 'attachmentBytes': len(data),
              'taskCountAfterRejectedAndSuccessfulRepeat': 1,
              'corruptedTaskPreservedAfterRefusal': True, 'fixtureOnlyRepairBeforeNormalRetry': True,
              'actualDownloadMatchesPacket': True, 'canonicalOfflineFilesEqualLive': file_count,
              'canonicalValidation': validation,
              'boundaries': ['same-origin synthetic browser fixture', 'unassociated attachment remains a private task',
                             'test controls repair bytes; product never silently repairs corruption',
                             'no cross-device, production, full offline app or performance claim']}
    (evidence / 'files.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key != 'canonicalValidation'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
