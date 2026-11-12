#!/usr/bin/env python3
"""Образ раздела m3boot из файлов официальной прошивки: 4 одинаковые копии по 128 КиБ.

Запуск на компьютере:
    mkm3boot.py M3Boot_R11.bin M3Boot-ptable.bin m3boot.img

Копия: M3Boot с начала блока, заполнение 0xFF, таблица разделов на смещении 0x1F800.
Файлы получают из пакета прошивки: balong_flash -e ПРОШИВКА.BIN
Эталон для 21.191.63.02: sha256 результата начинается с 4c061d6147c9158f.
"""
import hashlib
import sys

BLOCK = 0x20000
PTABLE_AT = 0x1F800
COPIES = 4


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    m3 = open(sys.argv[1], "rb").read()
    table = open(sys.argv[2], "rb").read()
    if len(table) != BLOCK - PTABLE_AT:
        sys.exit(f"таблица {len(table)} Б, нужно {BLOCK - PTABLE_AT}")
    if not table.startswith(b"pTableHead"):
        sys.exit("во втором файле нет таблицы разделов")
    if len(m3) > PTABLE_AT:
        sys.exit("M3Boot не помещается перед таблицей")
    copy = m3 + b"\xff" * (PTABLE_AT - len(m3)) + table
    image = copy * COPIES
    open(sys.argv[3], "wb").write(image)
    print(f"{sys.argv[3]}: {len(image)} Б, sha256 {hashlib.sha256(image).hexdigest()}")


if __name__ == "__main__":
    main()
