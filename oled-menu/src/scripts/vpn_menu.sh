#!/system/bin/busyboxx sh
# VPN для секретного меню: выбор профиля и вкл/выкл через CLI помощника веб-интерфейса.
# Конфиги не разбирает: только svc.sh list | brief | use <id> | start | stop | split on/off | split-status
#   list  -> строки id|подпись|протокол|активный(0/1); нет подписи - id
#   brief -> running=0/1|profile=...|label=...|handshake=секунд назад (пусто - не было)|...|split=0/1
#   split-status -> строки split_list=0/1 и другие; без списка split on не проходит
# Код 0 - успех, 1 - ошибка (одна строка в stderr), 2 - неизвестная команда.
# svc.sh запускается через busyboxx sh от root.

B="${HIJ_B:-/system/bin/busyboxx}"
[ -x "$B" ] || B=/system/bin/busybox
SVC="${HIJ_VPN_SVC:-/online/mod/pkg/awg/svc.sh}"

# язык меню: HIJ_LANG=en - английский, иначе русский
T() { if [ "$HIJ_LANG" = en ]; then echo "$1"; else echo "$2"; fi; }

# строка текста: без переводов строк (длинную меню переносит по словам)
line() { echo "$1" | $B tr -d '\r\n'; }
# подпись пункта: еще и без ':' (разделитель пунктов); не влезет в 108 px - меню обрежет
clean() { line "$1" | $B tr ':' '.'; }

svc() { $B sh "$SVC" "$@"; }

run_svc() {
    ERR=$(svc "$@" 2>&1 >/dev/null)
    RC=$?
    if [ $RC -eq 0 ]; then
        echo "text:$(T Done Готово)"
    else
        echo "text:$(T Error Ошибка):"
        echo "text:$(line "${ERR:-$(T "no details" "без подробностей")}")"
    fi
}

# раздельный VPN: российские адреса напрямую, остальное в туннель
run_split() {
    if [ "$1" = on ]; then
        HAS_LIST="$(svc split-status 2>/dev/null | $B sed -n 's/^split_list=//p' | $B head -n 1)"
        if [ "$HAS_LIST" = 0 ]; then
            echo "text:$(T "No list:" "Нет списка:")"
            echo "text:$(T "see panel" "см. панель")"
            return
        fi
    fi
    OUT="$(svc split "$1" 2>&1)"
    RC=$?
    if [ $RC -ne 0 ]; then
        E="$(echo "$OUT" | $B sed -n '/[^[:space:]]/{p;q;}' | $B tr -d '\r')"
        if [ "${#E}" -gt 90 ]; then
            E="$(echo "$E" | $B head -c 90)"
            E="${E% *}..."
        fi
        echo "text:$(T Error Ошибка):"
        echo "text:${E:-$(T "no details" "без подробностей")}"
        return
    fi
    # туннель только для сетей из AllowedIPs: настройка записана, но не действует
    case "$OUT" in
        *"не действует"*)
            echo "text:$(T "Not in effect:" "Не действует:")"
            echo "text:$(T "VPN is not for all traffic" "VPN не на весь трафик")"
            ;;
        *) echo "text:$(T Done Готово)" ;;
    esac
}

field() { echo "$BRIEF" | $B tr '|' '\n' | $B sed -n "s/^$1=//p" | $B head -n 1; }

show_menu() {
    BRIEF="$(svc brief 2>/dev/null)"
    RUNNING="$(field running)"
    LABEL="$(line "$(field label)")"
    [ -n "$LABEL" ] || LABEL="$(line "$(field profile)")"
    HS="$(field handshake | $B tr -cd '0-9')"
    if [ "$RUNNING" = 1 ]; then
        echo "text:VPN: $(T running работает)"
        [ -n "$LABEL" ] && echo "text:$LABEL"
        if [ -n "$HS" ]; then
            echo "text:$(T "handshake $HS s ago" "связь $HS с назад")"
        else
            echo "text:$(T "no handshake yet" "связи еще не было")"
        fi
        echo "item:$(T "Turn off" "Выключить"):STOP"
    else
        echo "text:VPN: $(T "not running" "не работает")"
        [ -n "$LABEL" ] && echo "text:$LABEL"
        echo "item:$(T "Turn on" "Включить"):START"
    fi
    echo "pagebreak:"
    case "$(field split)" in
        1) echo "item:<$(T "Direct RU" "РФ напрямую")>:SPLIT off" ;;
        0) echo "item: $(T "Direct RU" "РФ напрямую"):SPLIT on" ;;
    esac
    [ -n "$(field split)" ] && echo "text:  $(T "rest via VPN" "остальное в VPN")"
    echo "text:$(T "Profiles:" "Профили:")"
    LIST="$(svc list 2>/dev/null)"
    if [ -z "$LIST" ]; then
        echo "text:$(T "No profiles" "Профилей нет")"
        echo "text:$(T "Add them in the web interface" "Добавьте в веб-интерфейсе")"
        return
    fi
    echo "$LIST" | while IFS='|' read -r ID NAME PROTO ACTIVE; do
        case "$ID" in ''|*[!A-Za-z0-9_.-]*) continue ;; esac
        NAME="$(clean "${NAME:-$ID}")"
        if [ "$ACTIVE" = 1 ]; then
            echo "item:<$NAME>:USE $ID"
        else
            echo "item: $NAME:USE $ID"
        fi
    done
}

# после команды: итог одной-двумя строками, затем меню заново
case "$1" in
    "")    show_menu ;;
    START) run_svc start; show_menu ;;
    STOP)  run_svc stop; show_menu ;;
    USE)
        case "$2" in
            ''|*[!A-Za-z0-9_.-]*) echo "text:$(T "Bad profile" "Неверный профиль")"; exit 1 ;;
        esac
        run_svc use "$2"
        show_menu
    ;;
    SPLIT)
        case "$2" in
            on|off) ;;
            *) echo "text:$(T "wrong command" "Неверная команда")"; exit 1 ;;
        esac
        run_split "$2"
        show_menu
    ;;
    *)
        echo "text:$(T "wrong command" "Неверная команда")"
        exit 1
    ;;
esac
