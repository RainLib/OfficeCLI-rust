#!/usr/bin/env python3
"""Read-only native/file verification of the owned unfinished-cell scenario."""
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

    head = json.loads(get('')[0])
    assert head['revision'] == 2, head['revision']
    args.output.mkdir(parents=True, exist_ok=True)
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    records = []
    for revision, expected in [(0, 'Original Bob'), (1, '协作者新值 Peer'), (2, '未完成输入 Buffer 中文😀')]:
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

            assert text('A1') == 'Original Alice'
            assert text('B1') == expected, (revision, text('B1'))
            assert cells['C1'].findtext('s:f', '', ns) == '1+2' and text('C1') == '3'
            assert text('A2') == '12' and cells['A2'].attrib.get('t') not in ['s', 'inlineStr']
        (args.output / f'input-r{revision}.xlsx').write_bytes(data)
        records.append({'revision': revision, 'b1': expected, 'sha256': hashlib.sha256(data).hexdigest(), 'fidelity': fidelity})
    data, _ = get('/export/hcdz?revision=2')
    (args.output / 'input-r2.hcdz').write_bytes(data)
    with tempfile.TemporaryDirectory(prefix='hcd-input-offline-') as directory:
        unpacked = Path(directory) / 'unpacked.hcd'
        for arguments in [['unpack', str(args.output / 'input-r2.hcdz'), '--output', str(unpacked)], ['validate', str(unpacked)]]:
            subprocess.run([str(repo / 'target/debug/officecli'), 'hdoc', *arguments, '--json'], check=True, capture_output=True, timeout=60)
        for file in unpacked.rglob('*'):
            if file.is_file():
                assert file.read_bytes() == (root / 'book.hcd' / file.relative_to(unpacked)).read_bytes()
    output = {'revision': 2, 'xlsx': records, 'offlineHistoryAndResources': 'verified exact', 'scope': 'owned loopback synthetic workbook; read-only token'}
    (args.output / 'native-and-files.json').write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(output, ensure_ascii=False))


if __name__ == '__main__':
    main()
