# Общие функции установки, отката и запуска веб-панели на роутере.
# Подключается из mod-install.sh, mod-uninstall.sh, mod-ctl.sh: . mod-lib.sh
# Оболочка — busybox ash (/system/bin/busyboxx sh).

BB=/system/bin/busyboxx
MOD=/online/mod
BAK=$MOD/bak
RUN=/var/run/mod
# Где помощник и пакеты держат PID-файлы.
PIDGLOBS="$RUN/*.pid /tmp/mod/*/*.pid /var/modhelper/*.pid"
CONF=$MOD/conf

say()  { echo "$*"; }
warn() { echo "Внимание: $*" >&2; }
die()  { echo "Ошибка: $*" >&2; exit 1; }

# Команды busybox через свой каталог ссылок: в PATH роутера есть урезанные
# версии из toolbox, у которых другие ключи.
mod_applets() {
	_d=/tmp/mod-bin
	# /tmp открыта всем: чужой каталог с подмененными командами не использовать
	if [ -e $_d ] || [ -L $_d ]; then
		case "$($BB stat -c '%u %a' $_d 2>/dev/null)" in
			"0 755") [ -L $_d ] && $BB rm -f $_d ;;
			*) $BB rm -rf $_d ;;
		esac
	fi
	$BB mkdir -p $_d || return 1
	$BB chown 0:0 $_d; $BB chmod 755 $_d
	for _a in awk basename cat chmod chown cmp cp cut date df dirname du find grep \
		gzip head id kill ls md5sum mkdir mount mv readlink rm rmdir sed setsid \
		sleep sort stat sync tail tar timeout touch tr uniq wc xargs pidof ps; do
		[ -e $_d/$_a ] || $BB ln -s $BB $_d/$_a
	done
	PATH=$_d:/system/bin:/system/xbin:/app/bin:/bin:/sbin
	export PATH
	umask 022
}

