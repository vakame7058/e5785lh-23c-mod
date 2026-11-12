import math, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter
B='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
def f(sz): return ImageFont.truetype(B, sz)
W,R,BL,GOLD=(255,255,255),(213,43,30),(0,57,166),(255,200,40)
SKY=(4,6,24)
def q565(im):
    o=Image.new('RGB',im.size); o.putdata([((r>>3)<<3,(g>>2)<<2,(b>>3)<<3) for r,g,b in im.getdata()]); return o
def ctext(d,y,t,sz,fill=W,cx=64):
    fo=f(sz); w=d.textlength(t,font=fo); d.text((cx-w/2,y),t,font=fo,fill=fill)
rnd=random.Random(7); STARS=[(rnd.randrange(128),rnd.randrange(128),rnd.choice([110,160,230])) for _ in range(60)]
def sky(d,ymax=128):
    for x,y,c in STARS:
        if y<ymax: d.point((x,y),fill=(c,c,c))
def star(d,cx,cy,r,fill,outline=None):
    pts=[(cx+r*(1 if i%2==0 else .42)*math.sin(i*math.pi/5), cy-r*(1 if i%2==0 else .42)*math.cos(i*math.pi/5)) for i in range(10)]
    d.polygon(pts,fill=fill,outline=outline)
# А. Шлем «СССР»
def A():
    im=Image.new('RGB',(128,128),SKY); d=ImageDraw.Draw(im); sky(d)
    d.rounded_rectangle([34,96,94,118],radius=8,fill=(150,150,160))        # шейное кольцо
    d.ellipse([22,14,106,104],fill=(236,236,240))                            # шлем
    d.ellipse([22,14,106,104],outline=(180,180,190),width=2)
    d.chord([30,40,98,100],0,360,fill=(20,30,60))                            # стекло
    d.ellipse([30,40,98,100],outline=(120,120,130),width=3)
    d.polygon([(42,52),(54,48),(46,70)],fill=(90,120,180))                   # блик
    d.line([(80,56),(86,66)],fill=(70,100,160),width=2)
    ctext(d,19,'СССР',15,R)
    return im
# Б. Эмблема «Восток»
def Bv():
    im=Image.new('RGB',(128,128),SKY); d=ImageDraw.Draw(im); sky(d)
    d.ellipse([10,6,118,114],fill=GOLD); d.ellipse([15,11,113,109],fill=(10,40,120))
    d.ellipse([15,11,113,109],outline=(255,230,120))
    d.arc([22,40,106,96],200,340,fill=(120,170,255),width=2)                 # орбита
    star(d,64,26,9,R,GOLD)
    r=Image.new('RGBA',(20,46),(0,0,0,0)); rd=ImageDraw.Draw(r)
    rd.polygon([(10,0),(5,10),(15,10)],fill=W); rd.rectangle([5,10,15,32],fill=W)
    rd.polygon([(5,24),(0,36),(5,34)],fill=W); rd.polygon([(15,24),(20,36),(15,34)],fill=W)
    rd.polygon([(7,33),(13,33),(10,44)],fill=(255,150,30))
    r=r.rotate(-35,resample=Image.NEAREST,expand=True); im.paste(r,(52,36),r)
    d=ImageDraw.Draw(im); ctext(d,80,'ВОСТОК',14,W); ctext(d,96,'1961',9,GOLD)
    return im
# В. Пульт «ПУСК»
def C():
    im=Image.new('RGB',(128,128),(50,54,58)); d=ImageDraw.Draw(im)
    for i in range(-128,256,12): d.polygon([(i,0),(i+6,0),(i+6-128,128),(i-128,128)],fill=(230,190,20))
    d.rectangle([8,8,119,119],fill=(62,66,72)); d.rectangle([8,8,119,119],outline=(30,30,34),width=2)
    for i,c in enumerate([(40,200,70),(40,200,70),(255,170,0)]):             # лампы
        d.ellipse([20+i*14,16,28+i*14,24],fill=c)
    d.rectangle([84,15,110,26],fill=(20,24,20)); d.text((86,15),'00:03',font=f(9),fill=(80,255,120))
    d.ellipse([28,34,100,106],fill=(110,20,15)); d.ellipse([32,36,96,100],fill=(220,40,30))
    d.ellipse([40,42,70,62],fill=(245,110,90))
    ctext(d,60,'ПУСК',17,W)
    return im
# Г. Старт издали ночью
def D():
    im=Image.new('RGB',(128,128)); d=ImageDraw.Draw(im)
    for y in range(128):
        t=y/127; d.line([(0,y),(127,y)],fill=(int(4+14*t),int(6+16*t),int(24+46*t)))
    sky(d,90)
    beam=Image.new('RGBA',(128,128),(0,0,0,0)); bd=ImageDraw.Draw(beam)
    for x0,x1 in ((18,52),(110,76)):
        bd.polygon([(x0,112),(x1-8,6),(x1+8,6)],fill=(255,250,210,40))
    im.paste(beam,(0,0),beam); d=ImageDraw.Draw(im)
    d.rectangle([0,110,127,127],fill=(12,12,16))
    d.rectangle([58,40,70,100],fill=(225,225,230)); d.polygon([(58,40),(70,40),(64,24)],fill=(225,225,230))
    d.polygon([(58,86),(50,104),(58,100)],fill=R); d.polygon([(70,86),(78,104),(70,100)],fill=R)
    d.rectangle([58,62,70,65],fill=R)
    for x0 in (46,76):
        d.rectangle([x0,46,x0+5,108],outline=(160,60,40))
        for y in range(46,108,5): d.line([(x0,y),(x0+5,y+5)],fill=(160,60,40))
    d.rectangle([44,104,84,110],fill=(80,80,90))
    for x in (18,110): d.ellipse([x-3,109,x+3,115],fill=(255,250,210))
    d.point((64,23),fill=(255,60,60))
    return im
ims=[q565(x()) for x in (A,Bv,C,D)]; labels=['А. Шлем «СССР»','Б. Эмблема «Восток»','В. Пульт «ПУСК»','Г. Старт ночью, издали']
for i,x in enumerate(ims): x.save(f'logo2_{"ABCD"[i]}.png')
S=3; sheet=Image.new('RGB',(2*128*S+60,2*(128*S+40)+20),(40,40,40)); sd=ImageDraw.Draw(sheet)
for i,x in enumerate(ims):
    cx=20+(i%2)*(128*S+20); cy=10+(i//2)*(128*S+40)
    sheet.paste(x.resize((128*S,128*S),Image.NEAREST),(cx,cy+30)); sd.text((cx,cy+4),labels[i],font=f(20),fill=W)
sheet.save('logo2_variants.png'); print('ok')
