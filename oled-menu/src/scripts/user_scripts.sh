#!/bin/sh
# Свои скрипты: встроенные из /app/hijacks/scripts/user и пользовательские из /online/scripts.
# Подпись встроенного - строка "# name_ru:" / "# name_en:" в его начале.
# VPN.sh мода (/online/vpn.conf, WireGuard) показывается как "VPN мода", только если есть конфиг.

# апплеты только через busyboxx: у uid 1000 голые head, tr и др. из PATH не запускаются
B="${HIJ_B:-/system/bin/busyboxx}"
[ -x "$B" ] || B=/system/bin/busybox

# язык меню: HIJ_LANG=en - английский, иначе русский
T() { if [ "$HIJ_LANG" = en ]; then echo "$1"; else echo "$2"; fi; }

BUILTIN="${HIJ_USER_BUILTIN:-/app/hijacks/scripts/user}"
USER_DIR="${HIJ_USER_DIR:-/online/scripts}"

# подпись по имени файла: первая буква заглавная, _ -> пробел, без .sh
title_from_name() {
    FIRST="$(echo -n "${1:0:1}" | $B sed 'y/abcdefghijklmnopqrstuvwxyz/ABCDEFGHIJKLMNOPQRSTUVWXYZ/')"
    REST="$(echo -n "${1:1}" | $B sed 's/_/ /g' | $B sed 's/.sh$//')"
    echo "${FIRST}${REST}"
}

# подпись встроенного скрипта из строки name_ru/name_en
title_builtin() {
    key=name_ru
    [ "$HIJ_LANG" = en ] && key=name_en
    t="$($B sed -n "s/^# $key: //p" "$1" | $B head -n 1)"
    [ -n "$t" ] && echo "$t" || title_from_name "$($B basename "$1")"
}

$B mkdir -p "$USER_DIR"
if ! $B chmod 755 "$USER_DIR"/*.sh 2>/dev/null; then
    # скриптов нет: положить пример и VPN.sh мода, как раньше
    [ -f "$USER_DIR/example.sh" ] || { $B cp /app/hijacks/scripts/example.sh "$USER_DIR/example.sh" && $B chmod 755 "$USER_DIR/example.sh"; }
    [ -f "$USER_DIR/VPN.sh" ] || { $B cp /app/hijacks/scripts/vpn.sh "$USER_DIR/VPN.sh" && $B chmod 755 "$USER_DIR/VPN.sh"; }
fi

echo "text:$(T "Scripts:" "Скрипты:")"
for f in "$BUILTIN"/*.sh; do
    [ -f "$f" ] || continue
    echo "item:$(title_builtin "$f"):$f"
done
cd "$USER_DIR" 2>/dev/null && for script in *.sh; do
    [ -f "$script" ] || continue
    # встроенные копии из старых версий (pinger.sh, fix_cell.sh) не дублировать
    [ -f "$BUILTIN/$script" ] && continue
    case "$script" in
        VPN.sh)
            [ -f /online/vpn.conf ] || continue
            echo "item:$(T "Mod VPN" "VPN мода"):$USER_DIR/$script"
            ;;
        example.sh)
            echo "item:$(T Example Пример):$USER_DIR/$script"
            ;;
        *)
            echo "item:$(title_from_name "$script"):$USER_DIR/$script"
            ;;
    esac
done
echo "text:$(T "Own scripts: /online/scripts" "Свои: /online/scripts")"
