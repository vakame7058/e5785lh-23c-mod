#!/usr/bin/env python3
"""PNG 128x128 -> frames.bin (RGB565, старший байт первым, по строкам) + durations.

Формат как у secret_screen_buf в oled_paint.c put_pixel():
color = (R>>3)<<11 | (G>>2)<<5 | (B>>3), в памяти байты переставлены (big-endian).
Запуск: mkbootanim.py <выходной_каталог> <мс1,мс2,...> <png...>
"""
import struct, sys
from PIL import Image

out, ms_list, pngs = sys.argv[1], sys.argv[2].split(','), sys.argv[3:]
if len(ms_list) != len(pngs):
    sys.exit(f"длительностей {len(ms_list)}, кадров {len(pngs)}")
frames = bytearray()
for p in pngs:
    im = Image.open(p).convert('RGB')
    if im.size != (128, 128):
        sys.exit(f"{p}: размер {im.size}, нужен 128x128")
    lost = 0
    for y in range(128):
        for x in range(128):
            r, g, b = im.getpixel((x, y))
            if (r & 7) or (g & 3) or (b & 7):
                lost += 1
            frames += struct.pack('>H', ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3))
    print(f"{p}: потеряно младших бит в {lost} пикселях")
open(f"{out}/frames.bin", 'wb').write(frames)
open(f"{out}/durations", 'w').write(''.join(f"{int(m)}\n" for m in ms_list))
# обратная проверка: декодировать frames.bin и сравнить с PNG
for i, p in enumerate(pngs):
    im = Image.open(p).convert('RGB')
    for y in range(128):
        for x in range(128):
            (c,) = struct.unpack_from('>H', frames, (i * 128 * 128 + y * 128 + x) * 2)
            r, g, b = (c >> 11) << 3, ((c >> 5) & 63) << 2, (c & 31) << 3
            if (r, g, b) != im.getpixel((x, y)):
                sys.exit(f"кадр {i}: расхождение в ({x},{y})")
print(f"кадров {len(pngs)}, frames.bin {len(frames)} Б, сумма длительностей {sum(map(int, ms_list))} мс, обратная проверка пройдена")
