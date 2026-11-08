#!/usr/bin/env python3
"""Inspect the DOCX produced by the isolated outline snapshot scenario."""
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

path = Path(sys.argv[1]).resolve()
ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
with zipfile.ZipFile(path) as archive:
    root = ET.fromstring(archive.read('word/document.xml'))
    paragraphs = [''.join(node.text or '' for node in paragraph.findall('.//w:t', ns))
                  for paragraph in root.findall('.//w:p', ns)]
    assert any('Outline Sample' in paragraph for paragraph in paragraphs)
    assert any('• Outline Sample' in paragraph for paragraph in paragraphs)
result = {'scope': 'isolated synthetic semantic DOCX export', 'headingAndSnapshotTextVerified': True,
          'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
(path.parent / 'readback.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
