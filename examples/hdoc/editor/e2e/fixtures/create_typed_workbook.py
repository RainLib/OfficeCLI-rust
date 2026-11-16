"""Replace a freshly created workbook's first sheet with native literal types.

Usage: officecli create /tmp/types.xlsx && python3 create_typed_workbook.py /tmp/types.xlsx
The empty inline/shared strings and styled blank deliberately look identical.
"""
import sys
import zipfile
import xml.etree.ElementTree as ET

path = sys.argv[1]
ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
tag = lambda name: "{" + ns + "}" + name
worksheet = ET.Element(tag("worksheet"))
ET.SubElement(worksheet, tag("dimension"), ref="A1:B17")
sheet_data = ET.SubElement(worksheet, tag("sheetData"))
literals = {
    1: ("b", "1"),
    2: ("b", "0"),
    3: ("inlineStr", ""),
    4: ("s", "0"),
    5: ("n", None),
    6: ("inlineStr", "#N/A"),
    7: ("e", "#N/A"),
    8: ("inlineStr", "12"),
    9: ("n", "3"),
    10: ("b", "true"),
    11: ("b", "false"),
}
formulas = [
    "SUM(A1:A5)", "COUNT(A1:A9)", "COUNTA(A1:A9)", "COUNTBLANK(A1:A9)",
    "SUM(A1:A9)", "A1=TRUE", "A2=FALSE", "LEN(A6)", "SUM(A8:A9)",
    "SUM(A8,A9)", "1/0", "COUNTA(B11:B11)", "COUNT(B11:B11)",
    "COUNTBLANK(B11:B11)", "COUNTA(A5:A5)",
    "A10=TRUE", "A11=FALSE",
]
for number, formula in enumerate(formulas, start=1):
    row = ET.SubElement(sheet_data, tag("row"), r=str(number))
    if number in literals:
        kind, value = literals[number]
        cell = ET.SubElement(row, tag("c"), r=f"A{number}", t=kind)
        if value is None:
            cell.set("s", "0")
        elif kind == "inlineStr":
            ET.SubElement(ET.SubElement(cell, tag("is")), tag("t")).text = value
        else:
            ET.SubElement(cell, tag("v")).text = value
    cell = ET.SubElement(row, tag("c"), r=f"B{number}")
    ET.SubElement(cell, tag("f")).text = formula
    ET.SubElement(cell, tag("v")).text = "777"  # untrusted cache

strings = ET.Element(tag("sst"), count="1", uniqueCount="1")
ET.SubElement(ET.SubElement(strings, tag("si")), tag("t")).text = ""
with zipfile.ZipFile(path) as archive:
    entries = [(item, archive.read(item.filename)) for item in archive.infolist()]
with zipfile.ZipFile(path, "w") as archive:
    for item, data in entries:
        if item.filename == "xl/worksheets/sheet1.xml":
            data = ET.tostring(worksheet, encoding="utf-8", xml_declaration=True)
        elif item.filename == "xl/_rels/workbook.xml.rels":
            root = ET.fromstring(data)
            ET.SubElement(root, "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship",
                          Id="rIdTypedStrings", Target="sharedStrings.xml",
                          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings")
            data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        elif item.filename == "[Content_Types].xml":
            root = ET.fromstring(data)
            ET.SubElement(root, "{http://schemas.openxmlformats.org/package/2006/content-types}Override",
                          PartName="/xl/sharedStrings.xml",
                          ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml")
            data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        if item.filename != "xl/sharedStrings.xml":
            archive.writestr(item, data)
    archive.writestr("xl/sharedStrings.xml", ET.tostring(strings, encoding="utf-8", xml_declaration=True))
