#!/system/bin/busyboxx sh
# Установка секретного меню на E5785Lh-23c (мод bay3255 v5).
# Запуск на роутере из каталога набора: busyboxx sh install.sh
#   SMS=1   - поставить и SMS/USSD: хук в процессе sms (обертка /app/bin/sms -> sms.orig);
#   DEBUG=0 - без файла /app/hijacks/bootanim/debug (журнал /var/hijack_bootanim.log выключен);
#   DRY=1   - только проверки, без изменений;
#   FORCE=1 - ставить, даже если текущие файлы не совпадают ни с одной строкой ORIG.
# Перед заменой копирует /app/hijacks/lib/*.so и все заменяемое в /online/hijacks_backup_<дата>/.
# Уже стоящую версию обновляет: меняет только файлы с другим md5.
# Oled и sms не перезапускает: новое начнет работать после перезагрузки роутера.

BB=/system/bin/busyboxx
APPDEV=/dev/block/mtdblock24
APP=/app
TMP=/tmp/hij_install

say() { echo "install: $*"; }
die() { echo "install: ОШИБКА: $*" >&2; exit 1; }

[ -x "$BB" ] || die "нет $BB"
HERE=$(cd "$($BB dirname "$0")" && pwd)
MAN="$HERE/MANIFEST"
SRC="$HERE/files"
[ -f "$MAN" ] || die "нет $MAN"
$BB stat -c %a / >/dev/null 2>&1 || die "в $BB нет stat -c"
$BB mkdir -p "$TMP" || die "не создать $TMP"

md5() { $BB md5sum "$1" | $BB cut -d' ' -f1; }
rel_of() { echo "${1#$APP/}"; }

COMPS=" core "
[ "$DEBUG" = 0 ] || COMPS="$COMPS debug "
[ "$SMS" = 1 ] && COMPS="$COMPS sms "

# 1. Набор цел: строки FILE выбранных компонентов
: > "$TMP/files"
: > "$TMP/moves"
need_kb=64
while read -r kind comp dst sum mode size rest; do
    case "$COMPS" in *" $comp "*) ;; *) continue ;; esac
    case "$kind" in
    FILE)
        rel=$(rel_of "$dst")
        [ -f "$SRC/$rel" ] || die "нет файла набора $SRC/$rel"
        [ "$(md5 "$SRC/$rel")" = "$sum" ] || die "md5 не совпадает: $SRC/$rel"
        need_kb=$((need_kb + size / 1024 + 1))
        echo "$dst $sum $mode $size" >> "$TMP/files"
        ;;
    MOVE)
        echo "$dst $sum" >> "$TMP/moves"      # для MOVE: откуда, куда
        ;;
    esac
done < "$MAN"
[ -s "$TMP/files" ] || die "в MANIFEST нет строк FILE"
say "компоненты:$COMPS; набор цел: $($BB wc -l < "$TMP/files") файлов"

# 2. /app смонтирован с ожидаемого раздела
dev=$($BB awk -v a="$APP" '$2 == a {print $1}' /proc/mounts | $BB tail -n 1)
[ "$dev" = "$APPDEV" ] || die "$APP смонтирован с '$dev', ожидался $APPDEV"

# 3. Текущие файлы: известная версия (ORIG) или уже новая
$BB grep '^ORIG ' "$MAN" > "$TMP/orig"
known() {   # known ПУТЬ MD5 - md5 есть среди ORIG для пути
    $BB awk -v p="$1" -v s="$2" '$2 == p && $3 == s {f = 1} END {exit !f}' "$TMP/orig"
}
bad=0
while read -r dst sum mode size; do
    [ -f "$dst" ] || continue
    cur=$(md5 "$dst")
    [ "$cur" = "$sum" ] && continue
    known "$dst" "$cur" && continue
    # sms после установки - обертка, ELF лежит в sms.orig: проверяется ниже, в MOVE
    $BB grep -q "^$dst " "$TMP/moves" && continue
    say "внимание: $dst не совпадает ни с известной, ни с новой версией (md5 $cur)"
    bad=1
done < "$TMP/files"
while read -r from to; do
    if [ -f "$to" ]; then
        known "$from" "$(md5 "$to")" || { say "внимание: $to не известная версия"; bad=1; }
    elif [ -f "$from" ]; then
        known "$from" "$(md5 "$from")" || { say "внимание: $from не известная версия"; bad=1; }
    else
        die "нет ни $from, ни $to"
    fi
