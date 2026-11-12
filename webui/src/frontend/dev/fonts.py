#!/usr/bin/env python3
"""Подрезка шрифтов Geist под интерфейс: латиница, кириллица, знаки. Вариативная ось wght сохраняется.

Источник — npm-пакет geist (vercel/geist-font), распакованный в отдельный каталог:
  python3 -I dev/fonts.py ПУТЬ/К/package
Результат: fonts/Geist-Variable.woff2, fonts/GeistMono-Variable.woff2, fonts/OFL.txt.
"""
import os
import shutil
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), 'fonts')
# Basic Latin, Latin-1, Latin Extended-A, кириллица, общая пунктуация, валюты, №, стрелки, математика (−, ×, ≤)
UNICODES = '0020-007E,00A0-00FF,0100-017F,0400-045F,0490-0491,2000-206F,20A0-20BF,2116,2122,2190-21FF,2212-2215,2260-2265,25A0-25FF'


def cut(src, dst):
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']
    opts.name_IDs = ['*']
    opts.name_languages = ['*']
    opts.notdef_outline = True
    opts.drop_tables = []
    font = subset.load_font(src, opts)
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES))
    sub.subset(font)
    subset.save_font(font, dst, opts)
    t = TTFont(dst)
    cmap = t.getBestCmap()
    cyr = sum(1 for c in range(0x410, 0x450) if c in cmap)
    print('%s: %d байт, глифов %d, А–я %d/64, оси %s' % (os.path.basename(dst), os.path.getsize(dst), len(t.getGlyphOrder()), cyr,
          [a.axisTag for a in t['fvar'].axes] if 'fvar' in t else '-'))


def main():
    pkg = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    cut(os.path.join(pkg, 'dist/fonts/geist-sans/Geist-Variable.woff2'), os.path.join(OUT, 'Geist-Variable.woff2'))
    cut(os.path.join(pkg, 'dist/fonts/geist-mono/GeistMono-Variable.woff2'), os.path.join(OUT, 'GeistMono-Variable.woff2'))
    shutil.copy(os.path.join(pkg, 'LICENSE.txt'), os.path.join(OUT, 'OFL.txt'))


if __name__ == '__main__':
    main()
