from PIL import Image, ImageDraw, ImageFont
B='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'; N='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'; C='/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf'
def f(p,s): return ImageFont.truetype(p,s)
W=(255,255,255); G=(150,155,165); BG=(6,8,20); CARD=(18,22,40); GREEN=(60,210,110); YEL=(250,200,60); RED=(230,70,60); BLUE=(70,140,255)
def q(im):
    o=Image.new('RGB',im.size); o.putdata([((r>>3)<<3,(g>>2)<<2,(b>>3)<<3) for r,g,b in im.getdata()]); return o
def statusbar(d):
    d.rectangle([0,0,127,11],fill=(0,0,0))
    for i,h in enumerate((3,5,7,9)): d.rectangle([2+i*3,10-h,3+i*3,10],fill=GREEN if i<3 else (60,60,70))
    d.text((16,0),'4G+',font=f(B,9),fill=W)
    d.text((40,0),'Tele2',font=f(N,9),fill=G)
    d.text((70,0),'VPN',font=f(B,8),fill=GREEN)
    d.rectangle([104,2,120,9],outline=W); d.rectangle([121,4,122,7],fill=W); d.rectangle([106,4,106+12,7],fill=GREEN)
    d.text((88,0),'14:32',font=f(N,8),fill=W) if False else None
def spark(d,x0,y0,w,h,vals,col):
    m=max(vals) or 1; pts=[(x0+i*(w-1)/(len(vals)-1), y0+h-1-(v/m)*(h-1)) for i,v in enumerate(vals)]
    d.line(pts,fill=col,width=1)
def A():
    im=Image.new('RGB',(128,128),BG); d=ImageDraw.Draw(im); statusbar(d)
    d.text((4,14),'14:32',font=f(B,22),fill=W); d.text((76,16),'Чт 29',font=f(N,10),fill=G); d.text((76,28),'окт',font=f(N,10),fill=G)
    d.rounded_rectangle([2,42,125,72],radius=4,fill=CARD)
    d.text((6,44),'B7 · 20 МГц · CA',font=f(C,9),fill=G)
    d.text((6,56),'RSRP −74',font=f(B,9),fill=GREEN); d.text((66,56),'SINR 19',font=f(B,9),fill=GREEN)
    d.rounded_rectangle([2,75,125,105],radius=4,fill=CARD)
    d.text((6,77),'↓ 12,4',font=f(B,10),fill=BLUE); d.text((66,77),'↑ 1,8',font=f(B,10),fill=(200,120,255))
    spark(d,6,92,118,11,[1,3,2,5,9,12,8,11,12,10,6,4,7,12],BLUE)
    d.text((4,108),'Сегодня 1,2 ГБ',font=f(C,9),fill=G); d.text((80,108),'Wi-Fi: 3',font=f(C,9),fill=G)
    d.text((4,118),'ЦП 12% · 37 °C',font=f(C,8),fill=G)
    return im
def Bv():
    im=Image.new('RGB',(128,128),BG); d=ImageDraw.Draw(im); statusbar(d)
    # кольцо сигнала
    cx,cy,r=32,48,24
    d.ellipse([cx-r,cy-r,cx+r,cy+r],outline=(40,45,70),width=5)
    d.arc([cx-r,cy-r,cx+r,cy+r],135,135+270*0.78,fill=GREEN,width=5)
    d.text((cx-14,cy-9),'−74',font=f(B,12),fill=W); d.text((cx-11,cy+5),'RSRP',font=f(N,7),fill=G)
    d.text((62,20),'LTE B7',font=f(B,11),fill=W); d.text((62,34),'SINR 19 дБ',font=f(N,9),fill=GREEN); d.text((62,46),'CA: B7+B3',font=f(N,9),fill=G)
    d.text((62,58),'AWG2 · вкл',font=f(N,9),fill=GREEN)
    d.line([(4,78),(123,78)],fill=(40,45,70))
    d.text((4,82),'↓',font=f(B,11),fill=BLUE); d.text((14,82),'12,4',font=f(B,11),fill=W); d.text((66,82),'↑',font=f(B,11),fill=(200,120,255)); d.text((76,82),'1,8',font=f(B,11),fill=W)
    d.text((4,96),'Мбит/с',font=f(N,7),fill=G)
    spark(d,40,96,84,9,[1,3,2,5,9,12,8,11,12,10,6,4,7,12],BLUE)
    d.text((4,108),'1,2 ГБ сегодня',font=f(C,9),fill=G); d.text((84,108),'3 устр.',font=f(C,9),fill=G)
    d.text((4,118),'37 °C  ЦП 12%  14:32',font=f(C,8),fill=G)
    return im
ims=[q(A()),q(Bv())]
for i,x in enumerate(ims): x.save(f'home_{"AB"[i]}.png')
sh=Image.new('RGB',(2*384+30,384+40),(40,40,40)); d=ImageDraw.Draw(sh)
for i,x in enumerate(ims):
    sh.paste(x.resize((384,384),Image.NEAREST),(10+i*404,30)); d.text((10+i*404,6),['А. Часы и карточки','Б. Кольцо сигнала'][i],font=f(B,18),fill=W)
sh.save('home_variants.png')
