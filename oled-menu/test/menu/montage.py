import sys
from PIL import Image, ImageDraw
out=sys.argv[1]; ps=sys.argv[2:]
ims=[Image.open(p) for p in ps]
W=len(ims)*(256+8); im=Image.new('RGB',(min(W,4*(264)), ((len(ims)+3)//4)*(256+20)),(60,60,60))
d=ImageDraw.Draw(im)
for i,x in enumerate(ims):
    c,r=i%4,i//4
    im.paste(x.resize((256,256),Image.NEAREST),(c*264,r*276+16))
    d.text((c*264,r*276+2),ps[i].split('/')[-1],fill=(255,255,0))
im.save(out)
