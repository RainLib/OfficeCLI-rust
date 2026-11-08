#!/usr/bin/env python3
"""Read-only verification of the owned 13-cell recovery pagination fixture."""
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
            return response.read()
    assert json.loads(get(''))['revision'] == 2
    workbook = get('/export/xlsx?revision=2&source=true')
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(io.BytesIO(workbook)) as archive:
        sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        strings = [''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml'))] if 'xl/sharedStrings.xml' in archive.namelist() else []
        cells = {node.attrib['r']: node for node in sheet.findall('.//s:c', ns)}
        def text(address):
            cell = cells[address]
            if cell.attrib.get('t') == 's':
                return strings[int(cell.findtext('s:v', '', ns))]
            if cell.attrib.get('t') == 'inlineStr':
                return ''.join(node.text or '' for node in cell.findall('.//s:t', ns))
            return cell.findtext('s:v', '', ns)
        assert text('A1') == '首项' + '长' * 6100 + '末尾标识'
        for index in range(2, 13):
            assert text(f'A{index}') == f'草稿第 {index} 项'
        assert text('A13') == '同伴第十三项'
    archive = get('/export/hcdz?revision=2')
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'recovered-r2.xlsx').write_bytes(workbook)
    (args.output / 'recovered-r2.hcdz').write_bytes(archive)
    with tempfile.TemporaryDirectory(prefix='hcd-review-pages-') as directory:
        unpacked = Path(directory) / 'unpacked.hcd'
        for operation in [['unpack', str(args.output / 'recovered-r2.hcdz'), '--output', str(unpacked)], ['validate', str(unpacked)]]:
            subprocess.run([str(repo / 'target/debug/officecli'), 'hdoc', *operation, '--json'], capture_output=True, check=True, timeout=60)
        for file in unpacked.rglob('*'):
            if file.is_file():
                assert file.read_bytes() == (root / 'book.hcd' / file.relative_to(unpacked)).read_bytes()
    result = {'revision': 2, 'localCellsPreserved': 12, 'longCellLength': 6106,
              'peerCellPreserved': True, 'offlineHistoryAndResources': 'verified exact',
              'xlsxSha256': hashlib.sha256(workbook).hexdigest()}
    (args.output / 'native-readback.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
