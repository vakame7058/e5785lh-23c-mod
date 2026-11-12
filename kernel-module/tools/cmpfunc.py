#!/usr/bin/env python3
# Compare functions of ARM32 relocatable objects with the same functions in a
# decompressed kernel Image (kallsyms from the image). Relocated words are skipped.
import sys, struct
IMG_BASE = 0xc0008000

def elf_parse(path):
    d = open(path, 'rb').read()
    e_shoff, = struct.unpack_from('<I', d, 0x20)
    e_shentsize, e_shnum, e_shstrndx = struct.unpack_from('<HHH', d, 0x2e)
    secs = []
    for i in range(e_shnum):
        name, typ, flags, addr, off, size, link, info, align, entsize = struct.unpack_from('<10I', d, e_shoff + i * e_shentsize)
        secs.append(dict(name=name, type=typ, off=off, size=size, link=link, info=info, entsize=entsize))
    shstr = secs[e_shstrndx]
    def cstr(off):
        e = d.index(b'\0', off); return d[off:e].decode()
    for s in secs:
        s['nm'] = cstr(shstr['off'] + s['name'])
    syms = []
    relocs = {}
    for idx, s in enumerate(secs):
        if s['type'] == 2:  # SYMTAB
            strtab = secs[s['link']]
            for k in range(s['size'] // 16):
                st_name, st_value, st_size, st_info, st_other, st_shndx = struct.unpack_from('<IIIBBH', d, s['off'] + 16 * k)
                if (st_info & 0xf) == 2 and st_size > 0:  # FUNC
                    syms.append((cstr(strtab['off'] + st_name), st_shndx, st_value, st_size))
        if s['type'] == 9:  # REL
            tgt = s['info']
            r = relocs.setdefault(tgt, set())
            for k in range(s['size'] // 8):
                r_off, r_info = struct.unpack_from('<II', d, s['off'] + 8 * k)
                r.add(r_off & ~3)
    return d, secs, syms, relocs

def main():
    img = open(sys.argv[1], 'rb').read()
    ks = {}
    for line in open(sys.argv[2]):
        a, t, n = line.split()
        if t in 'Tt':
            ks.setdefault(n, []).append(int(a, 16))
    only = set(sys.argv[4].split(',')) if len(sys.argv) > 4 and sys.argv[4] else None
    for obj in sys.argv[3].split(','):
        d, secs, syms, relocs = elf_parse(obj)
        tot_w = tot_eq = 0; nfun = nsame = 0; diffs = []
        for (name, shndx, val, size) in syms:
            if only and name not in only:
                continue
            if name not in ks or len(ks[name]) != 1:
                continue
            sec = secs[shndx]
            if sec['nm'] not in ('.text',):
                continue
            r = relocs.get(shndx, set())
            io = ks[name][0] - IMG_BASE
            eq = tw = 0; bad = []
            for off in range(val & ~3, val + size, 4):
                if off in r:
                    continue
                a = d[sec['off'] + off: sec['off'] + off + 4]
                b = img[io + off - val: io + off - val + 4]
                tw += 1
                if a == b: eq += 1
                else: bad.append(off - val)
            nfun += 1; tot_w += tw; tot_eq += eq
            if eq == tw: nsame += 1
            else: diffs.append((name, size, tw - eq, bad[:6]))
        print('%s: functions %d, identical %d, words %d/%d equal' % (obj.split('/')[-1], nfun, nsame, tot_eq, tot_w))
        for x in diffs[:40]:
            print('   DIFF %-40s size %5d  differing words %3d  first offs %s' % (x[0], x[1], x[2], [hex(o) for o in x[3]]))
if __name__ == "__main__":
    main()