done < "$TMP/moves"
if [ "$bad" = 1 ] && [ "$FORCE" != 1 ]; then
    die "текущие файлы отличаются от известных; проверьте вручную или запустите с FORCE=1"
fi

# что на самом деле меняется
: > "$TMP/todo"
while read -r dst sum mode size; do
    if [ ! -e "$dst" ] || [ "$(md5 "$dst")" != "$sum" ]; then
        echo "$dst $sum $mode $size" >> "$TMP/todo"
    else
        say "уже стоит: $dst"
    fi
done < "$TMP/files"
: > "$TMP/todo_moves"
while read -r from to; do
    [ -f "$to" ] || echo "$from $to" >> "$TMP/todo_moves"
done < "$TMP/moves"
if [ ! -s "$TMP/todo" ] && [ ! -s "$TMP/todo_moves" ]; then
    $BB rm -rf "$TMP"
    say "все файлы уже стоят, менять нечего"
    exit 0
fi
say "к записи: $($BB wc -l < "$TMP/todo") файлов, переименований: $($BB wc -l < "$TMP/todo_moves")"

# 4. Место: третье поле с конца последней строки df (busybox может перенести длинное имя)
free_kb() { $BB df -k "$1" | $BB tail -n 1 | $BB awk '{print $(NF-2)}'; }
app_free=$(free_kb "$APP")
online_free=$(free_kb /online)
backup_kb=$(( $($BB du -sk $APP/hijacks/lib | $BB cut -f1) + 64 ))
while read -r dst sum mode size; do
    [ -f "$dst" ] && backup_kb=$((backup_kb + $($BB du -sk "$dst" | $BB cut -f1)))
done < "$TMP/todo"
while read -r from to; do
    backup_kb=$((backup_kb + $($BB du -sk "$from" | $BB cut -f1)))
done < "$TMP/todo_moves"
[ -n "$app_free" ] && [ "$app_free" -ge "$need_kb" ] || die "мало места в $APP: свободно ${app_free} КБ, нужно ${need_kb} КБ"
[ -n "$online_free" ] && [ "$online_free" -ge "$backup_kb" ] || die "мало места в /online: свободно ${online_free} КБ, нужно ${backup_kb} КБ"
say "место: $APP свободно ${app_free} КБ (нужно ${need_kb}), /online свободно ${online_free} КБ (нужно ${backup_kb})"

if [ "$DRY" = 1 ]; then
    $BB rm -rf "$TMP"
    say "DRY=1: проверки пройдены, изменений нет"
    exit 0
fi

