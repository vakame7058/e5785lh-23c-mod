#!/usr/bin/env python3
"""Список префиксов страны для раздельного VPN пакета awg.

Вход: файл статистики RIPE NCC delegated-ripencc-extended-latest
(https://ftp.ripe.net/pub/stats/ripencc/). Скрипт ничего не скачивает.
Выход: префиксы IPv4 после объединения, по одному в строке, заголовок с датой и источником.
Загрузка на роутер: svc.sh split-update ФАЙЛ.
"""
import argparse
import ipaddress
import sys


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="файл delegated-ripencc-extended")
    ap.add_argument("output", help="файл списка")
    ap.add_argument("--country", default="RU", help="код страны (по умолчанию RU)")
    ap.add_argument("--min-prefix", type=int, default=0,
                    help="укрупнить префиксы длиннее этой длины, например 22 (по умолчанию не укрупнять)")
    args = ap.parse_args()

    nets = []
    file_date = ""
    with open(args.input, encoding="ascii", errors="replace") as f:
        for line in f:
            p = line.rstrip("\n").split("|")
            if not file_date and len(p) >= 6 and p[0][:1].isdigit():
                file_date = f"{p[5][:4]}-{p[5][4:6]}-{p[5][6:8]}"
                continue
            if len(p) >= 7 and p[1] == args.country and p[2] == "ipv4" and p[6] in ("allocated", "assigned"):
                first = ipaddress.IPv4Address(p[3])
                last = ipaddress.IPv4Address(int(first) + int(p[4]) - 1)
                nets.extend(ipaddress.summarize_address_range(first, last))
    if not nets:
        sys.exit(f"нет записей для страны {args.country}")
    if args.min_prefix:
        nets = [n if n.prefixlen <= args.min_prefix else n.supernet(new_prefix=args.min_prefix) for n in nets]
    merged = list(ipaddress.collapse_addresses(nets))
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(f"# date={file_date}\n")
        f.write("# source=RIPE NCC delegated-ripencc-extended, https://ftp.ripe.net/pub/stats/ripencc/\n")
        f.write(f"# country={args.country} prefixes={len(merged)} min_prefix={args.min_prefix or 'нет'}\n")
        f.write("# Страна делегирования, а не место работы сайта. Сгенерировано split-gen.py, не править вручную.\n")
        for n in merged:
            f.write(f"{n}\n")
    print(f"{args.output}: {len(merged)} префиксов, дата {file_date}")


if __name__ == "__main__":
    main()
