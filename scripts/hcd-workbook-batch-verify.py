#!/usr/bin/env python3
"""Read-only XLSX/history check for the owned two-cell browser scenario."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    root = args.root.resolve()
    assert root.parent == repo / 'target/hcd-preview-runtime' and root.name.startswith('hcd-workbook-')
    config = json.loads((root / 'private.json').read_text())
    url = f"http://127.0.0.1:{config['ports'][0]}/v1/documents/book"

    def get(path):
        request = urllib.request.Request(url + path, headers={'Authorization': 'Bearer ' + config['tokens']['reader']})
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read(), response.headers.get('x-hcd-fidelity-level')

    assert json.loads(get('')[0])['revision'] == 4
    args.output.mkdir(parents=True, exist_ok=True)
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    versions = [('Original Alice', 'Original Bob'), ('批量甲', '批量乙'), ('Original Alice', 'Original Bob'), ('批量甲', '批量乙'), ('批量甲', '协作者乙')]
    records = []
    for revision, expected in enumerate(versions):
        data, fidelity = get(f'/export/xlsx?revision={revision}&source=true')
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
            strings = []
            if 'xl/sharedStrings.xml' in archive.namelist():
                strings = [''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
            cells = {node.attrib['r']: node for node in sheet.findall('.//s:c', ns)}

            def text(address):
                cell = cells[address]
                if cell.attrib.get('t') == 's':
                    return strings[int(cell.findtext('s:v', '', ns))]
                if cell.attrib.get('t') == 'inlineStr':
                    return ''.join(node.text or '' for node in cell.findall('.//s:t', ns))
                return cell.findtext('s:v', '', ns)

            assert (text('A1'), text('B1')) == expected
            assert cells['C1'].findtext('s:f', '', ns) == '1+2' and text('C1') == '3'
            assert text('A2') == '12' and cells['A2'].attrib.get('t') not in ['s', 'inlineStr']
            assert text('B2') == 'Numeric and formula stay intact'
        revision_file = root / 'book.hcd/revisions' / f'{revision:020}.json'
        metadata = json.loads(revision_file.read_text())
        if revision:
            assert metadata['authorId'] == ('bob' if revision == 4 else 'alice')
        (args.output / f'batch-r{revision}.xlsx').write_bytes(data)
        records.append({'revision': revision, 'a1': expected[0], 'b1': expected[1], 'sha256': hashlib.sha256(data).hexdigest(), 'fidelity': fidelity})
    data, _ = get('/export/hcdz?revision=4')
    (args.output / 'batch-r4.hcdz').write_bytes(data)
    with tempfile.TemporaryDirectory(prefix='hcd-batch-offline-') as directory:
        unpacked = Path(directory) / 'unpacked.hcd'
        for arguments in [['unpack', str(args.output / 'batch-r4.hcdz'), '--output', str(unpacked)], ['validate', str(unpacked)]]:
            subprocess.run([str(repo / 'target/debug/officecli'), 'hdoc', *arguments, '--json'], check=True, capture_output=True, timeout=60)
        for file in unpacked.rglob('*'):
            if file.is_file():
                assert file.read_bytes() == (root / 'book.hcd' / file.relative_to(unpacked)).read_bytes()
    result = {'revision': 4, 'xlsx': records, 'protectedFormula': 'preserved', 'mixedPasteAndConflictingUndo': 'no extra revision', 'offlineHistoryAndResources': 'verified exact'}
    (args.output / 'batch-native-files.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
