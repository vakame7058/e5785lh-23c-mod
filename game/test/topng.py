#!/usr/bin/env python3
"""Кадры обвязки (RGB565, старший байт первым, 128x128) -> PNG и GIF.

topng.py png <каталог .bin> <каталог PNG> [масштаб]   каждый кадр в PNG + лист всех кадров
topng.py gif <файл кадров> <файл GIF> [масштаб]        анимация 20 к/с
"""
import os, struct, sys
from PIL import Image, ImageDraw, ImageFont

FS = 128 * 128 * 2


def frame(buf, off=0):
    im = Image.new('RGB', (128, 128))
    px = []
    for i in range(128 * 128):
        (c,) = struct.unpack_from('>H', buf, off + i * 2)
        r, g, b = (c >> 11) << 3, ((c >> 5) & 63) << 2, (c & 31) << 3
        px.append((r | r >> 5, g | g >> 6, b | b >> 5))
    im.putdata(px)
    return im


def font(sz):
    for p in ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',):
        if os.path.exists(p):
            return ImageFont.truetype(p, sz)
    return ImageFont.load_default()


def do_png(src, dst, k):
    os.makedirs(dst, exist_ok=True)
    names = sorted(f[:-4] for f in os.listdir(src) if f.endswith('.bin') and os.path.getsize(os.path.join(src, f)) == FS)
    ims = []
    for n in names:
        im = frame(open(os.path.join(src, n + '.bin'), 'rb').read())
        im.resize((128 * k, 128 * k), Image.NEAREST).save(os.path.join(dst, n + '.png'))
        ims.append((n, im))
    cols = 5
    rows = (len(ims) + cols - 1) // cols
    s = 2
    sh = Image.new('RGB', (cols * (128 * s + 10) + 10, rows * (128 * s + 26) + 10), (36, 36, 40))
    d = ImageDraw.Draw(sh)
    for i, (n, im) in enumerate(ims):
        x = 10 + (i % cols) * (128 * s + 10)
        y = 10 + (i // cols) * (128 * s + 26)
        d.text((x, y), n, font=font(13), fill=(230, 230, 230))
        sh.paste(im.resize((128 * s, 128 * s), Image.NEAREST), (x, y + 18))
    sh.save(os.path.join(dst, 'sheet.png'))
    print(len(ims), 'PNG, лист', os.path.join(dst, 'sheet.png'))


def do_gif(src, dst, k):
    buf = open(src, 'rb').read()
    n = len(buf) // FS
    ims = [frame(buf, i * FS).resize((128 * k, 128 * k), Image.NEAREST) for i in range(n)]
    pal = [im.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for im in ims]
    pal[0].save(dst, save_all=True, append_images=pal[1:], duration=50, loop=0, optimize=False, disposal=1)
    print(n, 'кадров,', n * 50 / 1000, 'с,', os.path.getsize(dst), 'Б ->', dst)


if __name__ == '__main__':
    mode, a, b = sys.argv[1:4]
    k = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    (do_png if mode == 'png' else do_gif)(a, b, k)
