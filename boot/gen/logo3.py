import sys; sys.path.insert(0,'.')
import anim, logo2
from PIL import Image, ImageDraw
W=(255,255,255); f=anim.f; q=anim.q565
def bar(d,y,frac,x0=24,x1=104,h=7,seg=10):
    d.rectangle([x0-2,y-2,x1+2,y+h+2],outline=(170,170,180))
    n=int(seg*frac); sw=(x1-x0)/seg
    for i in range(n): d.rectangle([int(x0+i*sw)+1,y,int(x0+(i+1)*sw)-1,y+h],fill=(60,200,90))
def A():
    im=anim.frame((64,74)); d=ImageDraw.Draw(im); d.rectangle([0,112,127,127],fill=(30,30,40)); anim.ctext(d,114,'ПОДГОТОВКА...',11); return im
def B():
    im=anim.frame((64,70)); d=ImageDraw.Draw(im); d.rectangle([0,104,127,127],fill=(30,30,40))
    anim.ctext(d,105,'ЗАПУСК...',10); bar(d,118,0.7,x0=24,x1=104,h=5); return im
def C():
    im=logo2.D(); d=ImageDraw.Draw(im); d.rectangle([0,113,127,127],fill=(12,12,16)); anim.ctext(d,114,'ПОДГОТОВКА К ПУСКУ',8,(255,240,200)); return im
def D():
    im=Image.new('RGB',(128,128),(50,54,58)); d=ImageDraw.Draw(im)
    for i in range(-128,256,12): d.polygon([(i,0),(i+6,0),(i+6-128,128),(i-128,128)],fill=(230,190,20))
    d.rectangle([8,8,119,119],fill=(62,66,72)); d.rectangle([8,8,119,119],outline=(30,30,34),width=2)
    for i,c in enumerate([(40,200,70),(40,200,70),(255,170,0)]): d.ellipse([20+i*14,16,28+i*14,24],fill=c)
    d.rectangle([16,30,111,44],fill=(20,24,20)); anim.ctext(d,32,'ПОДГОТОВКА',10,(80,255,120))
    d.ellipse([36,52,92,108],fill=(110,20,15)); d.ellipse([39,54,89,104],fill=(220,40,30)); d.ellipse([45,58,68,74],fill=(245,110,90))
    anim.ctext(d,71,'ПУСК',14); return im
ims=[q(x()) for x in (A,B,C,D)]; labels=['А. Старт + «Подготовка...»','Б. Старт + «Запуск...» и полоса','В. Ночной старт + «Подготовка к пуску»','Г. Пульт: табло «Подготовка»']
for i,x in enumerate(ims): x.save(f'logo3_{"ABCD"[i]}.png')
S=3; sheet=Image.new('RGB',(2*128*S+60,2*(128*S+40)+20),(40,40,40)); sd=ImageDraw.Draw(sheet)
for i,x in enumerate(ims):
    cx=20+(i%2)*(128*S+20); cy=10+(i//2)*(128*S+40)
    sheet.paste(x.resize((128*S,128*S),Image.NEAREST),(cx,cy+30)); sd.text((cx,cy+4),labels[i],font=f(18),fill=W)
sheet.save('logo3_variants.png'); print('ok')
