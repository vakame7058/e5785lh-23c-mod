#!/system/bin/busyboxx sh
# name_ru: Привязка к соте
# name_en: Fix cell
# Привязка к текущей соте LTE (NV 53810 через balong-nvtool) и ее снятие.
# После записи NV - штатный сброс nvsys: запрос 46 Б в /dev/nv (NV 50018 тем же значением,
# индекс 93), ядро переписывает nvsys, пока есть /modem_log/drv/nv/sys_flag.bin.
# "Перезагрузите" - только когда флага нет. NV 36 через /dev/nv не писать: ядро отвечает EPERM.

B="${HIJ_B:-/system/bin/busyboxx}"
[ -x "$B" ] || B=/system/bin/busybox
NVTOOL="${HIJ_NVTOOL:-/system/xbin/balong-nvtool}"
ATC="${HIJ_ATC:-/system/xbin/atc}"
NVREQ="${HIJ_NVREQ:-/app/hijacks/conf/nv50018_req.bin}"
NVDEV="${HIJ_NVDEV:-/dev/nv}"
SYSFLAG="${HIJ_SYSFLAG:-/modem_log/drv/nv/sys_flag.bin}"

# язык меню: HIJ_LANG=en - английский, иначе русский
T() { if [ "$HIJ_LANG" = en ]; then echo "$1"; else echo "$2"; fi; }

ACTION="$1"

get_fixed_cell_pci() {
    LINE="$($NVTOOL -d 53810 | $B grep 00000000)"
    PCI1="$(echo "$LINE" | $B cut -d' ' -f 10)"
    PCI2="$(echo "$LINE" | $B cut -d' ' -f 11)"
    echo "$((0x${PCI2:-0} * 256 + 0x${PCI1:-0}))"
}

# сброс nvsys после записи NV; 0 - nvsys переписан
flush_nvsys() {
    [ -r "$NVREQ" ] || { echo "text:$(T "No NV request file" "Нет файла запроса NV")"; return 1; }
    if ! $B dd if="$NVREQ" of="$NVDEV" bs=46 count=1 2>/dev/null; then
        echo "text:$(T "nvsys update failed" "Ошибка записи nvsys")"
        return 1
    fi
    i=0
    while [ -e "$SYSFLAG" ] && [ $i -lt 30 ]; do
        $B usleep 500000
        i=$((i + 1))
    done
    if [ -e "$SYSFLAG" ]; then
        echo "text:$(T "nvsys is still being written" "nvsys еще пишется")"
        echo "text:$(T "Do not reboot yet" "Пока не перезагружайте")"
        return 1
    fi
    return 0
}

case "$ACTION" in
    "")
        FIXED_PCI="$(get_fixed_cell_pci)"
        PCI="$($ATC 'AT^CECELLID?' | $B grep 'CECELLID' | $B cut -d, -f3)"
        BAND="$($ATC 'AT^HFREQINFO?' | $B grep 'HFREQINFO' | $B cut -d, -f3)"
        DLFREQ="$($ATC 'AT^HFREQINFO?' | $B grep 'HFREQINFO' | $B cut -d, -f5)"

        echo "text:$(T "Fix current cell:" "Привязка к соте:")"
        if [ "$FIXED_PCI" -ne 0 ] 2>/dev/null; then
            echo "item:<$(T "Fix cell" "Привязать") $PCI>:FIX_CELL $PCI $BAND $DLFREQ"
            echo "item: $(T "Unfix cell" "Отвязать") $FIXED_PCI:UNFIX_CELL"
        else
            echo "item: $(T "Fix cell" "Привязать") $PCI:FIX_CELL $PCI $BAND $DLFREQ"
            echo "item:<$(T "Unfixed" "Не привязан")>:UNFIX_CELL"
        fi
        echo "text: "
        if [ "${DLFREQ:-0}" -gt 0 ] 2>/dev/null; then
            $B printf "text:$(T "Current cell" "Сота"): %d, B%d, %d.%d $(T MHz МГц)\n" "$PCI" "$BAND" "$((DLFREQ / 10))" "$((DLFREQ % 10))"
        else
            echo "text:$(T "Current cell is unknown" "Сота неизвестна")"
        fi
    ;;
    FIX_CELL)
        PCI="$2"; BAND="$3"; DLFREQ="$4"
        if [ -z "$PCI" ] || [ -z "$BAND" ] || [ -z "$DLFREQ" ]; then
            echo "text:$(T "Failed: no cell info" "Ошибка: нет данных о соте")"
            exit 0
        fi
        PARAMS="$($B printf 53810:03:00:00:00:%02x:01:%02x:01:%02x:%02x:%02x:%02x:00:00:00:00 "$BAND" "$BAND" "$((PCI % 256))" "$((PCI / 256))" "$((DLFREQ % 256))" "$((DLFREQ / 256))")"
        $NVTOOL -m "$PARAMS" > /dev/null
        if [ "$(get_fixed_cell_pci)" -eq "$PCI" ] 2>/dev/null; then
            flush_nvsys || exit 0
            echo "text:$(T "Done" "Готово")"
            echo "text:$(T "Reboot the router" "Перезагрузите роутер")"
        else
            echo "text:$(T "Failed" "Ошибка")"
        fi
    ;;
    UNFIX_CELL)
        $NVTOOL -m "53810:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00" > /dev/null
        if [ "$(get_fixed_cell_pci)" -eq 0 ] 2>/dev/null; then
            flush_nvsys || exit 0
            echo "text:$(T "Done" "Готово")"
            echo "text:$(T "Reboot the router" "Перезагрузите роутер")"
        else
            echo "text:$(T "Failed" "Ошибка")"
        fi
    ;;
esac
