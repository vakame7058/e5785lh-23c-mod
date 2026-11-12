#!/bin/sh
# build_r10.sh КАТАЛОГ_РЕЗУЛЬТАТА - сборка меню с нужными флагами.
# Без этих флагов пункт 13 родного меню и подмена oled_cfg молча пропадут.
H=$(cd "$(dirname "$0")" && pwd)
exec sh "$H/build.sh" "$H/../src" "$1" -DNATIVE_MENU_ITEM=13 '-DOLED_CFG_OVERRIDE_DIR="/app/hijacks/oled_cfg"'
