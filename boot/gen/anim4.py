import sys, math, os; sys.path.insert(0,'.')
import anim, anim2
from PIL import Image, ImageDraw
q=anim.q565; scene=anim2.scene; lerp=anim2.lerp

import random as _r
_rnd=_r.Random(5)
R2=(213,43,30)
def rocket2(flame=0):
    r=Image.new('RGBA',(30,80),(0,0,0,0)); d=ImageDraw.Draw(r)
    d.polygon([(15,0),(9,14),(21,14)],fill=(230,230,235))
    d.rectangle([9,14,21,42],fill=(238,238,242)); d.rectangle([9,26,21,29],fill=R2)
    d.ellipse([12,17,18,23],fill=(90,140,220))
    d.polygon([(9,34),(2,48),(9,45)],fill=R2); d.polygon([(21,34),(28,48),(21,45)],fill=R2)
    d.rectangle([12,42,18,45],fill=(120,120,130))
    if flame:
        if flame>=3:                                   # после отрыва: длинное рваное пламя и искры
            L=18+_rnd.randint(0,12); w=4+_rnd.randint(0,2); sway=_rnd.randint(-2,2)
            d.polygon([(15-w-1,45),(15+w+1,45),(15+sway,45+L)],fill=(230,70,20))
            d.polygon([(15-w,45),(15+w,45),(15+sway//2,45+int(L*0.8))],fill=(255,150,30))
            d.polygon([(13,45),(17,45),(15,45+int(L*0.5))],fill=(255,240,140))
            for _ in range(_rnd.randint(3,6)):
                sx=15+_rnd.randint(-6,6); sy=45+L+_rnd.randint(-6,8)
                if sy<80: d.point((sx,sy),fill=_rnd.choice([(255,200,60),(255,120,30),(255,240,160)]))
        else:
            L=6+flame*5
            d.polygon([(11,45),(19,45),(15,45+L)],fill=(255,140,30)); d.polygon([(13,45),(17,45),(15,45+L*0.65)],fill=(255,235,120))
    return r
anim.rocket=rocket2
WH,BL,RD=(255,255,255),(0,57,166),(213,43,30)
TY=70
def flag(im,phase,k=1.0,x0=28,x1=100,y0=97,h=18):
    p=im.load()
    for y in range(y0-3,128):                               # древко
        for xx in (x0-2,x0-1):
            bg=p[xx,y]; c=(175,175,185); p[xx,y]=tuple(int(bg[i]*(1-k)+c[i]*k) for i in range(3))
    for x in range(x0,x1):
        u=(x-x0)/(x1-x0)
        off=3.0*math.sin(2*math.pi*(u*1.1)-phase)*(0.15+0.85*u)      # у древка почти не колышется
        shade=0.86+0.14*math.cos(2*math.pi*(u*1.1)-phase)
        for yy in range(h):
            y=int(round(y0+yy+off))
            if not 0<=y<128: continue
            c=WH if yy<h/3 else (BL if yy<2*h/3 else RD)
            bg=p[x,y]
            p[x,y]=tuple(int(bg[i]*(1-k)+c[i]*shade*k) for i in range(3))
K=[(64,86,0,0,0,0),(64,86,0,1,0,0),(64,86,0,2,2,0),(64,78,0,3,4,0),(64,64,0,3,5,0),
   (66,47,8,3,5,8),(76,33,20,3,5,30),(94,20,35,3,5,60),(114,10,45,3,5,90),(132,-6,45,3,5,90),(154,-28,45,3,5,90)]
frames=[]; dur=[]
for i in range(len(K)-1):
    for s in range(4):
        t=s/4; p=[lerp(K[i][j],K[i+1][j],t) for j in range(6)]
        flick=(len(frames)//2)%2 if p[3]>=2.5 else 0
        frames.append(scene(*p,flick=flick)); dur.append(60)
ph=0.0
for n,c in enumerate((40,80,120,160,200,255)):              # надпись и флаг проявляются вместе
    im=scene(0,0,0,0,0,90,0,rocket=False); anim.ctext(ImageDraw.Draw(im),TY,'ПОЕХАЛИ!',17,(c,c,c)); flag(im,ph,k=c/255); ph+=0.55
    frames.append(im); dur.append(70)
for n in range(20):                                          # флаг развевается
    im=scene(0,0,0,0,0,90,0,rocket=False); anim.ctext(ImageDraw.Draw(im),TY,'ПОЕХАЛИ!',17); flag(im,ph); ph+=0.55
    frames.append(im); dur.append(75)
frames=[q(x) for x in frames]
for fn in os.listdir('.'):
    if fn.startswith('poehali4_'): os.remove(fn)
for i,x in enumerate(frames): x.save(f'poehali4_{i:02d}.png')
open('poehali4_durations','w').write('\n'.join(map(str,dur))+'\n')
big=[x.resize((256,256),Image.NEAREST) for x in frames]
big[0].save('poehali4.gif',save_all=True,append_images=big[1:],duration=dur,loop=0)
frames[-1].resize((384,384),Image.NEAREST).save('poehali4_last.png')
print(len(frames),'кадров, всего',sum(dur),'мс, frames.bin',len(frames)*32768,'Б')
