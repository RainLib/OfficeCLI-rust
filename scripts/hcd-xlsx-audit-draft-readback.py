#!/usr/bin/env python3
"""Inspect the XLSX exported by the isolated audit/draft browser scenario."""
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

path = Path(sys.argv[1]).resolve()
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(path) as archive:
    sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    strings = ([''.join(item.itertext()) for item in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
               if 'xl/sharedStrings.xml' in archive.namelist() else [])
    cells = {item.attrib['r']: item for item in sheet.findall('.//s:c', ns)}

    def value(address):
        cell = cells[address]
        if cell.get('t') == 's':
            return strings[int(cell.findtext('s:v', '', ns))]
        if cell.get('t') == 'inlineStr':
            return ''.join(item.text or '' for item in cell.findall('.//s:t', ns))
        return cell.findtext('s:v', '', ns)

    assert value('A1') == 'Original Alice' and value('B1') == '保护检查草稿😀'
    assert cells['C1'].findtext('s:f', '', ns) == '1+2' and value('C1') == '3' and value('A2') == '12'
report = {'scope': 'synthetic XLSX downloaded from isolated native service', 'b1': value('B1'),
          'otherCellsAndFormulaPreserved': True, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
(path.parent / 'readback.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False))
