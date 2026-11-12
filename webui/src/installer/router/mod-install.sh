#!/system/bin/busyboxx sh
# Установка веб-панели на роутере. Запускает install.sh с компьютера:
# пакет распакован в /tmp/mod-inst, рядом каталог files/ — дерево от корня роутера.
#
#   busyboxx sh mod-install.sh [--dry-run]
#
# Порядок: проверка путей и места → запись отката в /online/mod/bak/install-<время>/
# → остановка помощника и пакетов → запись на разделы → сверка → только чтение
# → запуск помощника и пакетов. При сбое на середине файлы возвращаются из записи.

HERE=$(/system/bin/busyboxx dirname "$0")
HERE=$(cd "$HERE" && pwd)
. "$HERE/mod-lib.sh"
mod_applets

DRY=0
for a in "$@"; do
	case "$a" in
	--dry-run) DRY=1 ;;
	*) die "неизвестный ключ: $a" ;;
	esac
done

[ "$(id -u)" = 0 ] || die "нужен root"
[ -d "$HERE/files" ] || die "в пакете нет каталога files"

LIST=/tmp/mod-inst.$$.list
trap 'rm -f $LIST $LIST.*' EXIT
cd "$HERE/files" || die "нет каталога $HERE/files"

odd=$(find . ! -type f ! -type d)
[ -z "$odd" ] || die "в пакете есть не файлы и не каталоги: $odd"
find . -type f | sed 's|^\./|/|' | sort > $LIST
[ -s $LIST ] || die "пакет пуст"

bad=""
while read -r f; do mod_allowed "$f" || bad="$bad $f"; done < $LIST
[ -z "$bad" ] || die "в пакете пути вне разрешенных каталогов:$bad"

# Что новое, что заменяется.
: > $LIST.new; : > $LIST.rep
while read -r f; do
	if [ -e "$f" ]; then echo "$f" >> $LIST.rep; else echo "$f" >> $LIST.new; fi
done < $LIST
n_all=$(wc -l < $LIST); n_new=$(wc -l < $LIST.new); n_rep=$(wc -l < $LIST.rep)

# Нужно места по разделам, КиБ. На /online еще копия заменяемых файлов.
: > $LIST.need
while read -r f; do echo "$(mod_fs "$f") $(mod_size_kb ".$f")"; done < $LIST >> $LIST.need
while read -r f; do echo "/online $(mod_size_kb "$f")"; done < $LIST.rep >> $LIST.need
FSS=$(awk '{ print $1 }' $LIST.need | sort -u)

say "Пакет: $n_all файлов, новых $n_new, заменяемых $n_rep."
say ""
say "Место (КиБ):"
short=0
for fs in $FSS; do
	need=$(awk -v fs="$fs" '$1 == fs { s += $2 } END { print s + 0 }' $LIST.need)
	free=$(mod_free_kb "$fs")
	case "$free" in ''|*[!0-9]*) die "не удалось узнать свободное место на $fs" ;; esac
	if [ $((need + 256)) -gt "$free" ]; then
		say "  $fs: нужно $need, свободно $free — НЕ ХВАТАЕТ"
		short=1
	else
		say "  $fs: нужно $need, свободно $free"
	fi
done
say ""
say "Файлы:"
while read -r f; do
	if grep -qxF "$f" $LIST.rep; then say "  замена  $f"; else say "  новый   $f"; fi
done < $LIST
say ""
[ $short = 0 ] || die "не хватает места, ничего не изменено"

# Прерванная установка (обрыв связи, перезагрузка) — сначала откат.
for r in $BAK/install-*; do
	[ -d "$r" ] || continue
	[ -f "$r/done" ] && continue
	[ $DRY = 1 ] && { warn "есть незавершенная установка $r; перед установкой нужен откат"; continue; }
	die "есть незавершенная установка $r; сначала выполните откат (rollback.sh)"
done

HAS_SVC=0
grep -q -e '^/online/mod/helper/' -e '^/online/mod/pkg/' -e '^/online/mod/mod-ctl.sh$' $LIST && HAS_SVC=1

if [ $DRY = 1 ]; then
	say "Пробный запуск: будут перемонтированы на запись: $(echo "$FSS" | grep -v '^/online$' | tr '\n' ' ')"
	[ $HAS_SVC = 1 ] && say "Пробный запуск: перед записью будут остановлены помощник и пакеты, после — запущены."
	say "Пробный запуск: ничего не изменено."
	exit 0
fi

