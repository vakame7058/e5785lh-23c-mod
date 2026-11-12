#!/usr/bin/env python3
"""Правка NV для платы E5785Lh-23c из официального Nvdload, секции cat0 и product_id=33.

Запуск на компьютере:
    nvfix_gen.py --live nv.bin --nvdload Nvdload_R11.bin --out nvfix [--orig свой_nv.bin [--restore]] [--product 33]

Сравнивает ячейки из секций со значениями в nv.bin роутера и пишет в каталог nvfix:
    table.tsv  какие ячейки меняются (id, длина, секция, сейчас, нужно);
    cells/     значения для balong-nvtool, файл длиной ровно с ячейку;
    apply.sh   запись на роутере.

Значение: байты из XML, остаток ячейки - как в nv.bin.
Ключ --orig: брать значение из своей копии nv.bin, снятой до чужой прошивки, если там ячейка той
же длины. Плата должна быть та же. Чужие копии не использовать: в NV лежат IMEI и калибровка.
Ключ --restore вместе с --orig: откат, каждая ячейка секций возвращается к значению из копии.
Ячейки с данными экземпляра (IMEI, калибровка) в секциях нет и не меняются.
Каталог nvfix содержит значения вашего экземпляра: не выкладывайте его.
"""
import argparse
import os
import stat

from nvlib import items, parse_sections, split_nvdload, value

APPLY = """#!/system/bin/busyboxx sh
# Запись ячеек NV в /mnvm2:0/nv.bin. Запуск на роутере из этого каталога.
# Значения вступят в силу после перезагрузки.
NVTOOL=/system/xbin/balong-nvtool
cd "$(/system/bin/busyboxx dirname "$0")" || exit 1
n=0; bad=0
while read -r id; do
    $NVTOOL -r "$id:cells/$id.bin" >/dev/null 2>&1 || {{ echo "ОШИБКА: ячейка $id"; bad=$((bad + 1)); }}
    n=$((n + 1))
done <<'IDS'
{ids}
IDS
/system/bin/busyboxx sync
echo "записано ячеек: $n, ошибок: $bad"
[ "$bad" = 0 ]
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", required=True, help="nv.bin с роутера")
    ap.add_argument("--nvdload", required=True, help="Nvdload_R11.bin из официальной прошивки 23c")
    ap.add_argument("--out", required=True, help="каталог для результата")
    ap.add_argument("--orig", help="своя копия nv.bin до чужой прошивки")
    ap.add_argument("--restore", action="store_true", help="откат: все ячейки секций как в --orig")
    ap.add_argument("--product", type=int, default=33, help="product_id платы, у 23c это 33")
    a = ap.parse_args()
    if a.restore and not a.orig:
        ap.error("--restore работает только вместе с --orig")

    live = open(a.live, "rb").read()
    hl, il = items(live)
    _, xml = split_nvdload(open(a.nvdload, "rb").read())
    secs = parse_sections(xml)
    sec = f"p{a.product}"
    if sec not in secs:
        raise SystemExit(f"в XML нет секции product_id={a.product}, есть: {sorted(secs)}")

    orig = oh = oi = None
    if a.orig:
        orig = open(a.orig, "rb").read()
        oh, oi = items(orig)

    target = {}
    for name in ("cat0", sec):
        for iid, val in secs[name].items():
            target[iid] = (name, val)

    rows, missing = [], []
    for iid, (name, val) in sorted(target.items()):
        if iid not in il:
            missing.append(iid)
            continue
        now = value(live, il[iid], h=hl)
        if now[:len(val)] == val and not a.restore:
            continue
        new = val + now[len(val):]
        if orig is not None and iid in oi and oi[iid]["len"] == len(now):
            new = value(orig, oi[iid], h=oh)
            if new == now:
                continue
        rows.append((iid, len(now), name, now, new))

    os.makedirs(os.path.join(a.out, "cells"), exist_ok=True)
    with open(os.path.join(a.out, "table.tsv"), "w") as f:
        f.write("id\tid_hex\tlen\tsection\tnow_hex\tnew_hex\n")
        for iid, ln, name, now, new in rows:
            f.write(f"{iid}\t0x{iid:04X}\t{ln}\t{name}\t{now.hex()}\t{new.hex()}\n")
            with open(os.path.join(a.out, "cells", f"{iid}.bin"), "wb") as c:
                c.write(new)
    path = os.path.join(a.out, "apply.sh")
    with open(path, "w") as f:
        f.write(APPLY.format(ids="\n".join(str(r[0]) for r in rows)))
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)

    print(f"прошивка в nv.bin: {hl['prod']}; ячеек в секциях: {len(target)}; менять: {len(rows)}")
    if missing:
        print("нет в nv.bin (пропущены):", missing)
    print("результат:", a.out)


if __name__ == "__main__":
    main()
