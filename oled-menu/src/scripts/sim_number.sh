#!/system/bin/busybox sh

# апплеты только через busyboxx: у uid 1000 голые head, tr и др. из PATH не запускаются
B="${HIJ_B:-/system/bin/busyboxx}"
[ -x "$B" ] || B=/system/bin/busybox
# Номер SIM для секретного меню.
# Источники по порядку: Msisdn из "device information"; кэш веб-интерфейса
# /online/mod/conf/msisdn ("<ICCID> <номер>"), если ICCID в нем совпадает с текущим.
# USSD не отправляет.

CLIENT="${HIJ_WEBHOOK_CLIENT:-/app/hijacks/bin/web_hook_client}"
CACHE="${HIJ_MSISDN_CACHE:-/online/mod/conf/msisdn}"

# язык меню: HIJ_LANG=en - английский, иначе русский
T() { if [ "$HIJ_LANG" = en ]; then echo "$1"; else echo "$2"; fi; }

# значение XML-тега из ответа: tag ИМЯ
tag() { echo "$INFO" | $B sed -n "s:.*<$1>\([^<]*\)</$1>.*:\1:p" | $B head -n 1; }

# номер: только +, цифры, не длиннее 20 знаков
clean_number() { echo "$1" | $B tr -cd '+0123456789' | $B cut -c1-20; }

INFO="$("$CLIENT" device information 1 1 2>/dev/null)"
MSISDN="$(clean_number "$(tag Msisdn)")"
ICCID="$(tag Iccid | $B tr -cd '0-9A-Fa-f')"

if [ -z "$MSISDN" ] && [ -n "$ICCID" ] && [ -r "$CACHE" ]; then
    read -r C_ICCID C_NUMBER < "$CACHE"
    if [ "$C_ICCID" = "$ICCID" ]; then
        MSISDN="$(clean_number "$C_NUMBER")"
    fi
fi

echo "text:$(T 'SIM number:' 'Номер SIM:')"
if [ -n "$MSISDN" ]; then
    echo "text:$MSISDN"
else
    echo "text:$(T 'Number unknown' 'Номер неизвестен')"
    echo "text:$(T 'Find it out in the web interface' 'Узнать в веб-интерфейсе')"
fi
if [ -z "$INFO" ]; then
    echo "text:$(T 'No answer from the router' 'Роутер не ответил')"
fi
