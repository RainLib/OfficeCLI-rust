#!/usr/bin/env python3
"""Read actual workbook retry UI downloads and offline history, without edits."""
import argparse
import hashlib
import json
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def main():
    repo = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    root = parser.parse_args().root.resolve()
    assert root.parent == (repo / 'target/hcd-preview-runtime').resolve()
    assert root.name.startswith('hcd-workbook-')
    assert json.loads((root / 'private.json').read_text())['root'] == str(root)
    out = repo / 'docs/assets/hcd-workbook-storage-retry-2026-10-30'
    copies = [(out / name).read_bytes() for name in ['before-retry.hcd-batch-draft', 'after-storage-retry.hcd-batch-draft', 'reopened.hcd-batch-draft']]
    assert copies[0] == copies[1] == copies[2]
    state = json.loads(copies[0])['state']
    assert state['attempt'] is None and state['input']['baseRevision'] == 0
    assert [(cell['row'], cell['column'], cell['text']) for cell in state['input']['cells']] == [(2, 1, '重试保留甲😀'), (2, 2, '重试保留乙')]
    rows = json.loads((out / 'storage-retry-observations.json').read_text())['records']
    retry = [row for row in rows if row['event'] == 'retryStorage-done']
    assert len(retry) == 2 and [row['result'] for row in retry] == [False, True]
    assert {row['owner'] for row in rows if 'owner' in row} == {1}
    assert sum(row['event'] == 'device-write-refused' for row in rows) == 1
    assert sum(row['event'] == 'device-read-refused' for row in rows) == 2
    for row in retry:
        assert row['transient'] == state['input'] and row['entries'] == []
    assert retry[0]['problem'] and not retry[1]['problem']
    durable = [row for row in rows if row['event'] == 'persistTransient-done']
    assert len(durable) == 1 and durable[0]['transient'] is None
    assert len(durable[0]['entries']) == 1 and durable[0]['entries'][0]['state'] == state
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

    def workbook(path):
        with zipfile.ZipFile(path) as archive:
            sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
            return {cell.get('r'): {'text': ''.join(cell.itertext()), 'formula': cell.findtext('m:f', namespaces=ns), 'value': cell.findtext('m:v', namespaces=ns)} for cell in sheet.findall('.//m:c', ns)}

    def verify(path, revision):
        cells = workbook(path)
        assert cells['A1']['text'] == ('Bob后续协作' if revision == 2 else 'Original Alice')
        assert cells['B1']['text'] == 'Original Bob'
        assert cells['C1']['formula'] == '1+2' and cells['C1']['value'] == '3'
        assert cells['A2']['value'] == '12'
        assert cells['B2']['text'] == 'Numeric and formula stay intact'
        assert cells['A300']['text'] == 'Offscreen draft'
        if revision:
            assert cells['B3']['text'] == '重试保留甲😀' and cells['C3']['text'] == '重试保留乙'
        else:
            assert 'B3' not in cells and 'C3' not in cells
        return cells

    downloaded = {revision: verify(out / f'browser-r{revision}.xlsx', revision) for revision in [1, 2]}
    source = root / 'source.xlsx'
    manifest = json.loads((root / 'book.hcd/manifest.json').read_text())
    assert manifest['revision'] == 2
    assert hashlib.sha256(source.read_bytes()).hexdigest() == manifest['source']['sha256']
    assert source.read_bytes() == (root / 'sources/book.xlsx').read_bytes()
    binary = repo / 'target/debug/officecli'

    def cli(*args):
        output = subprocess.run([str(binary), 'hdoc', *map(str, args), '--json'], check=True, capture_output=True, text=True)
        return json.loads(output.stdout)

    with tempfile.TemporaryDirectory(prefix='workbook-storage-retry-', dir=repo / 'target') as temporary:
        temporary = Path(temporary)
        unpacked = temporary / 'book.hcd'
        cli('unpack', out / 'browser-r2.hcdz', '--output', unpacked)
        validated = cli('validate', unpacked)
        assert validated['success'] and validated['data']['valid']
        assert json.loads((unpacked / 'manifest.json').read_text()) == manifest
        files = [path.relative_to(unpacked) for path in unpacked.rglob('*') if path.is_file()]
        for path in files:
            assert (root / 'book.hcd' / path).read_bytes() == (unpacked / path).read_bytes(), path
        for revision in range(3):
            exported = temporary / f'offline-r{revision}.xlsx'
            cli('export', unpacked, '--revision', revision, '--source', source, '--output', exported)
            cells = verify(exported, revision)
            if revision:
                assert cells == downloaded[revision]
    result = {'schemaVersion': 'hcd-workbook-storage-retry-files/1', 'headRevision': 2,
              'identicalBackupsBeforeAfterRetryAndReopen': True, 'backupSha256': hashlib.sha256(copies[0]).hexdigest(),
              'sameClientOwnerDuringRetries': 1, 'writeFailures': 1, 'readFailures': 2,
              'bothValuesRetained': True, 'formulaAndCachedValueRetained': True,
              'browserXlsxRevisions': [1, 2], 'offlineSourceBackedHistoryRevisions': [0, 1, 2],
              'offlineCanonicalFilesEqual': len(files), 'nativeValidation': validated,
              'boundaries': ['synthetic same-device browser fault controls', 'ordinary paste and save; no injected cell content',
                             'original tag closed and reopened; not an OS crash or physical device test',
                             'offline source-backed export explicitly supplies the retained original XLSX',
                             'no cross-device, multi-instance, power-loss or full offline app claim']}
    (out / 'files.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key != 'nativeValidation'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