# Куда установщику можно писать и откуда откату можно удалять.
# Все остальное (сток, /online/scripts, /online/atp_backup, перехватчики экрана) — нельзя.
mod_allowed() {
	case "$1" in
	*/../*|*/./*|*' '*|*'	'*|*'
'*) return 1 ;;
	/app/html/redirect.html) return 0 ;;
	/app/html/api/mod/?*) return 0 ;;
	/app/html/api/vsim/config-vsim.lua|/app/html/api/vsim/config-vsim.json.lua) return 0 ;;
	/app/webroot/WebApp/common/js/mod/?*) return 0 ;;
	/app/webroot/WebApp/common/css/mod/?*) return 0 ;;
	/app/webroot/WebApp/common/html/mod.html.gz) return 0 ;;
	/system/etc/autorun.d/mod.sh) return 0 ;;
	/online/mod/helper/?*|/online/mod/pkg/?*) return 0 ;;
	/online/mod/mod-ctl.sh|/online/mod/mod-uninstall.sh|/online/mod/mod-lib.sh|/online/mod/VERSION) return 0 ;;
	esac
	return 1
}

# Раздел, на котором лежит путь.
mod_fs() {
	case "$1" in
	/app/webroot/*) echo /app/webroot ;;
	/app/*) echo /app ;;
	/system/*) echo /system ;;
	/online/*) echo /online ;;
	*) echo / ;;
	esac
}

mod_dev() {
	case "$1" in
	/app/webroot) echo /dev/block/mtdblock25 ;;
	/app) echo /dev/block/mtdblock24 ;;
	/system) echo /dev/block/mtdblock26 ;;
	esac
}

mod_is_rw() { grep -q " $1 yaffs2 rw" /proc/mounts; }

# Перемонтировать на запись. /online всегда на запись.
mod_rw() {
	[ "$1" = /online ] && return 0
	mod_is_rw "$1" && return 0
	mount -o remount,rw "$(mod_dev "$1")" "$1" || die "не удалось перемонтировать $1 на запись"
	say "  $1: на запись"
}

# Вернуть только чтение. Если раздел занят — предупредить, но не падать.
mod_ro() {
	[ "$1" = /online ] && return 0
	sync
	mod_is_rw "$1" || return 0
	if mount -o remount,ro "$(mod_dev "$1")" "$1" 2>/dev/null; then
		say "  $1: только чтение"
		return 0
	fi
	sleep 1; sync
	if mount -o remount,ro "$(mod_dev "$1")" "$1" 2>/dev/null; then
		say "  $1: только чтение"
		return 0
	fi
	warn "$1 занят и остался на запись; вернется в «только чтение» после перезагрузки"
	return 1
}

# Свободно на разделе, КиБ.
mod_free_kb() { df -k "$1" | awk 'END { print $(NF-2) }'; }

# Сколько места займет файл на yaffs2, КиБ: страницы по 2 КиБ плюс заголовок.
mod_size_kb() {
	_s=$(stat -c %s "$1")
	echo $(( (_s + 2047) / 2048 * 2 + 2 ))
}

# Остановить процессы по PID-файлам из $PIDGLOBS.
# Убивает только процесс, в командной строке которого есть /online/mod/,
# чтобы устаревший PID не попал в чужой процесс.
mod_kill_pidfiles() {
	for _pf in $PIDGLOBS; do
		[ -f "$_pf" ] || continue
		_pid=$(head -n 1 "$_pf" 2>/dev/null)
		case "$_pid" in ''|*[!0-9]*) continue ;; esac
		if [ -r /proc/$_pid/cmdline ] && tr '\000' ' ' < /proc/$_pid/cmdline | grep -q '/online/mod/'; then
			kill "$_pid" 2>/dev/null
			_i=0
			while [ -d /proc/$_pid ] && [ $_i -lt 10 ]; do sleep 1; _i=$((_i + 1)); done
			[ -d /proc/$_pid ] && kill -9 "$_pid" 2>/dev/null
			say "  остановлен $(basename "$_pf" .pid) (PID $_pid)"
			rm -f "$_pf"
		elif [ ! -d /proc/$_pid ]; then
			rm -f "$_pf"
		fi
	done
}

# Снять все цепочки MOD_* в iptables и ip6tables: сначала переходы в них
# из любых цепочек (по номерам строк), потом очистить и удалить сами цепочки.
mod_drop_chains() {
	for _cmd in iptables ip6tables; do
		command -v $_cmd >/dev/null 2>&1 || continue
		for _t in raw mangle nat filter; do
			_all=$($_cmd -t $_t -L -n 2>/dev/null | awk '/^Chain /{ print $2 }') || continue
			_mods=$(echo "$_all" | grep '^MOD_')
			[ -n "$_mods" ] || continue
			for _c in $_all; do
				for _n in $($_cmd -t $_t -L "$_c" -n --line-numbers 2>/dev/null |
					awk 'NR > 2 && $2 ~ /^MOD_/ { print $1 }' | sort -rn); do
					$_cmd -t $_t -D "$_c" "$_n"
				done
			done
			for _c in $_mods; do $_cmd -t $_t -F "$_c"; done
			for _c in $_mods; do
				$_cmd -t $_t -X "$_c" && say "  снята цепочка $_cmd -t $_t $_c"
			done
		done
	done
}

# Список цепочек MOD_* (для показа).
mod_list_chains() {
	for _cmd in iptables ip6tables; do
		command -v $_cmd >/dev/null 2>&1 || continue
		for _t in raw mangle nat filter; do
			$_cmd -t $_t -L -n 2>/dev/null | awk -v p="$_cmd -t $_t" '/^Chain MOD_/{ print "  " p " " $2 }'
		done
	done
}

# Отменить одну установку по ее записи в /online/mod/bak/install-*:
# удалить новые файлы, вернуть замененные из saved.tar, удалить созданные
# каталоги, вернуть права каталогов. Разделы уже должны быть на запись.
mod_undo_record() {
	_rec=$1
	_err=0
	if [ -f "$_rec/new.list" ]; then
		while read -r _f; do
			[ -n "$_f" ] || continue
			if ! mod_allowed "$_f"; then
				warn "пропущен путь вне разрешенных каталогов: $_f"
				continue
			fi
			rm -f "$_f" "$_f.modnew" || _err=1
		done < "$_rec/new.list"
	fi
	if [ -s "$_rec/replaced.list" ]; then
		while read -r _f; do rm -f "$_f.modnew"; done < "$_rec/replaced.list"
		tar -xf "$_rec/saved.tar" -C / || { warn "не удалось распаковать $_rec/saved.tar"; _err=1; }
	fi
	if [ -s "$_rec/newdirs.list" ]; then
		sort -r "$_rec/newdirs.list" | while read -r _d; do
			[ -d "$_d" ] || continue
			# Флаг включения пакета — состояние, в пакете его нет; каталог пакета
			# создан установкой, значит и флаг уходит вместе с ним.
			case "$_d" in /online/mod/pkg/?*) rm -f "$_d/enabled" ;; esac
			rmdir "$_d" 2>/dev/null || warn "каталог не пуст, оставлен: $_d"
		done
	fi
	if [ -s "$_rec/dirmodes.list" ]; then
		while read -r _m _o _d; do
			[ -d "$_d" ] || continue
			chmod "$_m" "$_d"; chown "$_o" "$_d"
		done < "$_rec/dirmodes.list"
	fi
	return $_err
}

# Разделы, которых касается запись установки (по ее спискам).
mod_record_fs() {
	cat "$1/new.list" "$1/replaced.list" "$1/newdirs.list" 2>/dev/null |
		while read -r _f; do [ -n "$_f" ] && mod_fs "$_f"; done
}
