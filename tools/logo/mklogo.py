#!/usr/bin/env python3
"""Образ раздела logo со своей картинкой в слоте обычной загрузки.

Запуск на компьютере:
    mklogo.py logo.png БАЗА logo.img     собрать образ
    mklogo.py --show logo.img out        достать картинки: out_0.png, out_1.png

БАЗА - Logo.bin из официальной прошивки или копия раздела со своего роутера.
Раздел logo: две картинки 128x128 RGB565, старший байт первым, 32768 Б каждая.
Слот [0] (заводской режим) остается как в базе, в слот [1] идет ваша картинка.
PNG сводится к RGB565 усечением младших бит.
"""
import struct
import sys

from PIL import Image

W = H = 128
SLOT = W * H * 2


def encode(path):
    im = Image.open(path).convert("RGB")
    if im.size != (W, H):
        sys.exit(f"{path}: размер {im.size}, нужен {W}x{H}")
    out = bytearray()
    for y in range(H):
        for x in range(W):
            r, g, b = im.getpixel((x, y))
            out += struct.pack(">H", ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3))
    return bytes(out)


def decode(raw):
    im = Image.new("RGB", (W, H))
    for y in range(H):
        for x in range(W):
            c = struct.unpack_from(">H", raw, (y * W + x) * 2)[0]
            im.putpixel((x, y), ((c >> 11) << 3, ((c >> 5) & 63) << 2, (c & 31) << 3))
    return im


def main():
    a = sys.argv[1:]
    if len(a) == 3 and a[0] == "--show":
        raw = open(a[1], "rb").read()
        for i in range(2):
            decode(raw[i * SLOT:(i + 1) * SLOT]).save(f"{a[2]}_{i}.png")
        return
    if len(a) != 3:
        sys.exit(__doc__)
    base = open(a[1], "rb").read()
    if len(base) < 2 * SLOT:
        sys.exit(f"{a[1]}: {len(base)} Б, нужно не меньше {2 * SLOT}")
    img = base[:SLOT] + encode(a[0])
    open(a[2], "wb").write(img)
    print(f"{a[2]}: {len(img)} Б")


if __name__ == "__main__":
    main()
