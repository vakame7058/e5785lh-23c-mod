#!/system/bin/busyboxx sh
# DNS для секретного меню: включение, выбор сервера и блокировка рекламы
# через /online/mod/pkg/dns/svc.sh (запускается через busyboxx sh от root).
#   presets -> строки id|подпись|активный(0/1), первая auto
#   brief   -> running=0|1|preset=ID|label=ПОДПИСЬ|adblock=0|1
# Включение: enable и start; выключение: stop и disable - выбор переживает перезагрузку.
# Ошибки presets, use-preset, adblock идут в stderr одной строкой, ошибки start - в stdout
# несколькими строками, поэтому показывается первая непустая строка обоих потоков.

B="${HIJ_B:-/system/bin/busyboxx}"
[ -x "$B" ] || B=/system/bin/busybox
SVC="${HIJ_DNS_SVC:-/online/mod/pkg/dns/svc.sh}"
SETTINGS="${HIJ_DNS_SETTINGS:-/online/mod/conf/dns/settings}"
CONF="$($B dirname "$SVC")/conf"
# вывод команд - в файл: если меню закроют и oled убьет этот скрипт,
# начатая пара команд в отдельном процессе доработает до конца
OUT="${HIJ_DNS_OUT:-/tmp/hij_dns_menu.out}"
ROWS=7

# язык меню: HIJ_LANG=en - английский, иначе русский
T() { if [ "$HIJ_LANG" = en ]; then echo "$1"; else echo "$2"; fi; }

line() { echo "$1" | $B tr -d '\r\n'; }
# подпись пункта: ':' - разделитель полей в строке item
clean() { line "$1" | $B tr ':' '.'; }
svc() { $B sh "$SVC" "$@"; }

# подпись с роутера -> короткая для экрана; незнакомая остается как есть,
# не влезет - меню обрежет ее многоточием
short() {
    l=$1
    [ "$HIJ_LANG" = en ] && case "$l" in "Авто: "*) l="Auto: ${l#Авто: }" ;; esac
    case "$l" in
        "AdGuard, с блокировкой рекламы"*) l="AdGuard${l#AdGuard, с блокировкой рекламы}" ;;
        "DNS оператора (подменяет ответы)") l="DNS оператора" ;;
    esac
    case "$l" in
        *" (DoT)") l="${l% (DoT)} DoT" ;;
        *" (DoH)") l="${l% (DoH)} DoH" ;;
    esac
    echo "$l"
}

# пояснение под подписью, если при сокращении пропал смысл
note() {
    case "$1" in
        "Авто:"*) ;;
        *"блокировкой рекламы"*) T "no ads" "без рекламы" ;;
        *"подменяет ответы"*) T "alters answers" "подменяет ответы" ;;
    esac
}

# ошибка на экран: первая непустая строка, не длиннее 90 байт, по границе слова
show_err() {
    e="$($B sed -n '/[^[:space:]]/{p;q;}' "$OUT" 2>/dev/null | $B tr -d '\r')"
    e="${e%:}"
    [ -n "$e" ] || e="$(T "no details" "без подробностей")"
    if [ "${#e}" -gt 90 ]; then
        e="$(echo "$e" | $B head -c 90)"
        e="${e% *}..."
    fi
    echo "text:$(T Error Ошибка):"
    echo "text:$e"
}

report() {
    if [ "$1" -eq 0 ]; then
        echo "text:$(T Done Готово)"
    else
        show_err
    fi
}

field() { echo "$BRIEF" | $B tr '|' '\n' | $B sed -n "s/^$1=//p" | $B head -n 1; }

# адрес для custom задан: settings поверх conf, как читает сам svc.sh
custom_set() {
    [ "$PRESET" = custom ] && return 0
    if [ -r "$SETTINGS" ] && $B grep -q '^CUSTOM_DNS=' "$SETTINGS"; then
        v="$($B sed -n 's/^CUSTOM_DNS=//p' "$SETTINGS" | $B tail -n 1)"
    else
        v="$($B sed -n 's/^CUSTOM_DNS=//p' "$CONF" 2>/dev/null | $B tail -n 1)"
    fi
    [ -n "$(echo "$v" | $B tr -d "\"' ")" ]
}

