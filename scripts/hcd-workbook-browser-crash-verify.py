#!/usr/bin/env python3
"""Independently inspect the XLSX and HCDZ from an owned crash fixture."""
import hashlib, json, subprocess, sys, tempfile, zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

repo=Path(__file__).resolve().parents[1]
root=Path(sys.argv[1]).resolve();out=Path(sys.argv[2]).resolve()
assert root.parent==repo/'target/hcd-preview-runtime' and root.name.startswith('hcd-workbook-')
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(out/'restored.xlsx') as archive:
    sheet=ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    strings=[]
    if 'xl/sharedStrings.xml' in archive.namelist(): strings=[''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
    cells={node.attrib['r']:node for node in sheet.findall('.//s:c',ns)}
    def value(address):
        cell=cells[address]
        if cell.attrib.get('t')=='s': return strings[int(cell.findtext('s:v','',ns))]
        if cell.attrib.get('t')=='inlineStr': return ''.join(node.text or '' for node in cell.findall('.//s:t',ns))
        return cell.findtext('s:v','',ns)
    assert value('A1')=='Original Alice' and value('B1')=='崩溃未确认😀'
    assert cells['C1'].findtext('s:f','',ns)=='1+2' and value('C1')=='3' and value('A2')=='12'
with tempfile.TemporaryDirectory(prefix='hcd-crash-offline-') as temp:
    offline=Path(temp)/'offline.hcd'
    def cli(*args):
        result=subprocess.run([str(repo/'target/debug/officecli'),'hdoc',*map(str,args),'--json'],capture_output=True,text=True,check=True,timeout=60)
        return json.loads(result.stdout)['data']
    cli('unpack',out/'restored.hcdz','--output',offline);assert cli('validate',offline)['valid']
    for file in offline.rglob('*'):
        if file.is_file(): assert file.read_bytes()==(root/'book.hcd'/file.relative_to(offline)).read_bytes()
report={'revision':1,'xlsxB1':'崩溃未确认😀','otherCellsAndFormulaPreserved':True,'hcdzValidated':True,'offlineBytesMatchFixture':True,'xlsxSha256':hashlib.sha256((out/'restored.xlsx').read_bytes()).hexdigest(),'hcdzSha256':hashlib.sha256((out/'restored.hcdz').read_bytes()).hexdigest()}
(out/'files.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False))
