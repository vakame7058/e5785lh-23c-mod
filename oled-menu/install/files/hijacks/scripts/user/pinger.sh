#!/system/bin/busyboxx sh
# name_ru: Проверка связи
# name_en: Pinger
# Проверка связи: раз в ~20 с 10 пингов до 8.8.8.8; если ответов меньше 5 - радио
# выключается и включается (AT+CFUN=0/1). Можно запускать при загрузке (/system/etc/autorun.d).

B="${HIJ_B:-/system/bin/busyboxx}"
[ -x "$B" ] || B=/system/bin/busybox

# язык меню: HIJ_LANG=en - английский, иначе русский
T() { if [ "$HIJ_LANG" = en ]; then echo "$1"; else echo "$2"; fi; }

ACTION="$1"

AUTORUN_FILE="/system/etc/autorun.d/ping.sh"
PINGER_UP_FILE="/var/pinger_up"

PINGER_ON_SCRIPT='#!/system/bin/busyboxx sh
B=/system/bin/busyboxx
ATC=/system/xbin/atc

reconnect() {
    $ATC "AT+CFUN=0"
    while ! $ATC "AT+CFUN=1" | $B grep -i OK; do
        $B usleep 500000
    done
}

loop() {
    if [ -f /var/pinger_up ]; then
        return
    fi
    while ! echo "$$" > /var/pinger_up; do
        $B usleep 500000
    done

    while [ -f /var/pinger_up ]; do
        RECV=$($B ping -q -c 10 -w 15 8.8.8.8 2>/dev/null | $B sed -n "s/.* \([0-9]*\) packets received.*/\1/p")
        if [ "${RECV:-0}" -lt 5 ]; then
            reconnect
        fi
        $B sleep 5
    done
}

loop &
'

PINGER_OFF_SCRIPT="#!/system/bin/busyboxx sh
$B rm -f $PINGER_UP_FILE
$B usleep 200000
"

is_pinger_up() {
    test -f "$PINGER_UP_FILE"
}

is_pinger_on_boot() {
    test -f "$AUTORUN_FILE"
}

ok_or_fail() {
    if "$@"; then echo "text:$(T Done Готово)"; else echo "text:$(T Failed Ошибка)"; fi
}

case "$ACTION" in
    "")
        echo "text:$(T "Pinger:" "Проверка связи:")"
        if is_pinger_up; then
            echo "item:<$(T On Включена)>:PINGER_ENABLE"
            echo "item: $(T Off Выключена):PINGER_DISABLE"
        else
            echo "item: $(T On Включена):PINGER_ENABLE"
            echo "item:<$(T Off Выключена)>:PINGER_DISABLE"
        fi

        echo "text:$(T "Start on boot:" "При загрузке:")"
        if is_pinger_on_boot; then
            echo "item:<$(T Yes Да)>:PINGER_ON_BOOT_ENABLE"
            echo "item: $(T No Нет):PINGER_ON_BOOT_DISABLE"
        else
            echo "item: $(T Yes Да):PINGER_ON_BOOT_ENABLE"
            echo "item:<$(T No Нет)>:PINGER_ON_BOOT_DISABLE"
        fi
    ;;
    PINGER_ENABLE)
        echo "$PINGER_ON_SCRIPT" | $B sh
        for i in 1 2 3 4 5; do
            if is_pinger_up; then
                echo "text:$(T Done Готово)"
                exit 0
            fi
            $B usleep 500000
        done
        echo "text:$(T Failed Ошибка)"
    ;;
    PINGER_DISABLE)
        echo "$PINGER_OFF_SCRIPT" | $B sh
        ok_or_fail eval '! is_pinger_up'
    ;;
    PINGER_ON_BOOT_ENABLE)
        $B mount -o remount,rw /system
        $B mkdir -p /system/etc/autorun.d
        echo "$PINGER_ON_SCRIPT" > "$AUTORUN_FILE"
        $B chmod 755 "$AUTORUN_FILE"
        $B sync
        $B mount -o remount,ro /system
        ok_or_fail is_pinger_on_boot
    ;;
    PINGER_ON_BOOT_DISABLE)
        $B mount -o remount,rw /system
        $B rm -f "$AUTORUN_FILE"
        $B sync
        $B mount -o remount,ro /system
        ok_or_fail eval '! is_pinger_on_boot'
    ;;
    * )
        echo "text:$(T "wrong command" "Неверная команда")"
        exit 1
    ;;
esac
