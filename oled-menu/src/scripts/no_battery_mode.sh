#!/system/bin/busybox sh

# апплеты только через busyboxx: у uid 1000 голые head, tr и др. из PATH не запускаются
B=/system/bin/busyboxx
[ -x "$B" ] || B=/system/bin/busybox

# язык меню: HIJ_LANG=en - английский, иначе русский
T() { if [ "$HIJ_LANG" = en ]; then echo "$1"; else echo "$2"; fi; }

NVTOOL="/system/xbin/balong-nvtool"

if [ "$#" -eq 0 ]; then
    echo "text:$(T Battery: Батарея:)"

    PRODUCT="$($B cat /proc/productname)"
    case "$PRODUCT" in
        E5885*)
            echo "text:$(T "Not detachable" "Не снимается")"
            exit 0
            ;;
    esac

    if $NVTOOL -d 50364 | $B grep -q '00 00 00 00'; then
        echo "item:<$(T Enable Включена)>:enable"
        echo "item: $(T Disable Выключена):disable"
    else
        echo "item: $(T Enable Включена):enable"
        echo "item:<$(T Disable Выключена)>:disable"
    fi
fi

if [ "$#" -eq 1 ]; then
    case "$1" in
        enable )
            if $NVTOOL -m 50364:00:00:00:00 | $B grep -q отредактирована; then
                echo "text:$(T "Battery enabled" "Батарея включена")"
                echo "text:$(T "Insert and reboot" "Вставьте и перезагрузите")"
            else
                echo "text:$(T Error Ошибка)"
            fi
            ;;
        disable )
            if $NVTOOL -m 50364:01:00:00:00 | $B grep -q отредактирована; then
                echo "text:$(T "Battery disabled" "Батарея выключена")"
                echo "text:$(T "Remove and reboot" "Снимите и перезагрузите")"
            else
                echo "text:$(T Error Ошибка)"
            fi
            ;;
        * )
            echo "text:$(T "wrong command mode" "Неверная команда")"
            exit 1;;
    esac
fi
