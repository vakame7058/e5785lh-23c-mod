#!/bin/sh
# Сборка под роутер (oled-menu/build/build.sh) на временной копии исходников меню с этим
# oled_orbit.c: проверка, что модуль компилируется и линкуется (-z defs, bionic 4.4).
# Нужен sysroot: oled-menu/build/prepare_sysroot.sh. Копия удаляется.
set -e
T=$(cd "$(dirname "$0")" && pwd)
G=$T/..
M=${HIJ:-$G/../oled-menu}
TMP=$(mktemp -d "$T/out.arm.XXXXXX")
cp -r "$M/src" "$TMP/src"
cp "$G/oled_orbit.c" "$G/oled_orbit.h" "$TMP/src/"
sh "$M/build/build.sh" "$TMP/src" "$TMP/out" > "$TMP/build.txt" 2>&1 || { cat "$TMP/build.txt"; rm -rf "$TMP"; exit 1; }
echo "предупреждений в oled_orbit.c: $(grep -c 'oled_orbit' "$TMP/out/oled_hijack.so.log" || true)"
echo "oled_hijack.so: $(stat -c %s "$TMP/out/oled_hijack.so") Б"
llvm-nm -D "$TMP/out/oled_hijack.so" | grep ' T orbit_'
rm -rf "$TMP"
