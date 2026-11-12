#!/bin/sh
# Сборка проверочной обвязки на ПК. Варианты:
#   orbit_sim       -O2, для кадров и замера
#   orbit_sim_asan  AddressSanitizer + UndefinedBehaviorSanitizer
#   orbit_sim_tsan  ThreadSanitizer
set -e
T=$(cd "$(dirname "$0")" && pwd)
G=$T/..
D=${HIJ_SRC:-$G/../oled-menu/src}    # исходники hijack_ng: oled.h, oled_font.h, oled_paint.c
OUT=${OUT:-$T/out}
mkdir -p "$OUT"
BEST="-DORBIT_BEST_FILE=\"$OUT/orbit_best\""
CF="-std=gnu11 -g -Wall -Wextra -I$D -I$G -include stdint.h"
# oled_paint.c - чужой файл, только компилируется
clang $CF -O2 $BEST -o "$OUT/orbit_sim" "$T/orbit_sim.c" "$D/oled_paint.c" -lpthread
clang $CF -O1 -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=all $BEST \
    -o "$OUT/orbit_sim_asan" "$T/orbit_sim.c" "$D/oled_paint.c" -lpthread
clang $CF -O1 -fsanitize=thread $BEST -o "$OUT/orbit_sim_tsan" "$T/orbit_sim.c" "$D/oled_paint.c" -lpthread
ls -la "$OUT"/orbit_sim*