show_list() {
    echo "pagebreak:"
    echo "text:$(T "Servers:" "Серверы:")"
    # номер строки на странице: подпись с пояснением не должна разрываться
    R=1
    echo "$PRESETS" > "$OUT.list"
    while IFS='|' read -r ID NAME ACTIVE; do
        case "$ID" in ''|*[!A-Za-z0-9_.-]*) continue ;; esac
        [ "$ID" = custom ] && ! custom_set && continue
        LABEL="$(short "${NAME:-$ID}")"
        if [ "$ID" = auto ]; then
            # протокол не влезает; ':' в подписи пункта нельзя
            LABEL="${LABEL% DoT}"
            LABEL="${LABEL% DoH}"
            LABEL="${LABEL%%: *} · ${LABEL#*: }"
        fi
        LABEL="$(clean "$LABEL")"
        NOTE="$(note "$NAME")"
        if [ -n "$NOTE" ] && [ $((R % ROWS)) -eq $((ROWS - 1)) ]; then
            echo "pagebreak:"
            R=0
        fi
        if [ "$ACTIVE" = 1 ]; then
            echo "item:<$LABEL>:USE $ID"
        else
            echo "item: $LABEL:USE $ID"
        fi
        R=$((R + 1))
        if [ -n "$NOTE" ]; then
            echo "text:  $NOTE"
            R=$((R + 1))
        fi
    done < "$OUT.list"
    $B rm -f "$OUT.list"
}

show_menu() {
    # нет списка: ошибка сверху, страницы со списком не будет
    PRESETS="$(svc presets 2>"$OUT")"
    RC=$?
    if [ $RC -ne 0 ] || [ -z "$PRESETS" ]; then
        show_err
        PRESETS=""
    fi
    BRIEF="$(svc brief 2>"$OUT")"
    RC=$?
    RUNNING="$(field running)"
    if [ $RC -ne 0 ] || [ -z "$RUNNING" ]; then
        echo "text:DNS: $(T "no answer" "нет ответа")"
        [ $RC -ne 0 ] && show_err
        return
    fi
    PRESET="$(field preset)"
    NAME="$(field label)"
    [ -n "$NAME" ] || NAME="$PRESET"
    if [ "$RUNNING" = 1 ]; then
        echo "text:DNS: $(T "on" "включен")"
    else
        echo "text:DNS: $(T "off" "выключен")"
    fi
    [ -n "$NAME" ] && echo "text:$(line "$(short "$NAME")")"
    NOTE="$(note "$NAME")"
    [ -n "$NOTE" ] && echo "text:  $NOTE"
    if [ "$RUNNING" = 1 ]; then
        echo "item:$(T "Turn off" "Выключить"):STOP"
    else
        echo "item:$(T "Turn on" "Включить"):START"
    fi
    if [ "$(field adblock)" = 1 ]; then
        echo "item:<$(T "No ads" "Без рекламы")>:ADBLOCK off"
    else
        echo "item: $(T "No ads" "Без рекламы"):ADBLOCK on"
    fi
    [ -n "$PRESETS" ] && show_list
}

case "$1" in
    "") show_menu ;;
    START)
        # start не удался - флаг снимается: иначе служба запускалась бы при загрузке,
        # а экран показывал бы "выключен"
        (
            svc enable > "$OUT" 2>&1 || exit 1
            svc start > "$OUT" 2>&1 && exit 0
            rc=$?
            svc disable > /dev/null 2>&1
            exit $rc
        )
        report $?
        show_menu
    ;;
    STOP)
        (
            svc stop > "$OUT" 2>&1 || exit 1
            svc disable > "$OUT" 2>&1
        )
        report $?
        show_menu
    ;;
    USE)
        case "$2" in
            ''|*[!A-Za-z0-9_.-]*) echo "text:$(T "Bad server" "Неверный сервер")"; exit 1 ;;
        esac
        ( svc use-preset "$2" > "$OUT" 2>&1 )
        report $?
        show_menu
    ;;
    ADBLOCK)
        case "$2" in
            on|off) ;;
            *) echo "text:$(T "wrong command" "Неверная команда")"; exit 1 ;;
        esac
        ( svc adblock "$2" > "$OUT" 2>&1 )
        report $?
        show_menu
    ;;
    *)
        echo "text:$(T "wrong command" "Неверная команда")"
        exit 1
    ;;
esac
