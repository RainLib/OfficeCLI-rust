"""Public long-document regression: several tables, styled paragraphs and running margins."""
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED
import sys


def paragraph(text):
    return ('<w:p><w:pPr><w:spacing w:after="160" w:line="280" w:lineRule="auto"/>'
            '<w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr>'
            f'<w:t>{escape(text)}</w:t></w:r></w:p>')


def table(number):
    rows = []
    for row in range(40):
        cells = []
        for column in range(8):
            text = f'T{number} R{row:02} C{column} 备件及规格'
            cells.append('<w:tc><w:tcPr><w:tcW w:w="1100" w:type="dxa"/></w:tcPr>'
                         + paragraph(text) + '</w:tc>')
        rows.append('<w:tr>' + ''.join(cells) + '</w:tr>')
    borders = ''.join(f'<w:{edge} w:val="single" w:sz="4"/>'
                      for edge in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'])
    return ('<w:tbl><w:tblPr><w:tblW w:w="8800" w:type="dxa"/><w:tblBorders>'
            + borders + '</w:tblBorders></w:tblPr><w:tblGrid>'
            + '<w:gridCol w:w="1100"/>' * 8 + '</w:tblGrid>' + ''.join(rows) + '</w:tbl>')


body = ''.join(paragraph(f'Clause {i:03}: public document layout and table regression. '
                         'Keep paragraph typography and viewport stable during structural edits.')
               for i in range(250))
body += ''.join(paragraph(f'Table {i}') + table(i) for i in range(4))
body += '<w:sectPr>' + ''.join(
    f'<w:headerReference w:type="{variant}" r:id="{rid}"/>'
    for variant, rid in [('default', 'h'), ('first', 'hf'), ('even', 'he')])
body += '<w:footerReference w:type="default" r:id="f"/>'
body += ('<w:pgSz w:w="11906" w:h="16838"/>'
         '<w:pgMar w:top="1440" w:left="1440" w:right="1440" w:bottom="1440" '
         'w:header="400" w:footer="400"/></w:sectPr>')
document = ('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<w:body>' + body + '</w:body></w:document>')
with ZipFile(Path(__file__).with_name('word-page-layout.docx')) as source, ZipFile(sys.argv[1], 'w', ZIP_DEFLATED) as output:
    for entry in source.infolist():
        data = document.encode() if entry.filename == 'word/document.xml' else source.read(entry.filename)
        output.writestr(entry, data)
