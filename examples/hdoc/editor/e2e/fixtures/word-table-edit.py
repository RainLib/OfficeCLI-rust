"""Public table editing fixture: merged cells and differently formatted runs."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

target = Path(__file__).with_suffix('.docx')
with ZipFile(target.with_name('word-page-layout.docx')) as source, ZipFile(target, 'w') as output:
    for name in source.namelist():
        data = source.read(name)
        if name == 'word/document.xml':
            data = data.replace(
                b'<w:r><w:t xml:space="preserve">ROW 00</w:t></w:r>',
                b'<w:r><w:rPr><w:b/><w:color w:val="2457A6"/></w:rPr><w:t xml:space="preserve">ROW </w:t></w:r>'
                b'<w:r><w:rPr><w:i/><w:color w:val="26704D"/></w:rPr><w:t>00</w:t></w:r>', 1)
        info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        output.writestr(info, data)
