#!/usr/bin/env python3
"""Чтение страниц флеша через fastboot в памяти: данные и OOB, 2112 Б на страницу.

Запуск на компьютере, когда роутер определился как 12d1:36dd:
    dump_pages.py СТАРТ_HEX СТРАНИЦ ФАЙЛ

СТАРТ_HEX - адрес раздела в байтах (блок * 0x20000), см. docs/recovery.md.
Внимание: чтение портит следующую запись в этом же сеансе. Сначала пишите, потом читайте.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fbcli

if len(sys.argv) != 4:
    sys.exit(__doc__)
start, n, out = int(sys.argv[1], 16), int(sys.argv[2]), sys.argv[3]
dev = fbcli.open_dev()
buf = bytearray()
k = 0
while k < n:
    cnt = min(4, n - k)
    want = 2112 * cnt
    fbcli.send(dev, f"oem nanddump:{start + k * 2048:x}:{want:x}:40".encode())
    got = bytearray()
    t0 = time.time()
    while len(got) < want and time.time() - t0 < 5:
        try:
            got += fbcli.recv(dev, 1500, 65536)
        except Exception:
            pass
    if len(got) != want:
        sys.exit(f"страница {k}: получено {len(got)} из {want}")
    buf += got
    k += cnt
open(out, "wb").write(buf)
print("записано", len(buf), "Б,", n, "стр.")
