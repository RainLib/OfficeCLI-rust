from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
root=Path(__file__).parent
font=Path(__file__).resolve().parents[5]/'crates/pdf-handler/assets/NotoSansSC-Regular.ttf'
base=Image.new('RGBA',(768,512),'#eee7d9')
d=ImageDraw.Draw(base)
for x in range(34,735,17):
 for y in range(33,476,17): d.ellipse((x,y,x+1,y+1),fill='#c7bcaa')
d.rounded_rectangle((48,46,720,466),radius=32,fill='#f8f4e9',outline='#c8c0aa',width=2)
d.text((76,70),'品牌素材校样',font=ImageFont.truetype(str(font),32),fill='#182d36')
d.line((76,122,688,122),fill='#788572',width=2)
d.ellipse((552,335,658,441),fill='#c5d9ca')
d.ellipse((584,335,689,441),outline='#6b8d80',width=3)
d.text((76,419),'图层叠放 · 色彩与透明度',font=ImageFont.truetype(str(font),17),fill='#657568')
base.save(root/'素材原件.png')
red=Image.new('RGBA',(312,196)); d=ImageDraw.Draw(red)
d.rounded_rectangle((0,0,311,195),radius=24,fill='#e28d70',outline='#9d5441',width=3)
d.rounded_rectangle((18,18,294,177),radius=15,outline='#fff2df',width=2)
d.text((35,45),'橙色标识',font=ImageFont.truetype(str(font),24),fill='#502e22')
red.save(root/'橙色卡片.png')
blue=Image.new('RGBA',(204,148)); d=ImageDraw.Draw(blue)
d.rounded_rectangle((0,0,203,147),radius=20,fill='#7397a4',outline='#476a7e',width=3)
d.text((18,27),'蓝色标识',font=ImageFont.truetype(str(font),21),fill='#f3f6ef')
d.line((18,68,182,68),fill='#d5e4db',width=2)
blue.save(root/'蓝色卡片.png')