# 5. Бэкап в /online: lib/*.so и все, что будет заменено или переименовано
B=/online/hijacks_backup_$($BB date +%Y%m%d_%H%M%S)
$BB mkdir -p "$B/lib" "$B/files" || die "не создать $B"
$BB cp -p $APP/hijacks/lib/*.so "$B/lib/" || die "не скопировать $APP/hijacks/lib/*.so"
$BB cp -p "$MAN" "$B/MANIFEST.install"
: > "$B/STATE"
# каталоги, которых нет (уже существующий, даже пустой, новым не считается);
# каждый один раз, родитель раньше вложенного: sort -u ставит префикс первым
: > "$TMP/dirs"
while read -r dst sum mode size; do
    d=$($BB dirname "$dst")
    while [ "$d" != "$APP" ] && [ "$d" != / ] && [ ! -d "$d" ]; do
        echo "$d" >> "$TMP/dirs"
        d=$($BB dirname "$d")
    done
done < "$TMP/todo"
$BB sort -u "$TMP/dirs" | while read -r d; do
    echo "NEWDIR $d"
done >> "$B/STATE"
while read -r dst sum mode size; do
    rel=$(rel_of "$dst")
    $BB grep -q "^$dst " "$TMP/todo_moves" && continue     # его вернет MOVED
    if [ -e "$dst" ]; then
        $BB mkdir -p "$B/files/$($BB dirname "$rel")"
        $BB cp -p "$dst" "$B/files/$rel" || die "не скопировать $dst в бэкап"
        echo "REPLACED $dst $(md5 "$dst")" >> "$B/STATE"
    else
        echo "NEW $dst" >> "$B/STATE"
    fi
done < "$TMP/todo"
while read -r from to; do
    rel=$(rel_of "$from")
    $BB mkdir -p "$B/files/$($BB dirname "$rel")"
    $BB cp -p "$from" "$B/files/$rel" || die "не скопировать $from в бэкап"
    echo "MOVED $from $to $(md5 "$from")" >> "$B/STATE"
done < "$TMP/todo_moves"
(cd "$B" && $BB find lib files -type f -exec $BB md5sum {} \; > "$B/md5.txt")
$BB sync
for f in $APP/hijacks/lib/*.so; do
    [ "$(md5 "$f")" = "$(md5 "$B/lib/$($BB basename "$f")")" ] || die "бэкап $f не совпадает"
done
say "бэкап: $B"

# 6. Запись в /app
$BB mount -o remount,rw $APPDEV $APP || die "не перемонтировать $APP на запись"
trap '$BB sync; $BB mount -o remount,ro '"$APPDEV $APP" EXIT

dir_owner=$($BB stat -c %u:%g $APP/hijacks)
lib_owner=$($BB stat -c %u:%g $APP/hijacks/lib/oled_hijack.so 2>/dev/null || echo "$dir_owner")
$BB grep '^NEWDIR ' "$B/STATE" | $BB cut -d' ' -f2 | $BB sort -u > "$TMP/newdirs"
while read -r d; do
    [ -d "$d" ] && continue
    $BB mkdir -p "$d" || die "не создать $d"
    $BB chmod 0755 "$d"
    $BB chown "$dir_owner" "$d"
done < "$TMP/newdirs"

# put ИСТОЧНИК ЦЕЛЬ MD5 ПРАВА ВЛАДЕЛЕЦ: новый файл рядом и rename -
# работающий процесс держит старый файл открытым, перезапись на месте его уронит
put() {
    tmp="$2.new.$$"
    $BB cp "$1" "$tmp" || die "не скопировать $1"
    $BB chmod "$4" "$tmp"
    $BB chown "$5" "$tmp"
    $BB sync
    [ "$(md5 "$tmp")" = "$3" ] || { $BB rm -f "$tmp"; die "после записи md5 не совпадает: $tmp"; }
    $BB mv -f "$tmp" "$2" || die "не переименовать $tmp в $2"
}

while read -r dst sum mode size; do
    rel=$(rel_of "$dst")
    move_to=$($BB awk -v p="$dst" '$1 == p {print $2}' "$TMP/todo_moves")
    if [ -n "$move_to" ]; then
        # обертка вместо программы: права и владелец программы, программа -> .orig
        mode=$($BB stat -c %a "$dst"); owner=$($BB stat -c %u:%g "$dst")
        tmp="$dst.new.$$"
        $BB cp "$SRC/$rel" "$tmp" && $BB chmod "$mode" "$tmp" && $BB chown "$owner" "$tmp" || die "не подготовить $tmp"
        [ "$(md5 "$tmp")" = "$sum" ] || die "после записи md5 не совпадает: $tmp"
        $BB mv "$dst" "$move_to" || die "не переименовать $dst в $move_to"
        $BB mv -f "$tmp" "$dst" || { $BB mv "$move_to" "$dst"; die "не поставить обертку $dst"; }
        say "записан: $dst ($mode $owner), программа: $move_to"
        continue
    fi
    if [ -e "$dst" ]; then
        mode=$($BB stat -c %a "$dst"); owner=$($BB stat -c %u:%g "$dst")
    else
        owner=$lib_owner
    fi
    put "$SRC/$rel" "$dst" "$sum" "$mode" "$owner"
    say "записан: $dst ($mode $owner)"
done < "$TMP/todo"
$BB sync

# 7. Проверка
fail=0
while read -r dst sum mode size; do
    [ "$(md5 "$dst")" = "$sum" ] || { say "md5 не совпадает: $dst"; fail=1; }
done < "$TMP/files"
while read -r from to; do
    [ -f "$to" ] || { say "нет $to"; fail=1; }
done < "$TMP/moves"
$BB rm -rf "$TMP"
[ "$fail" = 0 ] || die "установка неполная, откат: busyboxx sh $HERE/rollback.sh $B"

say "готово; новое заработает после перезагрузки роутера"
say "откат: busyboxx sh $HERE/rollback.sh $B"
