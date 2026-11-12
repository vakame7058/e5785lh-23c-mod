#!/usr/bin/env python3
"""Ширина строк в шрифтах hijack_ng (oled_font.h): textwidth.py <oled_font.h> [small|large] строка..."""
import re, sys
src = open(sys.argv[1]).read()
def widths(name):
    w = re.search(name + r'_WIDTHS\[\] = \{(.*?)\};', src, re.S).group(1)
    return [int(x, 0) for x in re.findall(r'0x[0-9a-fA-F]+|\d+', w)]
def idx(ch):
    c = ord(ch)
    if c < 128: return c
    if 0x410 <= c <= 0x44F: return 128 + c - 0x410
    if c == 0x401: return 192
    if c == 0x451: return 193
    if c == 0xb7: return 0x1f
    return ord('?')
def width(s, font='small'):
    w = widths('SMALL_FONT' if font == 'small' else 'LARGE_FONT')
    return sum(w[idx(c)] for c in s)
if __name__ == '__main__':
    font = sys.argv[2]
    for s in sys.argv[3:]:
        print(f"{width(s, font):4d} {s!r}")
