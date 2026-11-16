"""Public synthetic rich-string workbook; no Office installation required."""
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def make_fixture(target):
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    rich = ('<r><rPr><rFont val="Arial"/><b/><color rgb="FFCC2244"/><sz val="18"/></rPr><t>中文😀</t></r>'
            '<r><rPr><b val="0"/><i val="0"/><color rgb="FF2255AA"/><sz val="11"/></rPr><t xml:space="preserve"> normal </t></r>'
            '<r><rPr><i/><u/><scheme val="minor"/></rPr><t>斜体</t></r>')
    parts = {
        '[Content_Types].xml': f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
        '_rels/.rels': f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Rich text" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{rel}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="{rel}/styles" Target="styles.xml"/></Relationships>',
        'xl/styles.xml': f'<styleSheet xmlns="{ns}"><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>',
        'xl/sharedStrings.xml': f'<sst xmlns="{ns}" count="2" uniqueCount="2"><si>{rich}<rPh sb="0" eb="2"><t>zhongwen</t></rPh></si><si><r><rPr><b val="0"/><i/><color theme="4" tint="0.25"/></rPr><t>中文😀</t></r><r><t xml:space="preserve"> normal 斜体</t></r></si></sst>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{ns}"><dimension ref="A1:C4"/><sheetFormatPr defaultRowHeight="36"/><cols><col min="1" max="1" width="52" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is>{rich}</is></c><c r="B1"><v>2</v></c><c r="C1"><f>LEN(A1)</f><v>13</v></c></row><row r="2"><c r="A2" t="s"><v>0</v></c></row><row r="3"><c r="A3" t="s"><v>1</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>Plain string</t></is></c></row></sheetData></worksheet>',
    }
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(target, 'w', compression=ZIP_DEFLATED) as archive:
        for name, xml in parts.items():
            archive.writestr(name, '<?xml version="1.0" encoding="UTF-8"?>' + xml)


if __name__ == '__main__':
    make_fixture(sys.argv[1])
