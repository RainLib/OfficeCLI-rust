from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.lib.colors import HexColor

root=Path(__file__).parent
FONT=Path(__file__).resolve().parents[5]/'crates/pdf-handler/assets/NotoSansSC-Regular.ttf'
def photograph(w,h,content, label):
    # Bitmap only. The source PDF has no text operators for these phrases.
    scale=3
    im=Image.new('RGB',(w*scale,h*scale),'#fcfbf4')
    paint=ImageDraw.Draw(im)
    paint.rounded_rectangle((36*scale,36*scale,(w-36)*scale,(h-40)*scale),radius=10*scale,fill='#ffffff',outline='#d3dace',width=2*scale)
    paint.line((65*scale,122*scale,(w-65)*scale,122*scale),fill='#4c7c73',width=2*scale)
    for y,text,size in content:
        font=ImageFont.truetype(str(FONT),size*scale)
        paint.text((65*scale,y*scale),text,font=font,fill='#18322d',anchor='lt')
    im.save(root/f'{label}.png')
    return ImageReader(im)
main=photograph(612,792,[(63,'工作坊发布评审',35),(158,'Release Review Checklist',26),(211,'请确认试点团队和发布时间。',25),(268,'华东计划于十一月二十日启动。',25),(347,'Delivery code TEAM 2046',22),(425,'统一收集反馈并完成归档。',25)],'scan-one')
mixed=photograph(612,612,[(63,'Training agenda',30),(158,'场地签到表和课程资料',27),(260,'Registration closes at 09:30',24),(360,'请携带学习手册。',24)],'scan-mixed')
rotated=photograph(742,572,[(63,'Rotated scan document',30),(165,'第二场培训安排',29),(233,'Session number 8135',24),(330,'请提前十分钟入场。',25)],'scan-rotated')
raw=root/'page-source.pdf'
c=canvas.Canvas(str(raw),pagesize=(612,792),pageCompression=1)
c.setTitle('Scanned release review')
c.drawImage(main,0,0,612,792)
c.showPage()
c.setFont('Helvetica',22)
c.setFillColor(HexColor('#173825'))
c.drawString(64,740,'Native header read once')
c.drawImage(mixed,0,60,612,612)
c.showPage()
c.saveState()
c.translate(592,25)
c.rotate(90)
c.drawImage(rotated,0,0,742,572)
c.restoreState()
c.showPage()
c.save()
writer=PdfWriter(clone_from=str(raw))
p=writer.pages[2]
p.cropbox.lower_left=(20,25)
p.cropbox.upper_right=(592,767)
p.rotate(90)
dest=root/'workshop-scan.pdf'
with dest.open('wb') as file: writer.write(file)
reader=PdfReader(str(dest))
assert len(reader.pages)==3
assert not reader.pages[0].extract_text().strip()
assert reader.pages[1].extract_text().strip()=='Native header read once'
assert not reader.pages[2].extract_text().strip()
