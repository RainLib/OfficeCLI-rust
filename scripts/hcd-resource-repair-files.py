#!/usr/bin/env python3
"""Verify actual repair UI downloads and canonical offline bytes; no edits."""
import argparse
import base64
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    root = parser.parse_args().root.resolve()
    assert root.parent == (repo / 'target/hcd-preview-runtime').resolve()
    assert root.name.startswith('hcd-inline-editor-')
    assert json.loads((root / 'private.json').read_text())['root'] == str(root)
    out = repo / 'docs/assets/hcd-resource-repair-2026-10-30'
    original_bytes = (out / 'original.hcd-recovery').read_bytes()
    original = json.loads(original_bytes)
    repaired = json.loads((out / 'repaired.hcd-recovery').read_bytes())

    def decode(entry):
        value = base64.b64decode(entry['base64'], validate=True)
        assert len(value) == entry['byteLength'] and digest(value) == entry['sha256']
        return value

    def packet(value):
        assert value['schemaVersion'] == 'hcd-semantic-recovery/1'
        assert value['scope']['revision'] == 8 and len(value['pendingFiles']) == 1
        decode(value['state'])
        resources = {entry['sha256']: decode(entry) for entry in value['resources']}
        file = value['pendingFiles'][0]
        assert file['resource']['name'] == 'integrity-6MiB.bin'
        data = resources[file['resource']['hash']]
        assert len(data) == file['resource']['byteLength'] == 6 * 1024 * 1024
        return file, data, decode(value['canonical'])

    initial, data, before_archive = packet(original)
    final, restored, after_archive = packet(repaired)
    assert data == restored == (out / 'repaired-original.bin').read_bytes()
    assert data == bytes((i * 31 + 17) % 251 for i in range(len(data)))
    damaged = (out / 'damaged.corrupt-copy').read_bytes()
    assert damaged == bytes(len(data)) and digest(damaged) != digest(data)
    observation = json.loads((out / 'repair-observations.json').read_bytes())
    assert observation['packetHash'] == digest(original_bytes)
    assert observation['originalId'] == initial['id']
    raw = digest(f"hcd-recovery-file/1:{digest(original_bytes)}:{initial['id']}".encode())[:32]
    recovered_id = '-'.join([raw[:8], raw[8:12], raw[12:16], raw[16:20], raw[20:]])
    assert observation['recoveredId'] == final['id'] == recovered_id
    rows = observation['records']
    assert [row['label'] for row in rows] == ['initial-cancelled', 'inspected', 'recovered-task-corrupted', 'inspected', 'inspected', 'inspected', 'recovered-task-corrupted', 'inspected', 'inspected']
    assert [row['count'] for row in rows] == [0, 1, 1, 1, 1, 1, 1, 0, 0]
    for index in range(1, 7):
        row = rows[index]
        assert row['id'] == recovered_id and not row['initialPresent']
        assert row['phase'] == 'chosen' and row['length'] == len(data)
        assert row['declared'] == digest(data)
        assert row['actual'] == digest(damaged if index in [2, 3, 6] else data)
    assert all(row['missing'] and not row['initialPresent'] for row in [rows[0], rows[7], rows[8]])
    # No test-only byte restoration event: the actual product confirmation
    # repaired the first corruption; the second was cancelled by another UI.
    assert not any('restored' in row['label'] for row in rows)
    manifest = json.loads((root / 'inline-native.hcd/manifest.json').read_text())
    assert manifest['revision'] == 8
    assert original['scope'] == repaired['scope']
    assert manifest['rootHash'] == original['scope']['rootHash']
    binary = repo / 'target/debug/officecli'

    def cli(*args):
        result = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], check=True, capture_output=True, text=True)
        return json.loads(result.stdout)

    counts = []
    with tempfile.TemporaryDirectory(prefix='resource-repair-', dir=repo / 'target') as temporary:
        temporary = Path(temporary)
        for label, archive_bytes in [('before', before_archive), ('after', after_archive)]:
            archive = temporary / f'{label}.hcdz'
            archive.write_bytes(archive_bytes)
            unpacked = temporary / label
            cli('unpack', archive, '--output', unpacked)
            validation = cli('validate', unpacked)
            assert validation['success'] and validation['data']['valid']
            assert json.loads((unpacked / 'manifest.json').read_text()) == manifest
            files = [path.relative_to(unpacked) for path in unpacked.rglob('*') if path.is_file()]
            for path in files:
                assert (unpacked / path).read_bytes() == (root / 'inline-native.hcd' / path).read_bytes(), path
            counts.append(len(files))
    result = {'schemaVersion': 'hcd-resource-repair-files/1', 'revisionUnchanged': 8,
              'attachmentBytes': len(data), 'repairedSha256': digest(data), 'damagedSha256': digest(damaged),
              'productPendingFileDownloadMatchesRecoveryPacket': True, 'damagedCopyDownloadPreserved': True,
              'cancelConfirmationPreservesDamagedBytes': True, 'productRepairObserved': True,
              'fixtureRestoreButtonUsed': False, 'correctRepairIncludedInActualRecoveryExport': True,
              'secondWindowCancellationNotRevived': True, 'canonicalOfflineFileCounts': counts,
              'boundaries': ['synthetic same-origin browser and same-length corruption',
                             'private attachment only; no claim of association or Office export',
                             'second scenario intentionally cancels the task after the successful repair',
                             'no production, physical-device, full offline application or performance claim']}
    (out / 'files.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
