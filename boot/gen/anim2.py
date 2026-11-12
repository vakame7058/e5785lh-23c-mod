import sys; sys.path.insert(0,'.')
import anim
from PIL import Image, ImageDraw
q=anim.q565; f=anim.f; W=(255,255,255)
# ключевые кадры прежней анимации: x, y, угол, пламя, дым, сдвиг земли вниз
K=[(64,78,0,0,0,0),(64,78,0,1,0,0),(64,78,0,2,2,0),(64,70,0,3,4,0),(64,56,0,3,5,0),
   (66,40,8,3,5,8),(74,26,20,3,5,30),(90,14,35,3,5,60),(108,4,45,2,5,90)]
def lerp(a,b,t): return a+(b-a)*t
def scene(x,y,ang,fl,sm,dy,flick,text=None,tcol=W,rocket=True,small=False):
    im=Image.new('RGB',(128,128),anim.SKY); d=ImageDraw.Draw(im); anim.sky(d); anim.moon(d)
    if dy<60:                                       # земля, стол, вышки и дым уезжают вниз
        g=Image.new('RGBA',(128,128),(0,0,0,0)); gd=ImageDraw.Draw(g); anim.pad(gd,True)
        for i in range(int(round(sm))):
            rr=6+i*2; cx=64+(-1)**i*(8+i*4); gd.ellipse([cx-rr,110-rr,cx+rr,110+rr//2],fill=(150,150,160))
        im.paste(g,(0,int(dy)),g)
    if rocket:
        sp=anim.rocket(fl if fl<1 else max(1,min(3,round(fl)+flick)))
        if small: sp=sp.resize((15,32),Image.NEAREST)
        sp=sp.rotate(-ang,resample=Image.NEAREST,expand=True); im.paste(sp,(int(x-sp.width/2),int(y-sp.height/2)),sp)
    if text: anim.ctext(ImageDraw.Draw(im),84,text,17,tcol)
    return im
frames=[]; dur=[]
for i in range(len(K)-1):
    for t in (0,0.5):
        a,b=K[i],K[i+1]; p=[lerp(a[j],b[j],t) for j in range(6)]
        flick=(len(frames)%2) if p[3]>=2.5 else 0
        frames.append(scene(*p,flick=flick)); dur.append(125)
frames.append(scene(*K[-1],flick=0)); dur.append(125)            # 17 кадров полета
for k,c in enumerate((60,120,190,255)):                          # надпись проявляется
    frames.append(scene(0,0,0,0,0,90,0,text='ПОЕХАЛИ!',tcol=(c,c,c),rocket=False)); dur.append(100)
frames[-1:]=frames[-1:]; dur[-1]=600
frames.append(scene(96,40,45,1,0,90,0,text='ПОЕХАЛИ!',small=True)); dur.append(1500)
frames=[q(x) for x in frames]
for i,x in enumerate(frames): x.save(f'poehali2_{i:02d}.png')
open('poehali2_durations','w').write('\n'.join(map(str,dur))+'\n')
big=[x.resize((256,256),Image.NEAREST) for x in frames]
big[0].save('poehali2.gif',save_all=True,append_images=big[1:],duration=dur,loop=0)
print(len(frames),'кадров, всего',sum(dur),'мс')
