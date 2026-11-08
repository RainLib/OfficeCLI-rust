#!/usr/bin/env python3
"""Read-only browser-result verifier for the named owned workbook fixture."""
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
    parser.add_argument('--expected-b1', required=True)
    parser.add_argument('--expected-a1', default='Bob preserved A1')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    root = args.root.resolve()
    assert root.parent == repo / 'target/hcd-preview-runtime' and root.name.startswith('hcd-workbook-')
    c = json.loads((root / 'private.json').read_text())
    origin = f"http://127.0.0.1:{c['ports'][0]}/v1/documents/book"

    def read(route, user='reader'):
        request = urllib.request.Request(origin + route, headers={'Authorization': 'Bearer ' + c['tokens'][user]})
        with urllib.request.urlopen(request, timeout=45) as response:
            return response.read(), response.headers.get('x-hcd-fidelity-level')

    manifest = json.loads(read('')[0])
    revision = manifest['revision']
    args.output.mkdir(parents=True, exist_ok=True)
    records = []
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    for selected in range(revision + 1):
        data, fidelity = read(f'/export/xlsx?revision={selected}&source=true')
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

            assert text('A1') == ('Original Alice' if selected == 0 else 'Bob preserved A1' if selected < 7 else args.expected_a1)
            expected = {0:'Original Bob',1:'Original Bob',2:'Alice draft 中文😀',3:'Committed before lost response',4:'Later typing after unknown 中文',5:'Alice conflict canonical',6:'Alice own undo sample',7:'Alice own undo sample',8:'Alice conflict canonical',9:'Alice own undo sample',10:'Bob samecell later',11:'Alice fresh local r11',12:'Bob fresh canonical r12'}.get(selected,args.expected_b1)
            if selected == revision:
                expected = args.expected_b1
            assert text('B1') == expected, (selected, text('B1'), expected)
            assert cells['C1'].findtext('s:f', '', ns) == '1+2'
            assert text('C1') == '3' and text('A2') == '12'
            assert cells['A2'].attrib.get('t') not in ['s', 'inlineStr']
        (args.output / f'workbook-r{selected}.xlsx').write_bytes(data)
        records.append({'revision': selected, 'sha256': hashlib.sha256(data).hexdigest(), 'fidelity': fidelity, 'a1': text('A1'), 'b1': text('B1'), 'formula': '1+2', 'numericA2': '12'})
        browser = args.output / f'browser-reader-r{selected}.xlsx'
        if browser.exists():
            with zipfile.ZipFile(browser) as actual, zipfile.ZipFile(io.BytesIO(data)) as expected:
                assert {name: actual.read(name) for name in actual.namelist()} == {name: expected.read(name) for name in expected.namelist()}
    archive, _ = read(f'/export/hcdz?revision={revision}')
    (args.output / 'workbook.hcdz').write_bytes(archive)
    with tempfile.TemporaryDirectory(prefix='hcd-workbook-offline-') as directory:
        unpacked = Path(directory) / 'unpacked.hcd'
        for arguments in [['unpack', str(args.output / 'workbook.hcdz'), '--output', str(unpacked)], ['validate', str(unpacked)]]:
            subprocess.run([str(repo / 'target/debug/officecli'), 'hdoc', *arguments, '--json'], check=True, capture_output=True, timeout=60)
        for path in unpacked.rglob('*'):
            if path.is_file():
                relative = path.relative_to(unpacked)
                assert path.read_bytes() == (root / 'book.hcd' / relative).read_bytes(), str(relative)
    output = {'revision': revision, 'xlsx': records, 'offlineHistoryAndResources': 'verified exact', 'readOnlyDownloads': True}
    (args.output / 'native-and-files.json').write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(output, ensure_ascii=False))


if __name__ == '__main__':
    main()
