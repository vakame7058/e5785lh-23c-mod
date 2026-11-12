#!/system/bin/busyboxx sh
# Откат install.sh из бэкапа: busyboxx sh rollback.sh [/online/hijacks_backup_<дата>]
# Без аргумента берет самый новый /online/hijacks_backup_*.
# Возвращает замененные и переименованные файлы, удаляет добавленные и пустые созданные каталоги.
# Другие файлы /app не трогает. Oled и sms не перезапускает: нужна перезагрузка роутера.

BB=/system/bin/busyboxx
APPDEV=/dev/block/mtdblock24
APP=/app

say() { echo "rollback: $*"; }
die() { echo "rollback: ОШИБКА: $*" >&2; exit 1; }

[ -x "$BB" ] || die "нет $BB"
B=$1
[ -n "$B" ] || B=$($BB ls -d /online/hijacks_backup_* 2>/dev/null | $BB sort | $BB tail -n 1)
[ -n "$B" ] && [ -f "$B/STATE" ] || die "нет бэкапа (каталог с файлом STATE)"
say "бэкап: $B"

md5() { $BB md5sum "$1" | $BB cut -d' ' -f1; }
rel_of() { echo "${1#$APP/}"; }

dev=$($BB awk -v a="$APP" '$2 == a {print $1}' /proc/mounts | $BB tail -n 1)
[ "$dev" = "$APPDEV" ] || die "$APP смонтирован с '$dev', ожидался $APPDEV"

# копии в бэкапе целы
while read -r kind a b c; do
    case "$kind" in
    REPLACED) [ "$(md5 "$B/files/$(rel_of "$a")")" = "$b" ] || die "копия в бэкапе испорчена: $a" ;;
    MOVED)    [ "$(md5 "$B/files/$(rel_of "$a")")" = "$c" ] || die "копия в бэкапе испорчена: $a" ;;
    esac
done < "$B/STATE"

$BB mount -o remount,rw $APPDEV $APP || die "не перемонтировать $APP на запись"
trap '$BB sync; $BB mount -o remount,ro '"$APPDEV $APP" EXIT

fail=0
while read -r kind a b c; do
    case "$kind" in
    REPLACED)
        tmp="$a.old.$$"
        # rename, а не перезапись на месте: работающий процесс держит файл открытым
        if $BB cp -p "$B/files/$(rel_of "$a")" "$tmp" && $BB mv -f "$tmp" "$a"; then
            [ "$(md5 "$a")" = "$b" ] && say "возвращен: $a" || { say "md5 не совпадает: $a"; fail=1; }
        else
            say "не вернуть $a"; fail=1
        fi
        ;;
    NEW)
        $BB rm -f "$a" && say "удален: $a"
        ;;
    MOVED)
        # a - программа, b - куда ее переименовали; на месте a стоит обертка
        if [ -f "$b" ] && [ "$(md5 "$b")" = "$c" ]; then
            $BB mv -f "$b" "$a" || { say "не вернуть $b в $a"; fail=1; continue; }
        else
            tmp="$a.old.$$"
            $BB cp -p "$B/files/$(rel_of "$a")" "$tmp" && $BB mv -f "$tmp" "$a" && $BB rm -f "$b" \
                || { say "не вернуть $a"; fail=1; continue; }
        fi
        [ "$(md5 "$a")" = "$c" ] && say "возвращен: $a" || { say "md5 не совпадает: $a"; fail=1; }
        ;;
    esac
done < "$B/STATE"

# созданные каталоги, глубокие первыми
$BB grep '^NEWDIR ' "$B/STATE" | $BB cut -d' ' -f2 | $BB sort -ru > "$B/.dirs"
while read -r d; do
    [ -d "$d" ] && $BB rmdir "$d" 2>/dev/null && say "удален каталог: $d"
done < "$B/.dirs"
$BB rm -f "$B/.dirs"
$BB sync

[ "$fail" = 0 ] || die "откат неполный, копии лежат в $B/lib и $B/files"
say "готово; прежнее вернется после перезагрузки роутера"
