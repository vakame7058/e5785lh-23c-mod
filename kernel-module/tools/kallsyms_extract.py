#!/usr/bin/env python3
# Extract kallsyms (addr, type, name) from a decompressed ARM32 Linux 3.10 Image.
import sys, struct
img = open(sys.argv[1], 'rb').read()
out = sys.argv[2]
L = len(img)
def u32(o): return struct.unpack_from('<I', img, o)[0]
def u16(o): return struct.unpack_from('<H', img, o)[0]
found = None
for o in range(0, L - 4, 4):
    n = u32(o)
    if not (20000 < n < 200000):
        continue
    start = o - 4 * n
    if start < 0:
        continue
    # quick checks: first, middle, last
    a0 = u32(start); a1 = u32(start + 4 * (n // 2)); a2 = u32(o - 4)
    if not (0xc0000000 <= a0 <= a1 <= a2 < 0xd0000000):
        continue
    ok = True
    prev = 0
    for k in range(n):
        a = u32(start + 4 * k)
        if a < prev:
            ok = False; break
        prev = a
    if ok:
        found = (start, n, o); break
if not found:
    sys.exit('kallsyms_addresses not found')
start, n, o = found
print('addresses at', hex(start), 'num_syms', n)
names = o + 4
while names % 16 and u32(names) == 0: names += 4
# Walk names to find end
p = names
lens = []
for k in range(n):
    ln = img[p]
    lens.append((p, ln))
    p += 1 + ln
names_end = p
# markers: ceil(n/256) u32, aligned
q = (names_end + 3) & ~3
while not (u32(q) == 0 and 0 < u32(q + 4) < 40000 and u32(q + 4) < u32(q + 8)): q += 4  # markers[0]==0
markers = q
nm = (n + 255) // 256
tt = markers + 4 * nm
while img[tt] == 0: tt += 1
# token table: 256 zero-terminated strings
toks = []
t = tt
for k in range(256):
    e = img.index(b'\0', t)
    toks.append(img[t:e].decode('latin1'))
    t = e + 1
syms = []
for (pp, ln) in lens:
    s = ''.join(toks[b] for b in img[pp + 1:pp + 1 + ln])
    syms.append(s)
with open(out, 'w') as f:
    for k in range(n):
        a = u32(start + 4 * k)
        s = syms[k]
        f.write('%08x %s %s\n' % (a, s[0], s[1:]))
print('wrote', out)
