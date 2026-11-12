import math, random
from PIL import Image, ImageDraw, ImageFont
B='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
def f(sz): return ImageFont.truetype(B, sz)
W,R,BL=(255,255,255),(213,43,30),(0,57,166)
SKY=(4,6,24)
def q565(im):
    o=Image.new('RGB',im.size); o.putdata([((r>>3)<<3,(g>>2)<<2,(b>>3)<<3) for r,g,b in im.getdata()]); return o
def ctext(d,y,t,sz,fill=W):
    fo=f(sz); w=d.textlength(t,font=fo); d.text(((128-w)/2,y),t,font=fo,fill=fill)
STARS=[(random.Random(7).randrange(128),0) for _ in range(0)]
rnd=random.Random(7); STARS=[(rnd.randrange(128),rnd.randrange(100),rnd.choice([110,160,230])) for _ in range(60)]
def sky(d,ymax=128):
    for x,y,c in STARS:
        if y<ymax: d.point((x,y),fill=(c,c,c))
def moon(d,x=8,y=8,r=14):
    d.ellipse([x,y,x+2*r,y+2*r],fill=(200,205,215)); d.ellipse([x+6,y+6,x+12,y+12],fill=(165,170,180)); d.ellipse([x+16,y+16,x+21,y+21],fill=(165,170,180))
def rocket(flame=0):
    r=Image.new('RGBA',(30,64),(0,0,0,0)); d=ImageDraw.Draw(r)
    d.polygon([(15,0),(9,14),(21,14)],fill=(230,230,235))
    d.rectangle([9,14,21,42],fill=(238,238,242)); d.rectangle([9,26,21,29],fill=R)
    d.ellipse([12,17,18,23],fill=(90,140,220))
    d.polygon([(9,34),(2,48),(9,45)],fill=R); d.polygon([(21,34),(28,48),(21,45)],fill=R)
    d.rectangle([12,42,18,45],fill=(120,120,130))
    if flame:
        L=6+flame*5
        d.polygon([(11,45),(19,45),(15,45+L)],fill=(255,140,30)); d.polygon([(13,45),(17,45),(15,45+L*0.65)],fill=(255,235,120))
    return r
def pad(d,full=True):
    d.rectangle([0,112,127,127],fill=(30,30,40))                       # ground
    d.rectangle([44,106,84,112],fill=(90,90,100))                      # pad
    if full:
        for x0 in (40,80):                                             # service towers
            d.rectangle([x0,52,x0+7,106],outline=(200,60,40))
            for y in range(52,106,6): d.line([(x0,y),(x0+7,y+6)],fill=(200,60,40))
            d.line([(x0+3 if x0==40 else x0+4,70),(x0+8 if x0==40 else x0-1,70)],fill=(180,180,180))
def frame(rocket_xy=None, angle=0, flame=0, towers=True, smoke=0, text=None, padshow=True, small=False):
    im=Image.new('RGB',(128,128),SKY); d=ImageDraw.Draw(im); sky(d); moon(d)
    if padshow: pad(d,towers)
    if smoke:
        for i in range(smoke):
            rr=6+i*2; cx=64+(-1)**i*(8+i*4); d.ellipse([cx-rr,110-rr,cx+rr,110+rr//2],fill=(150,150,160))
    if rocket_xy:
        sp=rocket(flame)
        if small: sp=sp.resize((15,32),Image.NEAREST)
        sp=sp.rotate(-angle,resample=Image.NEAREST,expand=True)
        x,y=rocket_xy; im.paste(sp,(int(x-sp.width/2),int(y-sp.height/2)),sp)
    if text: ctext(d,text[1],text[0],text[2])
    return im
# логотип (раздел logo, цвет, статичный)
logo=frame((64,78),towers=True,text=('КЛЮЧ НА СТАРТ',114,11))
# анимация Welcome
seq=[
 frame((64,78)),
 frame((64,78),flame=1),
 frame((64,78),flame=2,smoke=2),
 frame((64,70),flame=3,smoke=4),
 frame((64,56),flame=3,smoke=5),
 frame((66,40),angle=8,flame=3,smoke=5),
 frame((74,26),angle=20,flame=3,padshow=False),
 frame((90,14),angle=35,flame=3,padshow=False),
 frame((108,4),angle=45,flame=2,padshow=False),
 frame(None,padshow=False,text=('ПОЕХАЛИ!',84,17)),
 frame((96,40),angle=45,flame=1,padshow=False,small=True,text=('ПОЕХАЛИ!',84,17)),
]
logo=q565(logo); seq=[q565(x) for x in seq]
logo.save('poehali_logo.png'); [x.save(f'poehali_{i:02d}.png') for i,x in enumerate(seq)]
def mono(im):
    g=im.convert('L'); return g.point(lambda v:255 if v>70 else 0).convert('RGB')
monos=[mono(x) for x in seq]
S=2; cols=6
def sheet(imgs,labels,name):
    rows=(len(imgs)+cols-1)//cols; sh=Image.new('RGB',(cols*(128*S+10)+10,rows*(128*S+30)+10),(40,40,40)); sd=ImageDraw.Draw(sh)
    for i,x in enumerate(imgs):
        cx=10+(i%cols)*(128*S+10); cy=10+(i//cols)*(128*S+30)
        sh.paste(x.resize((128*S,128*S),Image.NEAREST),(cx,cy+22)); sd.text((cx,cy),labels[i],font=f(14),fill=W)
    sh.save(name)
sheet([logo]+seq,['логотип (раздел logo)']+[f'Welcome кадр {i+1}' for i in range(len(seq))],'poehali_color.png')
sheet(monos,[f'Welcome 1 бит, кадр {i+1}' for i in range(len(seq))],'poehali_mono.png')
big=[x.resize((256,256),Image.NEAREST) for x in [logo]+seq]
dur=[1500]+[250]*9+[700,1500]
big[0].save('poehali_color.gif',save_all=True,append_images=big[1:],duration=dur,loop=0)
bm=[x.resize((256,256),Image.NEAREST) for x in monos]
bm[0].save('poehali_mono.gif',save_all=True,append_images=bm[1:],duration=dur[1:],loop=0)
print('ok')
