"""Regenerate the small public OOXML pagination fixture next to this script."""
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def paragraph(text, properties=''):
    return f'<w:p><w:pPr>{properties}</w:pPr><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def section(width, height, first=False):
    refs = ''.join(f'<w:headerReference w:type="{kind}" r:id="{rid}"/>'
                   for kind, rid in [('default', 'h'), ('first', 'hf'), ('even', 'he')]) if first else ''
    if first:
        refs += ''.join(f'<w:footerReference w:type="{kind}" r:id="f"/>' for kind in ['default', 'first', 'even'])
    return f'<w:sectPr>{refs}<w:pgSz w:w="{width}" w:h="{height}"/><w:pgMar w:top="900" w:left="600" w:right="600" w:bottom="900" w:header="200" w:footer="200"/>{"<w:titlePg/>" if first else ""}</w:sectPr>'


rows = []
for i in range(31):
    properties = '<w:trPr><w:trHeight w:val="400"/>' + ('<w:tblHeader/>' if i == 0 else '') + '</w:trPr>'
    merge = '<w:vMerge w:val="restart"/>' if i == 2 else '<w:vMerge/>' if i == 3 else ''
    left = paragraph('MERGED' if i == 2 else '' if i == 3 else f'ROW {i:02}')
    rows.append(f'<w:tr>{properties}<w:tc><w:tcPr>{merge}</w:tcPr>{left}</w:tc><w:tc>{paragraph(f"Value {i:02}")}</w:tc></w:tr>')
table = '<w:tbl><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>' + ''.join(rows) + '</w:tbl>'
long_text = ('Unicode \U0001f642 paragraph keeps every character. ' * 120).strip()
body = paragraph('COVER TITLE', '<w:jc w:val="center"/>')
body += '<w:p><w:r><w:t>COVER END</w:t><w:br w:type="page"/><w:t>SECOND PAGE START</w:t></w:r></w:p>'
body += table + paragraph(long_text)
body += '<w:p><w:pPr>' + section(6000, 8000, True) + '</w:pPr></w:p>'
body += paragraph('LANDSCAPE START') + paragraph('Landscape text stays in section two.') + section(8000, 6000)

footer = paragraph('Page ')
footer = footer.replace('</w:p>', ''.join(
    f'<w:fldSimple w:instr="{field}"><w:r><w:t>{cache}</w:t></w:r></w:fldSimple>{"<w:r><w:t> / </w:t></w:r>" if field == "PAGE" else ""}'
    for field, cache in [('PAGE', '999'), ('NUMPAGES', '888')]) + '</w:p>')
parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + ''.join(
        f'<Override PartName="/word/{name}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{content}+xml"/>'
        for name, content in [('document', 'document.main'), ('styles', 'styles'), ('settings', 'settings'), ('header1', 'header'), ('header-first', 'header'), ('header-even', 'header'), ('footer1', 'footer')]) + '</Types>',
    '_rels/.rels': f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="office" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}</w:body></w:document>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(
        f'<Relationship Id="{rid}" Type="{R}/{kind}" Target="{target}.xml"/>' for rid, kind, target in [('h', 'header', 'header1'), ('hf', 'header', 'header-first'), ('he', 'header', 'header-even'), ('f', 'footer', 'footer1'), ('s', 'styles', 'styles'), ('settings', 'settings', 'settings')]) + '</Relationships>',
    'word/styles.xml': f'<w:styles xmlns:w="{W}"><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style></w:styles>',
    'word/settings.xml': f'<w:settings xmlns:w="{W}"><w:evenAndOddHeaders/></w:settings>',
    'word/footer1.xml': f'<w:ftr xmlns:w="{W}">{footer}</w:ftr>',
}
for name, text in [('header1', 'DEFAULT HEADER'), ('header-first', 'FIRST HEADER'), ('header-even', 'EVEN HEADER')]:
    parts[f'word/{name}.xml'] = f'<w:hdr xmlns:w="{W}">{paragraph(text)}</w:hdr>'

with ZipFile(Path(__file__).with_suffix('.docx'), 'w') as package:
    for name, xml in parts.items():
        info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        package.writestr(info, '<?xml version="1.0" encoding="UTF-8"?>' + xml)
