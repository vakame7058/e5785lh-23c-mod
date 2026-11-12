#!/bin/bash
# Проверки меню на компьютере, роутер не нужен. Нужны clang с ASan и UBSan, python3 с Pillow.
#
#   run_pc.sh [oled.orig]
#
# oled.orig - /app/bin/oled.orig из прошивки 21.191.63.02, нужен только проверке логики главного
# экрана: она читает код программы и сверяет его контрольную сумму. Файла нет - проверка пропущена.
# Результат: test/out, кадры экрана - test/out/home/*.png и test/out/menu/*.png.
set -u
T=$(cd "$(dirname "$0")" && pwd); M=$T/..; SRC=$M/src; OUT=$T/out
BOOT=$M/../boot/anim
mkdir -p "$OUT/home" "$OUT/menu" "$OUT/run"
CF="-std=gnu11 -g -O1 -fno-omit-frame-pointer -D_GNU_SOURCE -I$SRC -include stdint.h -include stdio.h -include string.h -include errno.h -include unistd.h -w"
SAN="-fsanitize=address,undefined -fno-sanitize-recover=all"
rc=0

echo "== анимация: кадры, таймеры, кнопка"
cp "$BOOT/frames.bin" "$BOOT/durations" "$OUT/run/"
rm -f "$OUT/run/shown"
clang $CF $SAN -DBOOTANIM_DIR="\"$OUT/run\"" -DBOOTANIM_FLAG="\"$OUT/run/shown\"" -DBOOTANIM_LOG="\"$OUT/run/log\"" -DDUR_FILE="\"$OUT/run/durations\"" \
    "$T/bootanim_test.c" "$SRC/oled_bootanim.c" -o "$OUT/bootanim_test" -lpthread \
    && "$OUT/bootanim_test" full 2000 -1 7000 | tail -2 || rc=1

echo "== главный экран: кадры в PNG"
clang $CF $SAN "$T/home/home_test.c" "$T/home/stubs.c" "$SRC/oled_home.c" "$SRC/oled_home_paint.c" \
    "$SRC/oled_text.c" "$SRC/oled_paint.c" -o "$OUT/home/home_test" -lpthread \
    && (cd "$OUT/home" && ./home_test . | tail -1 && python3 "$T/home/topng.py" *.raw) || rc=1

echo "== меню: главный экран меню, подменю, Орбита"
clang $CF $SAN -DOLED_CFG_OVERRIDE_DIR='"/app/hijacks/oled_cfg"' -DNATIVE_MENU_ITEM=13 \
    "$T/menu/menu_test.c" "$T/menu/stubs7.c" "$SRC/oled_widgets.c" "$SRC/oled_paint.c" "$SRC/oled_text.c" \
    "$SRC/oled_orbit.c" "$SRC/oled_home.c" "$SRC/oled_home_paint.c" -o "$OUT/menu/menu_test" -ldl -lpthread \
    && (cd "$OUT/menu" && ./menu_test "$M/src" "$T/vpn/svc.sh" . sfirst m ssecond m sthird && python3 "$T/menu/topng.py" *.raw) || rc=1

if [ -n "${1:-}" ] && [ -f "$1" ]; then
    echo "== логика главного экрана на коде oled.orig"
    clang $CF -fsanitize=address "$T/home/home_logic8.c" "$SRC/oled_home.c" "$SRC/oled_home_paint.c" "$SRC/oled_text.c" "$SRC/oled_paint.c" \
        -o "$OUT/home/home_logic8" -lpthread && "$OUT/home/home_logic8" "$1" "$OUT/home" | tail -3 || rc=1
else
    echo "== логика главного экрана пропущена: нет oled.orig"
fi
[ $rc = 0 ] && echo "ИТОГ: проверки прошли" || echo "ИТОГ: есть ошибки"
exit $rc
