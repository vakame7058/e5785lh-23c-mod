import sys, struct
from PIL import Image
for p in sys.argv[1:]:
    d=open(p,'rb').read(); im=Image.new('RGB',(128,128))
    px=im.load()
    for i in range(128*128):
        v=struct.unpack('<H',d[2*i:2*i+2])[0]; v=((v&0xff)<<8)|(v>>8)
        px[i%128,i//128]=((v>>11)<<3,((v>>5)&63)<<2,(v&31)<<3)
    im.resize((384,384),Image.NEAREST).save(p[:-4]+'.png')
