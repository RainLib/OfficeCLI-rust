"""Inspect the browser's native XLSX with an independent reader and XML parser."""
import hashlib
import json
from pathlib import Path
import sys
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from openpyxl import load_workbook

root = Path(sys.argv[1])
source = root / "native-conditions-source.xlsx"
saved = root / "native-conditions-roundtrip.xlsx"
book = load_workbook(saved)
sheet = book.active
rules = sheet.conditional_formatting["B2:B4"]
assert len(rules) == 2
assert rules[0].type == "cellIs" and rules[0].operator == "greaterThan"
assert rules[0].formula == ["120"] and rules[0].stopIfTrue
assert rules[1].type == "cellIs" and rules[1].operator == "between"
assert rules[1].formula == ["5", "100"]
assert rules[0].dxf.fill.bgColor.rgb.lower() == "ffc8ecf8"
assert rules[1].dxf.fill.bgColor.rgb.lower() == "ffacd8bd"
assert [sheet[f"B{row}"].value for row in (2, 3, 4)] == [10, 90, 160]
ns = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with ZipFile(source) as before, ZipFile(saved) as after:
    advanced = lambda package: ET.fromstring(package.read("xl/worksheets/sheet1.xml")).find(
        "x:conditionalFormatting[@sqref='C2:C4']", ns)
    assert ET.tostring(advanced(before)) == ET.tostring(advanced(after))
    assert before.read("xl/charts/chart1.xml") == after.read("xl/charts/chart1.xml")
    assert sheet.freeze_panes == "B2"
report = {"nativeRulesReopened": True, "thresholdAndRangeValues": True,
          "unsupportedColorScalePreserved": True, "chartXmlUnchanged": True,
          "frozenPanesPreserved": True,
          "originalSha256": hashlib.sha256(source.read_bytes()).hexdigest()}
(root / "native-verification.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
