#!/usr/bin/env python3
"""Сверка записанного раздела с образом, байт в байт, без допусков.

Запуск на компьютере:
    verify_flash.py ОБРАЗ ДАМП          сырой раздел: образ по 2048 Б на страницу
    verify_flash.py --yaffs ОБРАЗ ДАМП  раздел YAFFS2: образ по 2064 Б (данные и тег)

ДАМП снимает dump_pages.py: страницы по 2112 Б (2048 данных + 64 OOB).
В OOB значимы только первые 16 Б. Плохой блок fastboot пропускает при записи, а в дампе на его
месте лежит копия предыдущего блока: такой блок сверка узнает и пропускает.
Код возврата: 0 - совпало, 1 - есть расхождения.
"""
import sys

PAGE, DUMP_PAGE, PAGES_IN_BLOCK = 2048, 2112, 64


def main():
    args = sys.argv[1:]
    yaffs = "--yaffs" in args
    if yaffs:
        args.remove("--yaffs")
    if len(args) != 2:
        sys.exit(__doc__)
    img = open(args[0], "rb").read()
    dump = open(args[1], "rb").read()
    stride = 2064 if yaffs else PAGE
    pages = (len(img) + stride - 1) // stride
    dump_blocks = (len(dump) + DUMP_PAGE * PAGES_IN_BLOCK - 1) // (DUMP_PAGE * PAGES_IN_BLOCK)

    def dump_page(block, page):
        pos = (block * PAGES_IN_BLOCK + page) * DUMP_PAGE
        return dump[pos:pos + stride]

    def dump_block(block):
        pos = block * PAGES_IN_BLOCK * DUMP_PAGE
        return dump[pos:pos + PAGES_IN_BLOCK * DUMP_PAGE]

    bad_pages, skipped = [], []
    block = 0
    for first in range(0, pages, PAGES_IN_BLOCK):
        # плохой блок: дамп повторяет предыдущий блок
        while (0 < block < dump_blocks and dump_block(block) == dump_block(block - 1)
               and img[first * stride:(first + 1) * stride] != dump_page(block, 0)):
            skipped.append(block)
            block += 1
        if block >= dump_blocks:
            print(f"дамп короче образа: кончился на странице образа {first}")
            return 1
        for i in range(first, min(first + PAGES_IN_BLOCK, pages)):
            want = img[i * stride:(i + 1) * stride]
            got = dump_page(block, i - first)[:len(want)]
            if want != got:
                bad_pages.append(i)
        block += 1

    tail_bad = 0
    for b in range(block, dump_blocks):
        if set(dump_block(b)[:PAGE]) != {0xFF}:
            tail_bad += 1

    print(f"страниц в образе: {pages}, расходятся: {len(bad_pages)}")
    if bad_pages:
        print("первые расхождения:", bad_pages[:10])
        first = bad_pages[0]
        pos = first * stride
        print("смещение в образе:", hex(pos))
    if skipped:
        print("пропущены плохие блоки раздела:", skipped)
    print(f"блоков после образа: {dump_blocks - block}, не стертых среди них: {tail_bad}")
    return 1 if bad_pages else 0


if __name__ == "__main__":
    sys.exit(main())
