#!/system/bin/busybox sh

# апплеты только через busyboxx: у uid 1000 голые head, tr и др. из PATH не запускаются
B=/system/bin/busyboxx
[ -x "$B" ] || B=/system/bin/busybox

# язык меню: HIJ_LANG=en - английский, иначе русский
T() { if [ "$HIJ_LANG" = en ]; then echo "$1"; else echo "$2"; fi; }

ATC="/system/xbin/atc"

print_item () {
    DESC="$1"
    MODE="$2"
    CURRENT_MODE="$3"
    SHOW_IF_NOT_SELECTED="$4"

    if [[ "$CURRENT_MODE" == "$MODE" ]]; then
        echo "item:<$DESC>:$MODE"
    else
        if [ "$SHOW_IF_NOT_SELECTED" -eq 1 ]; then
            echo "item: $DESC :$MODE"
        fi
    fi
}

if [ "$#" -eq 0 ]; then
    CURRENT_MODE="$($ATC 'AT^SYSCFGEX?' | $B grep 'SYSCFGEX' | $B sed 's/^[^"]*"\([^"]*\)".*/\1/')"
    echo "text:$(T "Pick the mode:" "Режим сети:")"
    print_item "$(T Auto Авто)" "00" "$CURRENT_MODE" 1
    print_item "4G" "03" "$CURRENT_MODE" 1
    print_item "3G" "02" "$CURRENT_MODE" 1
    print_item "2G" "01" "$CURRENT_MODE" 0
    print_item "$(T "4G or 3G" "4G или 3G")" "0302" "$CURRENT_MODE" 1
    print_item "$(T "4G or 3G or 2G" "4G, 3G или 2G")" "0301" "$CURRENT_MODE" 0
    print_item "$(T "3G or 2G" "3G или 2G")" "0201" "$CURRENT_MODE" 0
fi

change_mode () {
    local MODE="$1"
    MODE_ENDING="$($ATC 'AT^SYSCFGEX?' | $B grep 'SYSCFGEX' | $B sed 's/[^0-9a-zA-Z=",^]//g' | $B sed 's/^[^"]*"[^"]*"//')"
    $ATC "AT^SYSCFGEX=\"${MODE}\"${MODE_ENDING},," | $B grep OK
}

if [ "$#" -eq 1 ]; then
    case "$1" in
        00 | 01 | 02 | 03 | 0302 | 0301 | 0201 ) change_mode "$1" ;;
        *) echo "text:$(T "wrong mode" "Неверный режим")"; exit 1;; 
    esac

    if [ "$?" -eq 0 ]; then
        echo "text:$(T Success Готово)"
    else
        echo "text:$(T "Failure code" "Ошибка, код") $?"
    fi
fi
