#!/system/bin/busyboxx sh
# Откат веб-панели на роутере.
#
#   busyboxx sh mod-uninstall.sh [--last] [--dry-run]
#
# Без ключей отменяет все установки по записям /online/mod/bak/install-*,
# от последней к первой, и возвращает роутер к состоянию до первой установки.
# --last    отменить только последнюю установку (вернуть предыдущую версию)
# --dry-run показать, что будет сделано, ничего не менять
#
# Не трогает /online/scripts, /online/modwebui_backup.tar, /online/atp_backup,
# настройки /online/mod/conf и записи /online/mod/bak.

HERE=$(/system/bin/busyboxx dirname "$0")
HERE=$(cd "$HERE" && pwd)
. "$HERE/mod-lib.sh"
mod_applets

LAST=0
DRY=0
for a in "$@"; do
	case "$a" in
	--last) LAST=1 ;;
	--dry-run) DRY=1 ;;
	*) die "неизвестный ключ: $a" ;;
	esac
done
[ "$(id -u)" = 0 ] || die "нужен root"

RECS=$(ls -d $BAK/install-* 2>/dev/null | sort -r)
[ $LAST = 1 ] && RECS=$(echo "$RECS" | head -n 1)
if [ -z "$RECS" ]; then
	say "Записей установки в $BAK нет: откатывать нечего."
	exit 0
fi

# Помощник и пакеты останавливаются, а цепочки MOD_* снимаются, только если
# отменяемые установки ставили их файлы. Откат одной SPA их не трогает.
SVC=0
for r in $RECS; do
	cat "$r/new.list" "$r/replaced.list" | grep -q -e '^/online/mod/helper/' \
		-e '^/online/mod/pkg/' -e '^/online/mod/mod-ctl.sh$' && SVC=1
done

say "Будут отменены установки (от последней к первой):"
for r in $RECS; do
	st="завершена"; [ -f "$r/done" ] || st="НЕ завершена"
	say "  $(basename "$r") ($st): удалить $(wc -l < "$r/new.list") файлов, вернуть $(wc -l < "$r/replaced.list")"
done
CH=$(mod_list_chains)
if [ -n "$CH" ]; then
	say "Цепочки iptables MOD_* (снимаются, если отменяется установка помощника или пакетов):"
	say "$CH"
fi

if [ $DRY = 1 ]; then
	if [ $SVC = 1 ]; then say "Помощник и пакеты будут остановлены."; else say "Помощник, пакеты и цепочки не затрагиваются."; fi
	for r in $RECS; do
		say ""
		say "$(basename "$r"):"
		while read -r f; do [ -n "$f" ] && say "  удалить  $f"; done < "$r/new.list"
		while read -r f; do [ -n "$f" ] && say "  вернуть  $f"; done < "$r/replaced.list"
		while read -r d; do [ -n "$d" ] && say "  каталог  $d"; done < "$r/newdirs.list"
	done
	say ""
	say "Пробный запуск: ничего не изменено."
	exit 0
fi


if [ $SVC = 1 ]; then
	say ""
	say "Остановка помощника и пакетов:"
	if [ -f $MOD/mod-ctl.sh ]; then
		$BB sh $MOD/mod-ctl.sh stop
	else
		mod_kill_pidfiles
	fi
	say "  готово"
	mod_drop_chains
fi

FSS=$(for r in $RECS; do mod_record_fs "$r"; done | sort -u)
say "Разделы:"
for fs in $FSS; do mod_rw "$fs"; done

err=0
mkdir -p $BAK/undone
for r in $RECS; do
	say "Отмена $(basename "$r")"
	if mod_undo_record "$r"; then
		mv "$r" "$BAK/undone/$(basename "$r")"
	else
		warn "отмена $(basename "$r") прошла с ошибками, запись оставлена: $r"
		err=1
	fi
done
sync

say "Разделы:"
for fs in $FSS; do mod_ro "$fs"; done

# Если откатили только последнюю версию, запустить предыдущую.
if [ $LAST = 1 ] && [ $SVC = 1 ] && [ -f $MOD/mod-ctl.sh ]; then
	say "Запуск предыдущей версии помощника и пакетов:"
	$BB sh $MOD/mod-ctl.sh start
fi

say ""
if [ -d $MOD ]; then
	say "Осталось в $MOD (настройки и записи установок, откат их не удаляет):"
	ls -la $MOD | awk 'NR > 1 && $NF != "." && $NF != ".." { print "  " $0 }'
fi
[ $err = 0 ] || die "откат прошел с ошибками, см. сообщения выше"
if [ $LAST = 0 ]; then
	# Временное в ОЗУ: PID-каталог, журнал запуска, ссылки на busybox.
	rm -f $RUN/seed-later
	rmdir $RUN 2>/dev/null
	# Запас случайности больше не нужен; /dev/random — снова настоящий.
	rm -f $MOD/conf/random-seed $MOD/conf/random-seed.tmp
	grep -q ' /dev/random ' /proc/mounts && $BB umount /dev/random
	rm -f /tmp/mod-ctl.log /tmp/mod-ctl.log.old
	$BB rm -rf /tmp/mod-bin
fi
say "Откат выполнен."
