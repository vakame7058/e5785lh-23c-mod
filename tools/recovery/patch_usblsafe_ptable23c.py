#!/usr/bin/env python3
"""Загрузчик для E5785Lh-23c из usblsafe-e5785.bin (сборка под 22c): меняет таблицу разделов в файле.

Запуск на компьютере:
    patch_usblsafe_ptable23c.py usblsafe-e5785.bin usblsafe-e5785-ptable23c.bin

Исходный файл берется из репозитория forth32/balong-usbdload (в комплект не входит).
Меняются 4 байта: размер app, начало webui, начало и размер system.
Контрольные суммы исходного файла и результата проверяются.
"""
import hashlib
import struct
import sys

SHA_IN = "2128a116ddd33167508ec11267fb10636080d6151e945fe679b31cfbdc3d40b3"
SHA_OUT = "b0fec39ffa18bff68aaf2036bc36c5e427fd07e23e5907ad53fc370262611a8d"

HEAD = b"pTableHead"
LINE = 48          # размер записи раздела: имя 16 Б + 8 полей по 4 Б
FIRST = 48         # смещение первой записи от начала таблицы
START, LENGTH = 16, 24   # смещения полей "начало" и "размер" в записи

# раздел: поле, значение 22c, значение 23c
EDITS = [
    ("app", LENGTH, 0x011C0000, 0x013C0000),
    ("webui", START, 0x0C200000, 0x0C400000),
    ("system", START, 0x0D900000, 0x0DB00000),
    ("system", LENGTH, 0x01B00000, 0x01900000),
]


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, dst = sys.argv[1:3]
    data = bytearray(open(src, "rb").read())
    got = hashlib.sha256(data).hexdigest()
    if got != SHA_IN:
        sys.exit(f"неизвестный исходный файл, sha256 {got}\nнужен usblsafe-e5785.bin из forth32/balong-usbdload")

    table = data.find(HEAD)
    if table < 0:
        sys.exit("таблица разделов не найдена")

    records = {}
    for k in range(41):
        pos = table + FIRST + k * LINE
        name = bytes(data[pos:pos + 16]).split(b"\0")[0].decode("latin1")
        if not name or name == "T":
            break
        records[name] = pos

    for name, field, old, new in EDITS:
        pos = records[name] + field
        cur = struct.unpack_from("<I", data, pos)[0]
        if cur != old:
            sys.exit(f"{name}+{field}: ожидалось 0x{old:x}, в файле 0x{cur:x}")
        struct.pack_into("<I", data, pos, new)
        print(f"{name:8s} поле {'начало' if field == START else 'размер'}: 0x{old:08x} -> 0x{new:08x}")

    got = hashlib.sha256(data).hexdigest()
    if got != SHA_OUT:
        sys.exit(f"результат не сошелся, sha256 {got}; файл не записан")
    open(dst, "wb").write(data)
    print(f"записан {dst}, sha256 {got}")


if __name__ == "__main__":
    main()
