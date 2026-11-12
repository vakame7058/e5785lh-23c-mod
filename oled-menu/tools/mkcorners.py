#!/usr/bin/env python3
"""Покрытие углов скругленного прямоугольника (0..15) для радиусов 0..5: mkcorners.py <выход.h>"""
import sys, math
N = 8
def cov(r, ring):
    t = []
    for j in range(r):
        for i in range(r):
            n = 0
            for l in range(N):
                for k in range(N):
                    x, y = i + (k + .5) / N, j + (l + .5) / N
                    d = math.hypot(x - r, y - r)
                    if d <= r and (not ring or d > r - 1):
                        n += 1
            t.append(int(round(15 * n / (N * N))))
    return t + [0] * (25 - len(t))
out = ['/* Сгенерировано tools/mkcorners.py: покрытие угла r x r, [j*r+i], i и j - от края */']
for name, ring in (('corner_fill', 0), ('corner_ring', 1)):
    out.append('static const uint8_t %s[6][25] = {' % name)
    for r in range(6):
        out.append('    {' + ', '.join(str(v) for v in cov(r, ring)) + '},')
    out.append('};')
open(sys.argv[1], 'w').write('\n'.join(out) + '\n')
