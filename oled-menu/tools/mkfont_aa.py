#!/usr/bin/env python3
"""Сглаженные шрифты для oled_hijack: mkfont_aa.py <выход.h> [превью.png]

Растеризует DejaVu (FreeType через PIL) в 4 бита на пиксель (0 - прозрачно, 15 - цвет
полностью), глифы обрезаны по рамке, по 2 пикселя в байте (старшая тетрада - левый).
Таблица глифов отсортирована по коду символа (поиск делением пополам).
"""
import sys
from PIL import Image, ImageDraw, ImageFont

D = '/usr/share/fonts/truetype/dejavu/'

ASCII = [chr(c) for c in range(0x20, 0x7F)]
CYR = [chr(c) for c in range(0x410, 0x450)] + ['Ё', 'ё']
CYR_EXT = list('ІіЎўЄєЇїҐґӘәҒғҚқҢңӨөҰұҮүҺһ')
SYM = list('−·°…←↑→↓«»–—№±•▲▼✓●○×')
FULL = ASCII + CYR + CYR_EXT + SYM

# имя, файл, размер (em, px), набор, гамма (меньше 1 - толще тонкие штрихи)
FONTS = [
    ('font_s',  'DejaVuSansCondensed.ttf', 9,  FULL, 0.85),
    ('font_m',  'DejaVuSans.ttf',          11, FULL, 0.85),
    ('font_mb', 'DejaVuSans-Bold.ttf',     11, FULL, 0.9),
    ('font_xl', 'DejaVuSans-Bold.ttf',     22, list('0123456789: -−'), 0.9),
]

NOTICE = """/*
 * Сгенерировано tools/mkfont_aa.py, руками не править.
 * Глифы растеризованы из шрифтов DejaVu Sans, DejaVu Sans Condensed, DejaVu Sans Bold.
 *
 * Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved. Bitstream Vera is
 * a trademark of Bitstream, Inc. DejaVu changes are in public domain.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of the fonts accompanying this license ("Fonts") and associated documentation
 * files (the "Font Software"), to reproduce and distribute the Font Software,
 * including without limitation the rights to use, copy, merge, publish,
 * distribute, and/or sell copies of the Font Software, and to permit persons to
 * whom the Font Software is furnished to do so, subject to the following
 * conditions: The above copyright and trademark notices and this permission
 * notice shall be included in all copies of one or more of the Font Software
 * typefaces. The Font Software may be modified, altered, or added to, and in
 * particular the designs of glyphs or characters in the Fonts may be modified
 * and additional glyphs or characters may be added to the Fonts, only if the
 * fonts are renamed to names not containing either the words "Bitstream" or
 * the word "Vera". [...] THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT
 * WARRANTY OF ANY KIND. Полный текст: https://dejavu-fonts.github.io/License.html
 */
"""


def render(path, size, chars, gamma):
    f = ImageFont.truetype(D + path, size)
    asc, desc = f.getmetrics()
    glyphs = []
    for ch in sorted(set(chars), key=ord):
        mask, (ox, oy) = f.getmask2(ch, mode='L')
        w, h = mask.size
        adv = int(round(f.getlength(ch)))
        px = [mask.getpixel((x, y)) for y in range(h) for x in range(w)]
        a4 = [0 if v == 0 else max(1, min(15, int(round(((v / 255.0) ** gamma) * 15)))) for v in px]
        # обрезать пустые строки и столбцы
        rows = [y for y in range(h) if any(a4[y * w + x] for x in range(w))]
        cols = [x for x in range(w) if any(a4[y * w + x] for y in range(h))]
        if rows and cols:
            y0, y1, x0, x1 = rows[0], rows[-1], cols[0], cols[-1]
            a4 = [a4[y * w + x] for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
            w, h, ox, oy = x1 - x0 + 1, y1 - y0 + 1, ox + x0, oy + y0
        else:
            a4, w, h, ox, oy = [], 0, 0, 0, 0
        data = bytearray()
        bpr = (w + 1) // 2
        for y in range(h):
            row = a4[y * w:(y + 1) * w] + [0]
            for x in range(bpr):
                data.append((row[2 * x] << 4) | row[2 * x + 1])
        glyphs.append(dict(cp=ord(ch), w=w, h=h, x=ox, y=oy, adv=adv, data=bytes(data), a4=a4))
    return glyphs, asc, desc


def emit(out, png=None):
    parts = [NOTICE, '#ifndef OLED_FONT_AA_H\n#define OLED_FONT_AA_H\n#include "oled_text.h"\n']
    previews = []
    total = 0
    for name, path, size, chars, gamma in FONTS:
        glyphs, asc, desc = render(path, size, chars, gamma)
        data = bytearray()
        tab = []
        for g in glyphs:
            tab.append('    {0x%04x, %d, %d, %d, %d, %d, %d},' % (g['cp'], g['w'], g['h'], g['x'], g['y'], g['adv'], len(data)))
            data += g['data']
        total += len(data) + 12 * len(glyphs)
        parts.append('/* %s: %s %d px, %d глифов, %d Б */' % (name, path, size, len(glyphs), len(data)))
        parts.append('static const uint8_t %s_data[%d] = {' % (name, len(data)))
        for i in range(0, len(data), 24):
            parts.append('    ' + ','.join('0x%02x' % b for b in data[i:i + 24]) + ',')
        parts.append('};')
        parts.append('static const struct aa_glyph %s_glyphs[%d] = {' % (name, len(glyphs)))
        parts += tab
        parts.append('};')
        parts.append('const struct aa_font %s = {%s_glyphs, %s_data, %d, %d, %d};\n' % (
            name, name, name, len(glyphs), asc + desc, asc))
        previews.append((name, glyphs, asc, desc))
    parts.append('#endif')
    open(out, 'w').write('\n'.join(parts) + '\n')
    print('всего %d Б' % total)
    if png:
        preview(previews, png)


def preview(previews, png):
    W = 620
    H = sum((a + d + 4) * ((len(g) * 14) // W + 2) for _, g, a, d in previews) + 40
    im = Image.new('RGB', (W, H), (0, 0, 0))
    y = 2
    for name, glyphs, asc, desc in previews:
        x = 2
        for g in glyphs:
            if x + g['adv'] + 2 > W:
                x = 2
                y += asc + desc + 3
            for yy in range(g['h']):
                for xx in range(g['w']):
                    a = g['a4'][yy * g['w'] + xx]
                    if a:
                        v = a * 17
                        im.putpixel((x + g['x'] + xx, y + g['y'] + yy), (v, v, v))
            x += g['adv'] + 2
        y += asc + desc + 8
    im = im.crop((0, 0, W, y))
    im.resize((W * 2, y * 2), Image.NEAREST).save(png)


if __name__ == '__main__':
    emit(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