# Запись для отката. Собирается во временном каталоге и переименовывается
# в install-<время> только целиком: неполной записи откат не увидит.
# Недособранные записи прошлых запусков: до записи на разделы дело не дошло, удалить.
rm -rf $BAK/.new-install-*
T=$(date +%Y%m%d-%H%M%S)
REC=$BAK/.new-install-$T
abort() { rm -rf "$REC"; die "$1; ничего не изменено"; }
mkdir -p $REC || die "не удалось создать $REC"
chmod 700 $BAK $REC
cp $LIST.new $REC/new.list
cp $LIST.rep $REC/replaced.list
: > $REC/newdirs.list
: > $REC/dirmodes.list
if [ -s $LIST.rep ]; then
	# Пробелов в путях нет (проверено mod_allowed), список можно передать аргументами.
	tar -cf $REC/saved.tar -C / $(sed 's|^/||' $LIST.rep) || abort "не удалось сохранить заменяемые файлы"
	n_saved=$(tar -tf $REC/saved.tar | wc -l)
	[ "$n_saved" = "$n_rep" ] || abort "в копии $n_saved файлов вместо $n_rep"
fi
# Каталоги, которых еще нет: их удалит откат.
while read -r f; do
	d=$(dirname "$f")
	while [ ! -d "$d" ] && [ "$d" != / ]; do echo "$d"; d=$(dirname "$d"); done
done < $LIST.new | sort -u > $REC/newdirs.list
# Права каталогов, которые установщик закроет от записи посторонним.
for d in $MOD $MOD/helper $MOD/helper/www $MOD/helper/www/cgi-bin $MOD/pkg $MOD/pkg/*; do
	[ -d "$d" ] && echo "$(stat -c '%a %u:%g' "$d") $d" >> $REC/dirmodes.list
done
{
	echo "время: $T"
	[ -f "$HERE/files/online/mod/VERSION" ] && cat "$HERE/files/online/mod/VERSION"
} > $REC/info
mv $REC $BAK/install-$T || abort "не удалось переименовать $REC"
REC=$BAK/install-$T
say "Запись для отката: $REC"

if [ $HAS_SVC = 1 ] && [ -f $MOD/mod-ctl.sh ]; then
	say "Остановка помощника и пакетов:"
	$BB sh $MOD/mod-ctl.sh stop
fi

# Сбой посреди записи: вернуть все по записи и выйти.
fail() {
	warn "$1"
	warn "возвращаю файлы из $REC"
	mod_undo_record $REC
	for fs in $FSS; do mod_ro "$fs"; done
	mv $REC $BAK/failed-install-$T 2>/dev/null
	die "установка не выполнена, файлы возвращены (запись: $BAK/failed-install-$T)"
}

say "Разделы:"
for fs in $FSS; do mod_rw "$fs"; done

say "Копирование..."
while read -r f; do
	d=$(dirname "$f")
	[ -d "$d" ] || mkdir -p "$d" || fail "не удалось создать каталог $d"
	cp ".$f" "$f.modnew" || fail "не удалось записать $f"
	if [ "$f" = /app/html/redirect.html ] && [ -e "$f" ]; then
		# Стоковый файл: права и владелец как были.
		chmod "$(stat -c %a "$f")" "$f.modnew"
		chown "$(stat -c %u:%g "$f")" "$f.modnew"
	else
		chmod "$(stat -c %a ".$f")" "$f.modnew"
		chown 0:0 "$f.modnew"
	fi
	mv -f "$f.modnew" "$f" || fail "не удалось заменить $f"
done < $LIST

# Новые каталоги и каталоги помощника и пакетов: root, без записи для web (uid 1000).
while read -r d; do chown 0:0 "$d"; chmod 755 "$d"; done < $REC/newdirs.list
for d in $MOD $MOD/helper $MOD/helper/www $MOD/helper/www/cgi-bin $MOD/pkg $MOD/pkg/*; do
	[ -d "$d" ] && { chown 0:0 "$d"; chmod 755 "$d"; }
done
sync

# Сверка с пакетом.
diffs=0
while read -r f; do
	cmp -s ".$f" "$f" || { warn "не совпадает с пакетом: $f"; diffs=$((diffs + 1)); }
done < $LIST
[ $diffs = 0 ] || fail "после записи $diffs файлов не совпадают с пакетом"
say "Сверка: все $n_all файлов совпадают с пакетом."

say "Разделы:"
for fs in $FSS; do mod_ro "$fs"; done
date +%Y%m%d-%H%M%S > $REC/done

if [ $HAS_SVC = 1 ] && [ -f $MOD/mod-ctl.sh ]; then
	say "Запуск помощника и пакетов:"
	$BB sh $MOD/mod-ctl.sh start
	# Запас случайности для следующей загрузки; сразу после включения он слабый, его сделает mod-ctl boot.
	if [ ! -s $MOD/conf/random-seed ] && [ "$(cut -d. -f1 /proc/uptime)" -ge 300 ]; then
		$BB sh $MOD/mod-ctl.sh seed-save
	fi
fi
say ""
say "Установлено. Откат: rollback.sh на компьютере или на роутере: busyboxx sh $MOD/mod-uninstall.sh"
