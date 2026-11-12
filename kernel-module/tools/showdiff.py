#!/usr/bin/env python3
# Print differing words (ours vs image) for one function: offset, ours, image
import sys, struct
sys.path.insert(0, sys.argv[0].rsplit('/', 1)[0])
from cmpfunc import elf_parse, IMG_BASE
img = open(sys.argv[1], 'rb').read()
ks = {}
for line in open(sys.argv[2]):
    a, t, n = line.split(); ks.setdefault(n, []).append(int(a, 16))
d, secs, syms, relocs = elf_parse(sys.argv[3])
for name in sys.argv[4].split(','):
    for (n, shndx, val, size) in syms:
        if n != name: continue
        sec = secs[shndx]; r = relocs.get(shndx, set()); io = ks[n][0] - IMG_BASE
        print('==', n, 'img', hex(ks[n][0]))
        for off in range(val & ~3, val + size, 4):
            if off in r: continue
            a = struct.unpack_from('<I', d, sec['off'] + off)[0]
            b = struct.unpack_from('<I', img, io + off - val)[0]
            if a != b: print('  +%04x ours %08x img %08x' % (off - val, a, b))
