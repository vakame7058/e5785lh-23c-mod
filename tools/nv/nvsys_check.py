#!/usr/bin/env python3
"""Сверка раздела nvsys с nv.bin перед перезагрузкой. Только чтение файлов.

Запуск на компьютере:
    nvsys_check.py nvsys.bin nv.bin

nvsys.bin - чтение /dev/block/mtdblock7 с роутера (не меньше длины nv.bin + 4 Б),
nv.bin - /mnvm2:0/nv.bin. Годится: хвостовая метка на месте и все ячейки температуры как в nv.bin.
"""
import struct
import sys

from nvlib import items, value

KEY_CELLS = (36, 40, 13, 35, 49, 10015, 10016, 53536, 53538, 53542, 50364)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    s = open(sys.argv[1], "rb").read()
    n = open(sys.argv[2], "rb").read()
    ln = len(n)
    magic = struct.unpack_from("<I", s, ln)[0]
    ok = magic == 0xABCD8765
    print(f"метка по смещению 0x{ln:x}: 0x{magic:08x} {'есть' if ok else 'НЕТ'}")
    hs, is_ = items(s)
    hn, in_ = items(n)
    diff = [k for k in set(is_) | set(in_)
            if k not in is_ or k not in in_ or value(s, is_[k], h=hs) != value(n, in_[k], h=hn)]
    print("ячеек с разницей:", len(diff), sorted(diff)[:30])
    for k in KEY_CELLS:
        same = k in is_ and k in in_ and value(s, is_[k], h=hs) == value(n, in_[k], h=hn)
        ok &= same
        print(f"  NV {k:5d} {'как в nv.bin' if same else 'ОТЛИЧАЕТСЯ'}")
    print("ИТОГ:", "годится" if ok else "НЕ годится")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
