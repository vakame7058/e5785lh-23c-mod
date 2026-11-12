#!/bin/bash
# Запись прошивки по разделам через fastboot в памяти роутера (режим 12d1:36dd).
#
# Запуск на компьютере сразу после подъема fastboot, до любых чтений:
#   flash_fw.sh РАЗДЕЛЫ ОБРАЗЫ [--m3boot ФАЙЛ] [--logo ФАЙЛ] [--no-yaffs]
#
#   РАЗДЕЛЫ   каталог после balong_flash -e: файлы NN-XXXXXXXX-Имя.bin
#   ОБРАЗЫ    каталог с Modem_fw.y2064, System.y2064, APP.y2064, WebUI.y2064 (mkyaffs_hw.py)
#   --m3boot  записать и m3boot (образ mkm3boot.py); без ключа m3boot не трогается
#   --logo    свой образ логотипа вместо Logo.bin (mklogo.py)
#   --no-yaffs только сырые разделы
#
# Переменная FASTBOOT_S: значение ключа -s для fastboot, например usb:1-2.
# Без нее fastboot берет первое подходящее устройство и может попасть на сканер отпечатков.
set -euo pipefail

usage() { sed -n '2,14p' "$0" | sed 's/^# \?//'; exit 2; }
[ $# -ge 2 ] || usage
PARTS=$1; IMGS=$2; shift 2
M3=""; LOGO=""; YAFFS=1
while [ $# -gt 0 ]; do
    case "$1" in
        --m3boot) M3=$2; shift 2 ;;
        --logo) LOGO=$2; shift 2 ;;
        --no-yaffs) YAFFS=0; shift ;;
        *) usage ;;
    esac
done

fb() { fastboot ${FASTBOOT_S:+-s "$FASTBOOT_S"} "$@"; }
part() {   # part Имя: файл раздела из каталога РАЗДЕЛЫ
    local f
    f=$(ls "$PARTS"/*-"$1".bin 2>/dev/null | head -n 1)
    [ -n "$f" ] || { echo "нет файла *-$1.bin в $PARTS" >&2; exit 1; }
    echo "$f"
}
flash() {  # flash раздел файл
    echo "=== $1 <- $2 sha256 $(sha256sum "$2" | cut -c1-16)"
    fb flash "$1" "$2"
}

fb getvar version
[ -z "$M3" ] || flash m3boot "$M3"
flash fastboot "$(part Fastboot)"
flash m3image "$(part M3Image_R11)"
flash dts "$(part DTS_R11)"
flash teeos "$(part Teeos)"
flash kernel "$(part Kernel_R11)"
flash logo "${LOGO:-$(part Logo)}"

if [ "$YAFFS" = 1 ]; then
    for p in modem_fw:Modem_fw system:System app:APP webui:WebUI; do
        name=${p%%:*}; file=$IMGS/${p#*:}.y2064
        [ -f "$file" ] || { echo "нет $file" >&2; exit 1; }
        echo "=== erase $name"
        fb erase "$name"
        flash "$name" "$file"
    done
fi
echo "Запись закончена. Сверка: dump_pages.py и verify_flash.py (docs/recovery.md)."
