"""Public grid/anchor fixture; regenerate after word-page-layout.py."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
from struct import pack
import zlib
from xml.sax.saxutils import escape

HERE = Path(__file__).parent
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
with ZipFile(HERE / 'word-page-layout.docx') as base:
    parts = {name: base.read(name) for name in base.namelist()}


def paragraph(text, properties='', run=''):
    return f'<w:p><w:pPr>{properties}</w:pPr><w:r><w:rPr>{run}</w:rPr><w:t>{escape(text)}</w:t></w:r></w:p>'


def section(width, height, grid, header=False):
    refs = '<w:headerReference w:type="default" r:id="h"/>' if header else ''
    return f'<w:sectPr>{refs}<w:pgSz w:w="{width}" w:h="{height}"/><w:pgMar w:top="900" w:left="600" w:right="600" w:bottom="900" w:header="600" w:footer="200"/><w:docGrid w:type="{grid[0]}" w:linePitch="{grid[1]}"/></w:sectPr>'


body = paragraph('GRID SINGLE')
body += paragraph('GRID OFF', '<w:snapToGrid w:val="0"/>')
body += paragraph('GRID INHERITED OFF', '<w:pStyle w:val="OffChild"/>')
body += paragraph('GRID INHERITED AUTO', '<w:pStyle w:val="AutoChild"/>')
body += paragraph('GRID EXACT', '<w:spacing w:line="120" w:lineRule="exact"/>')
body += paragraph('GRID MINIMUM', '<w:spacing w:line="240" w:lineRule="atLeast"/>')
body += paragraph('GRID LARGE', run='<w:sz w:val="60"/>')
body += '<w:p><w:pPr><w:rPr><w:sz w:val="60"/></w:rPr></w:pPr></w:p>'
body += '<w:tbl><w:tr><w:tc>' + paragraph('CELL NATURAL') + '</w:tc><w:tc>' + paragraph('CELL GRID', '<w:snapToGrid/>') + '</w:tc></w:tr></w:tbl>'
body += '<w:p><w:pPr>' + section(6000, 12000, ('lines', 408), True) + '</w:pPr></w:p>'
body += paragraph('GRID SECOND') + '<w:p><w:pPr>' + section(8000, 6000, ('linesAndChars', 360)) + '</w:pPr></w:p>'
body += paragraph('GRID DISABLED') + section(6000, 8000, ('none', 408))
parts['word/document.xml'] = f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}</w:body></w:document>'
parts['word/styles.xml'] = f'''<w:styles xmlns:w="{W}">
<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:rPr><w:rFonts w:ascii="Times New Roman"/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Off"><w:pPr><w:snapToGrid w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="OffChild"><w:basedOn w:val="Off"/></w:style>
<w:style w:type="paragraph" w:styleId="ExactBase"><w:pPr><w:spacing w:line="120" w:lineRule="exact"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="AutoChild"><w:basedOn w:val="ExactBase"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Header"><w:basedOn w:val="Off"/><w:rPr><w:sz w:val="18"/></w:rPr></w:style>
</w:styles>'''
parts['word/settings.xml'] = f'<w:settings xmlns:w="{W}"/>'
parts['word/header1.xml'] = f'''<w:hdr xmlns:w="{W}" xmlns:r="{R}" xmlns:wp="wp" xmlns:a="a">
<w:p><w:pPr><w:pStyle w:val="Header"/><w:rPr><w:sz w:val="48"/></w:rPr></w:pPr>
<w:r><w:rPr><w:sz w:val="48"/></w:rPr><w:drawing><wp:anchor layoutInCell="1" behindDoc="1">
<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>
<wp:positionV relativeFrom="margin"><wp:posOffset>-952500</wp:posOffset></wp:positionV>
<wp:extent cx="609600" cy="609600"/><wp:docPr id="1" descr="Public letterhead"/>
<a:graphic><a:blip r:embed="image"/></a:graphic></wp:anchor></w:drawing></w:r></w:p></w:hdr>'''
parts['word/_rels/header1.xml.rels'] = f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Type="{R}/image" Target="media/public-grid.png"/></Relationships>'
# Opaque white paper with a blue square, so clipping can be checked by geometry.
def chunk(kind, data):
    return pack('>I', len(data)) + kind + data + pack('>I', zlib.crc32(kind + data) & 0xffffffff)
raw = b''.join(b'\0' + b''.join(bytes((40, 100, 210)) if 16 <= x < 48 and 16 <= y < 48 else b'\xff\xff\xff' for x in range(64)) for y in range(64))
parts['word/media/public-grid.png'] = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
parts['[Content_Types].xml'] = parts['[Content_Types].xml'].decode().replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>')
with ZipFile(Path(__file__).with_suffix('.docx'), 'w') as package:
    for name, data in parts.items():
        info = ZipInfo(name, (2026, 1, 1, 0, 0, 0)); info.compress_type = ZIP_DEFLATED
        package.writestr(info, data.encode() if isinstance(data, str) else data)
