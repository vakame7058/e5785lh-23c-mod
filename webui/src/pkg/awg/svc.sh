#!/system/bin/busyboxx sh
# AmneziaWG: VPN-клиент на роутере: модуль ядра amneziawg.ko, запасной путь — amneziawg-go; настройка через awg.
# Заменяет awg-quick: адрес, MTU, маршруты, NAT для клиентов LAN, DNS, блокировка утечки.
# Договор: svc.sh start|stop|restart|status|enable|disable|dns [on|off]|profiles|list|brief|use ИМЯ|setconf [ИМЯ [ПОДПИСЬ]]|label ИМЯ ПОДПИСЬ|delete ИМЯ
#   split on|off, split-status, split-update ФАЙЛ, split-direct|split-vpn add|del|list [АДРЕС] — раздельный VPN
#   failover on [ИМЯ]|off, failover-status — переключение профиля при обрыве; failover-run — внутренний цикл
#   list  — для меню экрана: строка на профиль «id|подпись|протокол|активный(0|1)», «|» в подписи заменен на «/»
#   brief — для меню экрана: «running=0|1|profile=<id>|label=<подпись>|handshake=<секунд или пусто>|engine=kernel|go|split=0|1»; split=1 — режим включен и список есть
#   код возврата: 0 — успех, 1 — ошибка (первая строка stderr — текст ошибки, без ключей)
#   status печатает running=0|1, enabled=0|1, info=<текст>, rx=<байт>, tx=<байт>, handshake=<секунд назад или пусто>,
#   engine=kernel|go (пусто, если не запущен), engine_fallback=0|1 (1 — при ENGINE=auto модуль не сработал, туннель на go), profile=<активный профиль>, profile_label=<его подпись>, dns=tunnel|operator|dnspkg (пусто, если не запущен), dns_server=<адреса или пусто>
#   профили: CONF_DIR/profiles/ИМЯ.conf (0600, root), подпись — ИМЯ.label (одна строка, 0644), активный — имя в CONF_DIR/active
#   setconf [ИМЯ [ПОДПИСЬ]] читает конфиг .conf со стандартного ввода и пишет профиль ИМЯ (без имени — активный)
#   label ИМЯ ПОДПИСЬ — сменить подпись профиля
# Ключи из конфига не попадают в вывод и журналы.

NAME=awg
umask 077
BB=/system/bin/busyboxx
for a in awk basename cat chmod cut date dirname grep head kill ls mkdir mv rm sed sleep sort tail tr wc; do
	eval "$a() { $BB $a \"\$@\"; }"
done
IPT4=/system/bin/iptables
IPT6=/system/bin/ip6tables
IP=/system/bin/ip

D=$(cd "$(dirname "$0")" && pwd)
RUN=/tmp/mod/$NAME
PIDF=$RUN/amneziawg-go.pid
LOG=$RUN/amneziawg-go.log
STATE=$RUN/state
FLAG=$D/enabled
AWG=$D/bin/awg
SOCK_DIR=/var/run/amneziawg

C_NAT=MOD_AWG_NAT
C_MSS=MOD_AWG_MSS
C_KS=MOD_AWG_KS
C_DNS=MOD_AWG_DNS
C_DNS6=MOD_AWG_DNS6
C_6=MOD_AWG6

. "$D/conf"
DNS_PKG=/online/mod/pkg/dns/svc.sh
# Выбор пользователя (ENGINE, DNS_TUNNEL) лежит вне пакета, установка новой версии его не сбрасывает
SETTINGS=${CONF_DIR:-/online/mod/conf/awg}/settings
[ -r "$SETTINGS" ] && . "$SETTINGS"
SPLIT=${SPLIT:-1}
FAILOVER=${FAILOVER:-1}
FO_PID=/tmp/mod/awg/failover.pid
FO_REASON=/tmp/mod/awg/failover.reason
SPLIT_LIST=${CONF_DIR:-/online/mod/conf/awg}/split-ru.txt
SPLIT_DIRECT=${CONF_DIR:-/online/mod/conf/awg}/split-direct.txt
SPLIT_VPN=${CONF_DIR:-/online/mod/conf/awg}/split-vpn.txt
# Переменные окружения AWG_ENGINE и AWG_KO — для проверок: движок и другой файл модуля.
# Модуль нельзя выгружать: skb с его деструктором могут лежать в очереди модема, выгрузка = паника;
# убрать модуль — только перезагрузкой. Поэтому rmmod здесь нет, stop и смена движка только удаляют интерфейс.
ENGINE=${AWG_ENGINE:-${ENGINE:-go}}
KMOD=${AWG_KO:-$D/amneziawg.ko}
SVCLOG=$RUN/svc.log
# Есть файл — при ENGINE=auto модуль не сработал и туннель на amneziawg-go; живет, пока работает туннель
FALLBACK=$RUN/engine_fallback
CONF_DIR=${CONF_DIR:-/online/mod/conf/awg}
PROF=$CONF_DIR/profiles
ACTIVE_F=$CONF_DIR/active

valid_name() {
	case "$1" in
		"" | *[!a-z0-9_-]*) return 1 ;;
	esac
	[ ${#1} -le 32 ]
}

# Подпись профиля: одна строка без управляющих символов, до 64 символов
valid_label() {
	l=$1
	[ -n "$l" ] || return 1
	case "$l" in *[[:cntrl:]]*) return 1 ;; esac
	[ "$(printf '%s' "$l" | wc -c)" -le 256 ] || return 1
	# символов UTF-8 = байтов, кроме байтов продолжения 128–191 (tr с диапазонами в busybox роутера не работает)
	[ "$(printf '%s' "$l" | $BB od -v -An -tu1 | awk '{for (i = 1; i <= NF; i++) if ($i < 128 || $i >= 192) n++} END {print n + 0}')" -le 64 ]
}

label_of() {
	l=$(head -n1 "$PROF/$1.label" 2>/dev/null)
	[ -n "$l" ] && echo "$l" || echo "$1"
}

set_label() {
	if ! valid_label "$2"; then
		err "неверная подпись: одна строка до 64 символов"
		return 1
	fi
	(umask 022; printf '%s\n' "$2" >"$PROF/$1.label.new") && chmod 644 "$PROF/$1.label.new" && mv "$PROF/$1.label.new" "$PROF/$1.label"
}

active_name() {
	n=$(head -n1 "$ACTIVE_F" 2>/dev/null)
	valid_name "$n" && echo "$n"
}

# Перенос старой раскладки: awg0.conf → profiles/awg2.conf (активный), *.conf.saved → profiles/ИМЯ.conf.
# Содержимое конфигов не читается, только переносится.
migrate() {
	[ -d "$CONF_DIR" ] || return 0
	ls "$PROF"/*.conf >/dev/null 2>&1 && return 0
	[ -f "$CONF_DIR/awg0.conf" ] || ls "$CONF_DIR"/*.conf.saved >/dev/null 2>&1 || return 0
	mkdir -p "$PROF"
	chmod 700 "$PROF"
	for f in "$CONF_DIR"/*.conf.saved; do
		[ -f "$f" ] || continue
		n=$(basename "$f" .conf.saved)
		valid_name "$n" && [ ! -e "$PROF/$n.conf" ] && mv "$f" "$PROF/$n.conf"
	done
	if [ -f "$CONF_DIR/awg0.conf" ] && [ ! -e "$PROF/awg2.conf" ]; then
		mv "$CONF_DIR/awg0.conf" "$PROF/awg2.conf"
		echo awg2 >"$ACTIVE_F"
	fi
	chmod 600 "$PROF"/*.conf 2>/dev/null
	[ -n "$(active_name)" ] || basename "$(ls "$PROF"/*.conf | head -n1)" .conf >"$ACTIVE_F"
	chmod 600 "$ACTIVE_F"
}

migrate
CONF=$PROF/$(active_name).conf

# PID нашего демона: из PID-файла, а если он устарел — поиском по командной строке
find_pid() {
	for p in $($BB pidof amneziawg-go 2>/dev/null); do
		c=$(tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null)
		case "$c" in "$D/bin/amneziawg-go -f $IFACE "*) echo "$p"; return 0 ;; esac
	done
	return 1
}

get_pid() {
	pid=$(cat "$PIDF" 2>/dev/null)
	if [ -n "$pid" ] && grep -q "bin/amneziawg-go" "/proc/$pid/cmdline" 2>/dev/null; then
		echo "$pid"
		return 0
	fi
	pid=$(find_pid) || return 1
	[ -d "$RUN" ] && echo "$pid" >"$PIDF"
	echo "$pid"
}

# Туннель работает: интерфейс есть и его держит демон или модуль ядра
tunnel_up() {
	[ -d "/sys/class/net/$IFACE" ] || return 1
	get_pid >/dev/null && return 0
	mod_loaded
}

mod_loaded() {
	grep -q '^amneziawg ' /proc/modules 2>/dev/null
}

# Движок работающего туннеля: go, если жив демон; kernel, если интерфейс есть без демона
engine_now() {
	[ -d "/sys/class/net/$IFACE" ] || return 0
	if get_pid >/dev/null; then echo go; elif mod_loaded; then echo kernel; fi
}

# Строка в журнал пакета (в ОЗУ, без ключей)
svclog() {
	echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$SVCLOG"
}

# Скрыть в тексте все, что похоже на ключ (base64 или hex длиной от 20 символов)
mask() {
	sed -r 's#[A-Za-z0-9+/=]{20,}#***#g'
}

# Ошибка: одна строка в stderr (меню экрана читает ее, помощник собирает stdout и stderr вместе)
err() {
	echo "$*" >&2
}

wait_for() {
	n=0
	while ! eval "$1"; do
		n=$((n + 1))
		[ $n -gt "$2" ] && return 1
		sleep 0.1 2>/dev/null || sleep 1
	done
	return 0
}

# Значения из конфига, нужные вместо awg-quick: строки «ADDR|DNS|MTU|AIP|EP значение»
conf_values() {
	awk '
	{
		l = $0; sub(/\r$/, "", l); sub(/#.*/, "", l); gsub(/[ \t]/, "", l)
		if (l == "") next
		if (l ~ /^\[/) { sec = tolower(l); next }
		k = l; sub(/=.*/, "", k); k = tolower(k); v = l; sub(/^[^=]*=/, "", v)
		n = split(v, a, ",")
		for (i = 1; i <= n; i++) {
			if (a[i] == "") continue
			if (sec == "[interface]" && k == "address") print "ADDR", a[i]
			else if (sec == "[interface]" && k == "dns") print "DNS", a[i]
			else if (sec == "[interface]" && k == "mtu") print "MTU", a[i]
			else if (sec == "[peer]" && k == "allowedips") print "AIP", a[i]
		}
	}' "$CONF"
}

# Конфиг для awg setconf: только ключи, которые понимает awg. Имена выброшенных ключей — в $RUN/dropped
strip_conf() {
	awk -v drop="$RUN/dropped" '
	{
		t = $0; sub(/\r$/, "", t); sub(/^[ \t]+/, "", t)
		if (t == "" || t ~ /^#/) next
		if (t ~ /^\[/) { s = tolower(t); gsub(/[ \t]/, "", s); sec = s; print s == "[peer]" ? "[Peer]" : "[Interface]"; next }
		k = t; sub(/[ \t]*=.*/, "", k); k = tolower(k)
		if (sec == "[interface]" && k ~ /^(privatekey|listenport|fwmark|jc|jmin|jmax|s[1-4]|h[1-4]|i[1-5]|headerprotectionkey|contentpaddingaddition|disablecookies|randomtrailers|rekeyaftertime|rekeytimeout|rejectaftertime|keepalivetimeout|maxhandshakeattempts)$/) print t
		else if (sec == "[peer]" && k ~ /^(publickey|presharedkey|allowedips|endpoint|persistentkeepalive|advancedsecurity)$/) print t
		else if (k !~ /^(address|dns|mtu|table|preup|postup|predown|postdown|saveconfig)$/) print k > drop
	}' "$CONF"
}

lan_net() {
	$IP route show dev "$IFACE_LAN" 2>/dev/null | awk '$1 ~ /\// && /proto kernel/ {print $1; exit}'
}

is_v4() {
	case "$1" in *:*) return 1 ;; *.*) return 0 ;; *) return 1 ;; esac
}

dns_pkg_running() {
	[ -x /online/mod/pkg/dns/svc.sh ] &&
	/online/mod/pkg/dns/svc.sh status 2>/dev/null </dev/null | grep -q '^running=1'
}

# Снять все переходы в цепочку $4 из цепочки $3 таблицы $2 программой $1
unhook() {
	$1 -t "$2" -S "$3" 2>/dev/null | grep -- "-j $4\$" | sed 's/^-A /-D /' |
	while read -r line; do
		# shellcheck disable=SC2086
		$1 -t "$2" $line
	done
}

chain_new() {
	$1 -t "$2" -N "$3" 2>/dev/null
	$1 -t "$2" -F "$3"
}

chain_del() {
	$1 -t "$2" -F "$3" 2>/dev/null
	$1 -t "$2" -X "$3" 2>/dev/null
}

# Раздельный VPN можно применить: включен настройкой и список есть. Без списка клиент работает как обычный полный VPN
split_usable() {
	[ "$SPLIT" = "1" ] && [ -s "$SPLIT_LIST" ]
}

# Запрет прямого выхода клиентов LAN. При раздельном VPN он резал бы прямой путь:
# тогда утечку держит unreachable в таблице туннеля, зарубежные адреса при падении туннеля недоступны.
ks_up() {
	[ "$KILLSWITCH" = "1" ] || return 0
	split_usable && return 0
	chain_new $IPT4 filter $C_KS
	$IPT4 -t filter -A $C_KS -j REJECT
	unhook $IPT4 filter FORWARD $C_KS
	$IPT4 -t filter -I FORWARD 1 -i "$IFACE_LAN" -o "$IFACE_WAN" -j $C_KS
}

ks_down() {
	unhook $IPT4 filter FORWARD $C_KS
	chain_del $IPT4 filter $C_KS
}

# Снять из таблицы туннеля строки, отобранные grep: $1 — выражение для grep -v (что оставить)
table_del_except() {
	$IP route show table "$TABLE" 2>/dev/null | grep -Ev "$1" |
		awk -v t="$TABLE" '{print "route del " $0 " table " t}' >"$RUN/split.batch"
	[ -s "$RUN/split.batch" ] && $IP -force -batch "$RUN/split.batch" 2>/dev/null
	rm -f "$RUN/split.batch"
}

table_del_all() {
	[ -d "$RUN" ] || return 0
	table_del_except '^$'
}

# Строки префиксов из файла без комментариев
prefixes_of() {
	grep -E '^[0-9]' "$1" 2>/dev/null
}

# grep -vx в busybox роутера работает неверно, поэтому сравнение строк — через awk
has_prefix() {
	[ -f "$2" ] && awk -v p="$1" '$0 == p {f = 1} END {exit !f}' "$2"
}

# Раздельный VPN: российские префиксы и «всегда напрямую» — throw в таблице туннеля (поиск идет дальше, к main и оператору),
# «всегда через VPN» — маршрут в туннель. Метки и шлюз оператора не нужны: маршруты переживают падение сети оператора.
split_up() {
	if [ ! -s "$SPLIT_LIST" ]; then
		svclog "раздельный VPN включен, но нет списка: $SPLIT_LIST"
		return 1
	fi
	{
		prefixes_of "$SPLIT_LIST" | awk -v t="$TABLE" '{print "route replace throw " $1 " table " t}'
		prefixes_of "$SPLIT_DIRECT" | awk -v t="$TABLE" '{print "route replace throw " $1 " table " t}'
		prefixes_of "$SPLIT_VPN" | awk -v t="$TABLE" -v d="$IFACE" '{print "route replace " $1 " dev " d " table " t}'
	} >"$RUN/split.batch"
	$IP -force -batch "$RUN/split.batch" 2>"$RUN/split.err" || svclog "ip -batch: $(head -n 1 "$RUN/split.err")"
	rm -f "$RUN/split.batch" "$RUN/split.err"
	$IP route flush cache 2>/dev/null
	sed -i '/^SPLITUP /d' "$STATE" 2>/dev/null
	echo "SPLITUP 1" >>"$STATE"
	return 0
}

split_down() {
	table_del_except '^(default|unreachable)'
	$IP route flush cache 2>/dev/null
	sed -i '/^SPLITUP /d' "$STATE" 2>/dev/null
}

# Режим действует: туннель работает и маршруты стоят. Отметка в state сама по себе не считается
split_active() {
	tunnel_up && grep -q '^SPLITUP 1' "$STATE" 2>/dev/null
}

# Почему включенный режим не действует: no_list, tunnel_down, no_full_tunnel или пусто
split_reason() {
	[ "$SPLIT" = "1" ] || return 0
	if [ ! -s "$SPLIT_LIST" ]; then
		echo no_list
	elif ! tunnel_up; then
		echo tunnel_down
	elif [ "$(awk '$1 == "FULL" {print $2}' "$STATE" 2>/dev/null)" != "1" ]; then
		echo no_full_tunnel
	fi
}

# Префикс IPv4: адрес или адрес/длина, длина от 8 до 32, без лишних бит. Печатает в виде адрес/длина
norm_prefix() {
	echo "$1" | awk -F'[./]' '
		NF < 4 || NF > 5 { exit 1 }
		{
			len = (NF == 5) ? $5 : 32
			for (i = 1; i <= NF; i++) if ($i !~ /^[0-9]+$/) exit 1
			if ($1 > 255 || $2 > 255 || $3 > 255 || $4 > 255 || len < 8 || len > 32) exit 1
			ip = $1 * 16777216 + $2 * 65536 + $3 * 256 + $4
			size = 1
			for (i = len; i < 32; i++) size *= 2
			if (ip % size != 0) exit 1
			print $1 "." $2 "." $3 "." $4 "/" len
			ok = 1
		}
		END { exit !ok }'
}

split_date() {
	sed -n 's/^# date=//p' "$SPLIT_LIST" 2>/dev/null | head -n 1
}

split_count() {
	[ -s "$1" ] && prefixes_of "$1" | wc -l | tr -d ' ' || echo 0
}

set_setting() {
	mkdir -p "$CONF_DIR"
	if [ -f "$SETTINGS" ] && grep -q "^$1=" "$SETTINGS"; then
		sed -i "s/^$1=.*/$1=\"$2\"/" "$SETTINGS"
	else
		echo "$1=\"$2\"" >>"$SETTINGS"
	fi
	chmod 644 "$SETTINGS"
}

do_split() {
	case "$1" in
		on)
			if [ ! -s "$SPLIT_LIST" ]; then
				err "нет списка российских адресов: загрузите файл"
				return 1
			fi
			set_setting SPLIT 1
			SPLIT=1
			if tunnel_up && [ -f "$STATE" ]; then
				if [ "$(awk '$1 == "FULL" {print $2}' "$STATE")" = "1" ]; then
					split_up || { err "не удалось применить список"; return 1; }
					ks_down
				else
					echo "в туннель идут только сети из AllowedIPs: раздельный VPN не действует"
				fi
			fi
			echo "раздельный VPN включен"
			;;
		off)
			set_setting SPLIT 0
			SPLIT=0
			if tunnel_up && [ -f "$STATE" ]; then
				split_down
				[ "$(awk '$1 == "FULL" {print $2}' "$STATE")" = "1" ] && ks_up
			fi
			echo "раздельный VPN выключен"
			;;
		*)
			err "нужно: split on или off"
			return 1
			;;
	esac
	return 0
}

do_split_status() {
	a=0
	split_active && a=1
	l=0
	[ -s "$SPLIT_LIST" ] && l=1
	echo "split=$SPLIT"
	echo "split_active=$a"
	echo "split_reason=$(split_reason)"
	echo "split_list=$l"
	echo "split_prefixes=$(split_count "$SPLIT_LIST")"
	echo "split_date=$(split_date)"
	echo "split_direct=$(split_count "$SPLIT_DIRECT")"
	echo "split_vpn=$(split_count "$SPLIT_VPN")"
	return 0
}

do_split_update() {
	if [ -z "$1" ] || [ ! -r "$1" ]; then
		err "нет файла: $1"
		return 1
	fi
	if [ "$(wc -c <"$1" | tr -d ' ')" -gt 1048576 ]; then
		err "файл больше 1 МиБ"
		return 1
	fi
	bad=$(awk -F'[./]' '
		/^#/ || /^$/ { next }
		{
			if (NF != 5 || $0 !~ /^[0-9.\/]+$/ || $1 > 255 || $2 > 255 || $3 > 255 || $4 > 255 || $5 < 8 || $5 > 32) { print "строка " NR ": неверный префикс"; exit }
			ip = $1 * 16777216 + $2 * 65536 + $3 * 256 + $4
			size = 1
			for (i = $5; i < 32; i++) size *= 2
			if (ip % size != 0) { print "строка " NR ": лишние биты в адресе"; exit }
		}' "$1")
	if [ -n "$bad" ]; then
		err "$bad"
		return 1
	fi
	n=$(split_count "$1")
	if [ "$n" -lt 1 ] || [ "$n" -gt 20000 ]; then
		err "в списке $n префиксов, нужно от 1 до 20000"
		return 1
	fi
	mkdir -p "$CONF_DIR"
	cat "$1" >"$SPLIT_LIST.new" && chmod 644 "$SPLIT_LIST.new" && mv "$SPLIT_LIST.new" "$SPLIT_LIST"
	# Список мог появиться при уже работающем туннеле: режим включается сразу, без перезапуска
	if [ "$SPLIT" = "1" ] && tunnel_up && [ "$(awk '$1 == "FULL" {print $2}' "$STATE" 2>/dev/null)" = "1" ]; then
		split_down
		split_up || { err "не удалось применить список"; return 1; }
		ks_down
	fi
	echo "список обновлен: $n префиксов, дата $(split_date)"
	return 0
}

# split-direct и split-vpn: свои исключения, адреса и подсети
do_split_ex() {
	kind=$1
	if [ "$kind" = "direct" ]; then file=$SPLIT_DIRECT; else file=$SPLIT_VPN; fi
	case "$2" in
		list)
			prefixes_of "$file"
			return 0
			;;
		add | del) ;;
		*)
			err "нужно: add, del или list"
			return 1
			;;
	esac
	pfx=$(norm_prefix "$3")
	if [ -z "$pfx" ]; then
		err "неверный адрес: нужен IPv4 или подсеть, например 203.0.113.0/24, длина от 8 до 32"
		return 1
	fi
	mkdir -p "$CONF_DIR"
	if [ "$2" = "add" ]; then
		has_prefix "$pfx" "$file" || echo "$pfx" >>"$file"
		chmod 644 "$file"
		if split_active; then
			if [ "$kind" = "direct" ]; then
				$IP route replace throw "$pfx" table "$TABLE"
			else
				$IP route replace "$pfx" dev "$IFACE" table "$TABLE"
			fi
		fi
	else
		if [ -f "$file" ]; then
			awk -v p="$pfx" '$0 != p' "$file" >"$file.new"
			mv "$file.new" "$file"
			chmod 644 "$file"
		fi
		if split_active; then
			# Что должно остаться для этого префикса: другой список или ничего
			if has_prefix "$pfx" "$SPLIT_VPN"; then
				$IP route replace "$pfx" dev "$IFACE" table "$TABLE"
			elif has_prefix "$pfx" "$SPLIT_DIRECT" || has_prefix "$pfx" "$SPLIT_LIST"; then
				$IP route replace throw "$pfx" table "$TABLE"
			else
				$IP route del "$pfx" table "$TABLE" 2>/dev/null || $IP route del throw "$pfx" table "$TABLE" 2>/dev/null
			fi
		fi
	fi
	$IP route flush cache 2>/dev/null
	echo "$2 $pfx: всего $(split_count "$file")"
	return 0
}

# ---------- Переключение профиля при обрыве ----------
# Цикл идет только при FAILOVER=1. Причина — в failover.reason: ok, on_backup, switched, returned_primary,
# primary_still_down, operator_down, pause, no_full_tunnel; failover-status добавляет no_other_profile и tunnel_down.
# При одном профиле цикл не запускается: переключаться не на что.

profile_count() {
	ls "$PROF"/*.conf 2>/dev/null | wc -l | tr -d ' '
}

uptime_s() {
	cut -d. -f1 /proc/uptime
}

watcher_pid() {
	p=$(cat "$FO_PID" 2>/dev/null)
	[ -n "$p" ] && grep -q "failover-run" "/proc/$p/cmdline" 2>/dev/null && echo "$p"
}

watcher_start() {
	[ "$FAILOVER" = "1" ] && [ -z "$AWG_WATCHER" ] || return 0
	[ "$(profile_count)" -ge 2 ] || return 0
	watcher_pid >/dev/null && return 0
	$BB setsid $BB sh "$D/svc.sh" failover-run </dev/null >/dev/null 2>&1 8>&- &
}

watcher_stop() {
	[ -z "$AWG_WATCHER" ] || return 0
	p=$(watcher_pid)
	[ -n "$p" ] && kill "$p" 2>/dev/null
	rm -f "$FO_PID"
}

# Сеть оператора жива: TCP-соединение с одним из двух адресов напрямую через eth_x.
# Коды curl: 7 и 28 — соединения нет, 45 — нет самого интерфейса
operator_alive() {
	c=/online/mod/pkg/dns/bin/curl
	for ip in 77.88.8.8 1.1.1.1; do
		if [ -x "$c" ]; then
			"$c" -s -k -o /dev/null --interface "$IFACE_WAN" --connect-timeout 5 -m 8 -I "https://$ip/" 2>/dev/null
			case $? in 7 | 28 | 45) ;; *) return 0 ;; esac
		else
			$BB nc -w 5 "$ip" 443 </dev/null >/dev/null 2>&1 && return 0
		fi
	done
	return 1
}

# Следующий профиль по кругу; пусто, если он один
next_profile() {
	do_list | awk -F'|' -v cur="$1" '
		{ n[NR] = $1; if ($1 == cur) at = NR }
		END { if (NR > 1) print n[at % NR + 1] }'
}

hs_fresh() {
	a=$(hs_ago)
	[ -n "$a" ] && [ "$a" -le "$FAILOVER_HS" ]
}

fo_set() {
	echo "$*" >"$FO_REASON"
}

fo_use() {
	AWG_WATCHER=1 "$D/svc.sh" use "$1" >/dev/null 2>&1 </dev/null
}

do_failover_run() {
	mkdir -p "$RUN"
	echo $$ >"$FO_PID"
	last=$(uptime_s)
	fo_set ok
	while :; do
		sleep "$FAILOVER_POLL"
		[ -r "$SETTINGS" ] && . "$SETTINGS"
		[ "$FAILOVER" = "1" ] || break
		[ "$(profile_count)" -ge 2 ] || break
		if ! tunnel_up; then
			fo_set tunnel_down
			continue
		fi
		# Пробный пакет к 1.1.1.1 не вызовет рукопожатия, если этот адрес не в AllowedIPs: профиль считался бы мертвым
		if [ "$(awk '$1 == "FULL" {print $2}' "$STATE" 2>/dev/null)" != "1" ]; then
			fo_set no_full_tunnel
			continue
		fi
		cur=$(active_name)
		prim=${FAILOVER_PRIMARY:-$cur}
		now=$(uptime_s)
		if ! hs_fresh; then
			# Без трафика рукопожатий может не быть: любой пакет в туннель вызывает новое, ответ не важен
			$BB ping -I "$IFACE" -c 1 -W 3 1.1.1.1 >/dev/null 2>&1
			sleep 1
		fi
		if hs_fresh; then
			if [ "$cur" = "$prim" ]; then
				fo_set ok
			elif [ $((now - last)) -ge "$FAILOVER_RETRY" ]; then
				# Проверить основной можно, только переключившись на него: короткий простой
				fo_use "$prim"
				sleep "$FAILOVER_POLL"
				last=$(uptime_s)
				if hs_fresh; then
					fo_set returned_primary
					svclog "failover: основной профиль $prim снова отвечает"
				else
					fo_use "$cur"
					fo_set primary_still_down
					svclog "failover: основной профиль $prim не отвечает, снова $cur"
				fi
			else
				fo_set on_backup
			fi
			continue
		fi
		# Рукопожатия нет
		if ! operator_alive; then
			fo_set operator_down
			continue
		fi
		if [ $((now - last)) -lt "$FAILOVER_PAUSE" ]; then
			fo_set pause
			continue
		fi
		nxt=$(next_profile "$cur")
		if [ -z "$nxt" ]; then
			fo_set no_other_profile
			continue
		fi
		# Основной не задан: им остается профиль, с которого уходим, иначе возврата не будет
		if [ -z "$FAILOVER_PRIMARY" ]; then
			set_setting FAILOVER_PRIMARY "$cur"
			FAILOVER_PRIMARY=$cur
		fi
		fo_use "$nxt"
		last=$(uptime_s)
		fo_set switched
		svclog "failover: нет рукопожатия на $cur, переход на $nxt"
	done
	rm -f "$FO_PID" "$FO_REASON"
}

do_failover() {
	case "$1" in
		on)
			if [ "$(do_list | wc -l | tr -d ' ')" -lt 2 ]; then
				err "нужно хотя бы два профиля"
				return 1
			fi
			prim=${2:-$(active_name)}
			if ! valid_name "$prim" || [ ! -s "$PROF/$prim.conf" ]; then
				err "нет профиля: $prim"
				return 1
			fi
			set_setting FAILOVER 1
			set_setting FAILOVER_PRIMARY "$prim"
			FAILOVER=1
			FAILOVER_PRIMARY=$prim
			tunnel_up && watcher_start
			echo "переключение при обрыве включено, основной профиль: $prim"
			;;
		off)
			set_setting FAILOVER 0
			FAILOVER=0
			watcher_stop
			rm -f "$FO_REASON"
			echo "переключение при обрыве выключено"
			;;
		*)
			err "нужно: failover on [ИМЯ] или off"
			return 1
			;;
	esac
	return 0
}

do_failover_status() {
	r=0
	watcher_pid >/dev/null && r=1
	echo "failover=$FAILOVER"
	echo "failover_running=$r"
	# Цикл снят вместе с туннелем и файл причины не обновляет: tunnel_down определяется здесь
	if [ "$FAILOVER" = "1" ] && ! tunnel_up; then
		echo "failover_reason=tunnel_down"
	elif [ "$FAILOVER" = "1" ] && [ "$(profile_count)" -lt 2 ]; then
		echo "failover_reason=no_other_profile"
	else
		echo "failover_reason=$(head -n 1 "$FO_REASON" 2>/dev/null)"
	fi
	# Основной не задан — им считается активный
	pr=$FAILOVER_PRIMARY
	[ "$FAILOVER" = "1" ] && [ -z "$pr" ] && pr=$(active_name)
	echo "primary=$pr"
	return 0
}

net_up() {
	full=0
	half0=0
	half1=0
	mtu=$MTU_DEFAULT
	lan=$(lan_net)
	[ -n "$lan" ] || lan=192.168.1.0/24
	: >"$STATE"
	conf_values >"$RUN/values"
	while read -r k v; do
		case "$k" in
			ADDR) $IP addr add "$v" dev "$IFACE" 2>/dev/null || { is_v4 "$v" && return 1; } ;;
			MTU) mtu=$v ;;
		esac
	done <"$RUN/values"
	$IP link set dev "$IFACE" mtu "$mtu" up || return 1
	echo "MTU $mtu" >>"$STATE"
	# Маршруты по AllowedIPs. 0.0.0.0/0 (или пара /1) — режим «весь трафик», остальное — маршрут в main.
	while read -r k v; do
		[ "$k" = "AIP" ] || continue
		is_v4 "$v" || continue
		case "$v" in
			0.0.0.0/0) full=1 ;;
			0.0.0.0/1) half0=1 ;;
			128.0.0.0/1) half1=1 ;;
			"$lan") echo "пропущен маршрут $v: это сеть LAN, управление роутером не уходит в туннель" ;;
			*) $IP route add "$v" dev "$IFACE" 2>/dev/null && echo "ROUTE $v" >>"$STATE" ;;
		esac
	done <"$RUN/values"
	[ $half0 = 1 ] && [ $half1 = 1 ] && full=1
	if [ $full = 0 ]; then
		[ $half0 = 1 ] && $IP route add 0.0.0.0/1 dev "$IFACE" 2>/dev/null && echo "ROUTE 0.0.0.0/1" >>"$STATE"
		[ $half1 = 1 ] && $IP route add 128.0.0.0/1 dev "$IFACE" 2>/dev/null && echo "ROUTE 128.0.0.0/1" >>"$STATE"
	fi
	echo "FULL $full" >>"$STATE"
	# Адрес сервера: если трафик самого роутера идет в туннель, сервер — напрямую через оператора
	ep=$($AWG show "$IFACE" endpoints 2>/dev/null | awk '{print $2; exit}' | sed 's/:[0-9]*$//; s/^\[//; s/\]$//')
	echo "EP $ep" >>"$STATE"
	if is_v4 "$ep" && { [ "$ROUTE_SELF" = "1" ] || [ $half0 = 1 ] || [ $half1 = 1 ] || grep -q '^ROUTE' "$STATE"; }; then
		gw=$($IP route show 0.0.0.0/0 2>/dev/null | awk '/^default/ {for (i = 1; i < NF; i++) if ($i == "via") print $(i + 1); exit}')
		if [ -n "$gw" ]; then
			$IP route add "$ep/32" via "$gw" dev "$IFACE_WAN" 2>/dev/null && echo "EPROUTE $ep/32" >>"$STATE"
		else
			$IP route add "$ep/32" dev "$IFACE_WAN" 2>/dev/null && echo "EPROUTE $ep/32" >>"$STATE"
		fi
	fi
	if [ $full = 1 ]; then
		# Клиенты LAN: свой адрес и сеть LAN — по main, остальное — в таблицу туннеля
		$IP rule add iif "$IFACE_LAN" to "$lan" table main pref "$PRIO" || return 1
		$IP rule add iif "$IFACE_LAN" table "$TABLE" pref $((PRIO + 1)) || return 1
		$IP route add default dev "$IFACE" table "$TABLE" || return 1
		# Блокировка утечки: если туннель пропал, маршрут остается недоступным, а не уходит к оператору
		[ "$KILLSWITCH" = "1" ] && $IP route add unreachable default metric 4096 table "$TABLE"
		split_usable && split_up
		if [ "$ROUTE_SELF" = "1" ]; then
			$IP route add 0.0.0.0/1 dev "$IFACE" 2>/dev/null && echo "ROUTE 0.0.0.0/1" >>"$STATE"
			$IP route add 128.0.0.0/1 dev "$IFACE" 2>/dev/null && echo "ROUTE 128.0.0.0/1" >>"$STATE"
		fi
	fi
	$IP route flush cache 2>/dev/null
	return 0
}

net_down() {
	n=0
	while [ $n -lt 3 ]; do
		while $IP rule del pref $((PRIO + n)) 2>/dev/null; do :; done
		n=$((n + 1))
	done
	# ip route flush на этой версии ip не снимает маршруты throw: снимаем построчно
	table_del_all
	$IP route flush table "$TABLE" 2>/dev/null
	if [ -f "$STATE" ]; then
		grep '^ROUTE \|^EPROUTE ' "$STATE" | while read -r k v; do
			$IP route del "$v" 2>/dev/null
		done
	fi
	$IP route flush cache 2>/dev/null
	return 0
}

fw_up() {
	mtu=$(awk '$1 == "MTU" {print $2}' "$STATE")
	full=$(awk '$1 == "FULL" {print $2}' "$STATE")
	# NAT клиентов LAN в туннель
	chain_new $IPT4 nat $C_NAT
	$IPT4 -t nat -A $C_NAT -j MASQUERADE || return 1
	unhook $IPT4 nat POSTROUTING $C_NAT
	$IPT4 -t nat -I POSTROUTING 1 -o "$IFACE" -j $C_NAT || return 1
	# MSS: TCP-сегменты клиентов должны помещаться в MTU туннеля
	mss=$((mtu - 40))
	chain_new $IPT4 mangle $C_MSS
	$IPT4 -t mangle -A $C_MSS -p tcp --tcp-flags SYN,RST SYN -m tcpmss --mss $((mss + 1)):65535 -j TCPMSS --set-mss $mss
	unhook $IPT4 mangle FORWARD $C_MSS
	$IPT4 -t mangle -I FORWARD 1 -o "$IFACE" -j $C_MSS
	$IPT4 -t mangle -I FORWARD 1 -i "$IFACE" -j $C_MSS
	if [ "$full" = "1" ]; then
		ks_up
		# IPv6 в туннель не идет (нет NAT для IPv6): клиентам LAN отказ, чтобы не было утечки мимо туннеля
		chain_new $IPT6 filter $C_6
		$IPT6 -t filter -A $C_6 -j REJECT
		unhook $IPT6 filter FORWARD $C_6
		$IPT6 -t filter -I FORWARD 1 -i "$IFACE_LAN" -o "$IFACE_WAN" -j $C_6
	fi
	dns_up
	return 0
}

dns_enabled() {
	[ "${DNS_TUNNEL:-${DNS_REDIRECT:-1}}" = "1" ]
}

# IPv4-адреса серверов DoH/DoT пакета dns (SECURE_SERVERS), если он в режиме secure
dns_pkg_upstreams() {
	/online/mod/pkg/dns/svc.sh upstreams 2>/dev/null </dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' | sort -u
}

# DNS клиентов LAN через туннель. Только в режиме «весь трафик».
#   пакет dns не запущен: перехват порта 53 клиентов на DNS из конфига или DNS_TUNNEL_SERVER;
#   пакет dns запущен: его серверы DoH/DoT — маршрутом через туннель.
dns_up() {
	full=$(awk '$1 == "FULL" {print $2}' "$STATE" 2>/dev/null)
	[ "$full" = "1" ] && dns_enabled || return 0
	if dns_pkg_running; then
		for ip in $(dns_pkg_upstreams); do
			$IP route add "$ip/32" dev "$IFACE" 2>/dev/null && echo "DNSROUTE $ip/32" >>"$STATE"
		done
		echo "DNSMODE dnspkg" >>"$STATE"
		return 0
	fi
	dns=$(awk '$1 == "DNS" {print $2}' "$RUN/values" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -n1)
	[ -n "$dns" ] || dns=$DNS_TUNNEL_SERVER
	[ -n "$dns" ] || return 0
	chain_new $IPT4 nat $C_DNS
	$IPT4 -t nat -A $C_DNS -p udp --dport 53 -j DNAT --to-destination "$dns"
	$IPT4 -t nat -A $C_DNS -p tcp --dport 53 -j DNAT --to-destination "$dns"
	unhook $IPT4 nat PREROUTING $C_DNS
	$IPT4 -t nat -I PREROUTING 1 -i "$IFACE_LAN" -j $C_DNS
	# DNS роутера по IPv6 (стоковый, к оператору) для клиентов закрыт: перенаправить IPv6 нельзя
	chain_new $IPT6 filter $C_DNS6
	$IPT6 -t filter -A $C_DNS6 -p udp --dport 53 -j REJECT
	$IPT6 -t filter -A $C_DNS6 -p tcp --dport 53 -j REJECT --reject-with tcp-reset
	unhook $IPT6 filter INPUT $C_DNS6
	$IPT6 -t filter -I INPUT 1 -i "$IFACE_LAN" -j $C_DNS6
	echo "DNSMODE tunnel" >>"$STATE"
	echo "DNS $dns" >>"$STATE"
}

dns_down() {
	unhook $IPT4 nat PREROUTING $C_DNS
	chain_del $IPT4 nat $C_DNS
	unhook $IPT6 filter INPUT $C_DNS6
	chain_del $IPT6 filter $C_DNS6
	if [ -f "$STATE" ]; then
		grep '^DNSROUTE ' "$STATE" | while read -r k v; do
			$IP route del "$v" 2>/dev/null
		done
		sed -i '/^DNSMODE /d; /^DNS /d; /^DNSROUTE /d' "$STATE"
	fi
	return 0
}

# Текущий путь DNS клиентов: строки dns= и dns_server=
dns_state() {
	mode=""
	srv=""
	if [ -n "$1" ]; then
		if dns_pkg_running; then
			mode=dnspkg
			srv=$(awk '$1 == "DNSROUTE" {sub("/32", "", $2); printf "%s%s", s, $2; s = " "}' "$STATE" 2>/dev/null)
		elif $IPT4 -t nat -S PREROUTING 2>/dev/null | grep -q -- "-j $C_DNS\$"; then
			mode=tunnel
			srv=$(awk '$1 == "DNS" {print $2}' "$STATE" 2>/dev/null)
		else
			mode=operator
		fi
	fi
	echo "dns=$mode"
	echo "dns_server=$srv"
}

fw_down() {
	unhook $IPT4 nat POSTROUTING $C_NAT
	chain_del $IPT4 nat $C_NAT
	unhook $IPT4 mangle FORWARD $C_MSS
	chain_del $IPT4 mangle $C_MSS
	ks_down
	dns_down
	unhook $IPT6 filter FORWARD $C_6
	chain_del $IPT6 filter $C_6
	return 0
}

rules_left() {
	for t in nat mangle filter; do
		$IPT4 -t $t -S 2>/dev/null | grep -q -- "-N MOD_AWG" && return 0
	done
	$IPT6 -t filter -S 2>/dev/null | grep -q -- "-N MOD_AWG" && return 0
	$IP rule list 2>/dev/null | grep -q "^$PRIO:\|^$((PRIO + 1)):"
}

# Загрузить модуль, если его нет. Перед insmod — перезагрузка при панике: иначе ошибка в модуле повесит роутер
load_module() {
	echo 5 >/proc/sys/kernel/panic 2>/dev/null || svclog "не удалось записать kernel.panic"
	mod_loaded && return 0
	if [ ! -f "$KMOD" ]; then
		svclog "нет файла модуля: $KMOD"
		return 1
	fi
	out=$($BB insmod "$KMOD" 2>&1)
	rc=$?
	if [ $rc -ne 0 ] || ! mod_loaded; then
		svclog "insmod не удался (код $rc): $(echo "$out" | head -n 1 | mask)"
		return 1
	fi
	svclog "модуль загружен: $KMOD"
	return 0
}

kernel_iface() {
	load_module || return 1
	out=$($IP link add dev "$IFACE" type amneziawg 2>&1)
	rc=$?
	if [ $rc -ne 0 ] || [ ! -d "/sys/class/net/$IFACE" ]; then
		svclog "ip link add не удался (код $rc): $(echo "$out" | head -n 1 | mask)"
		return 1
	fi
	return 0
}

go_iface() {
	LOG_LEVEL=error GOGC="${GO_GC:-100}" $BB setsid "$D/bin/amneziawg-go" -f "$IFACE" >"$LOG" 2>&1 </dev/null 8>&- &
	echo $! >"$PIDF"
	wait_for "[ -S $SOCK_DIR/$IFACE.sock ] && [ -d /sys/class/net/$IFACE ]" 50 && find_pid >"$PIDF"
}

# Применить профиль к интерфейсу: конфиг идет по каналу, без временного файла с ключом
apply_conf() {
	if strip_conf | $AWG setconf "$IFACE" /proc/self/fd/0 2>"$RUN/setconf.err"; then
		return 0
	fi
	svclog "awg setconf не удался: $(mask <"$RUN/setconf.err" | head -n 1)"
	return 1
}

do_start() {
	if tunnel_up; then
		watcher_start
		echo "AmneziaWG уже запущен"
		return 0
	fi
	if [ -z "$(active_name)" ] || [ ! -s "$CONF" ]; then
		err "нет активного профиля (загрузите конфиг: setconf ИМЯ, выберите: use ИМЯ)"
		return 1
	fi
	(umask 022; mkdir -p /tmp/mod)
	mkdir -p "$RUN"
	chmod 700 "$RUN"
	rm -f "$RUN/dropped" "$PIDF" "$FALLBACK"
	# Остатки прошлого запуска (например, после сбоя) — убрать
	fw_down
	net_down
	[ -d "/sys/class/net/$IFACE" ] && $IP link del "$IFACE" 2>/dev/null
	rm -f "$SOCK_DIR/$IFACE.sock"
	engine=""
	if [ "$ENGINE" != "go" ]; then
		if kernel_iface && apply_conf; then
			engine=kernel
		else
			[ -d "/sys/class/net/$IFACE" ] && $IP link del "$IFACE" 2>/dev/null
			if [ "$ENGINE" = "kernel" ]; then
				err "модуль ядра не сработал: $(tail -n 1 "$SVCLOG" 2>/dev/null | sed 's/^[0-9: -]* //')"
				do_stop >/dev/null
				return 1
			fi
		fi
	fi
	if [ -z "$engine" ]; then
		[ "$ENGINE" = "go" ] || svclog "запасной путь: amneziawg-go"
		if ! go_iface; then
			err "amneziawg-go не запустился"
			mask <"$LOG" | head -n 5
			do_stop >/dev/null
			return 1
		fi
		if ! apply_conf; then
			err "ошибка в конфиге туннеля: $(mask <"$RUN/setconf.err" | head -n 1)"
			mask <"$RUN/setconf.err" | head -n 5
			do_stop >/dev/null
			return 1
		fi
		engine=go
		if [ "$ENGINE" != "go" ]; then
			# нет файла модуля — это не сбой: пакет поставлен без него
			[ -f "$KMOD" ] && : >"$FALLBACK"
			[ -f "$KMOD" ] && echo "модуль ядра не сработал, туннель на amneziawg-go: $(tail -n 2 "$SVCLOG" 2>/dev/null | head -n 1 | sed 's/^[0-9: -]* //')"
		fi
	fi
	rm -f "$RUN/setconf.err"
	if [ -s "$RUN/dropped" ]; then
		echo "пропущены ключи, которых нет в AmneziaWG 3.1: $(sort -u "$RUN/dropped" | tr '\n' ' ')"
	fi
	if ! net_up; then
		err "не удалось настроить адрес и маршруты"
		do_stop >/dev/null
		return 1
	fi
	# DNS пакета dns — до правил: fw_up проверяет, запущен ли он, и ставит маршруты к его серверам
	if [ -z "$AWG_WATCHER" ] && [ -f "$DNS_PKG" ]; then
		# Предел времени: на загрузке список рекламы читается долго, а клиенты ждут правил туннеля
		$BB timeout -t 15 $BB sh "$DNS_PKG" vpn-up >/dev/null 2>&1 </dev/null 8>&-
	fi
	if ! fw_up; then
		err "не удалось поставить правила iptables"
		do_stop >/dev/null
		return 1
	fi
	svclog "запущен: движок $engine, профиль $(active_name)"
	watcher_start
	echo "AmneziaWG запущен: $IFACE, движок $engine"
}

do_stop() {
	watcher_stop
	fw_down
	net_down
	pid=$(get_pid)
	if [ -n "$pid" ]; then
		kill "$pid"
		wait_for "[ ! -d /proc/$pid ]" 30 || kill -9 "$pid"
	fi
	[ -d "/sys/class/net/$IFACE" ] && $IP link del "$IFACE" 2>/dev/null
	rm -f "$PIDF" "$FALLBACK" "$STATE" "$RUN/values" "$RUN/dropped" "$RUN/setconf.err" "$SOCK_DIR/$IFACE.sock"
	echo "AmneziaWG остановлен"
}

do_status() {
	pid=$(get_pid)
	rx=""
	tx=""
	hs=""
	engine=""
	if tunnel_up; then
		engine=$(engine_now)
		echo "running=1"
		t=$($AWG show "$IFACE" transfer 2>/dev/null | awk '{r += $2; s += $3} END {print r + 0, s + 0}')
		rx=${t% *}
		tx=${t#* }
		last=$($AWG show "$IFACE" latest-handshakes 2>/dev/null | awk '$2 > m {m = $2} END {print m + 0}')
		[ "$last" -gt 0 ] 2>/dev/null && hs=$(($(date +%s) - last))
		addr=$(awk '$1 == "ADDR" {printf "%s%s", s, $2; s = ", "}' "$RUN/values" 2>/dev/null)
		ep=$(awk '$1 == "EP" {print $2}' "$STATE" 2>/dev/null)
		full=$(awk '$1 == "FULL" {print $2}' "$STATE" 2>/dev/null)
		info="профиль «$(label_of "$(active_name)")», $IFACE $addr, сервер $ep"
		if [ "$full" = "1" ]; then
			info="$info, весь трафик клиентов LAN через туннель"
			[ "$KILLSWITCH" = "1" ] && info="$info, блокировка утечки"
		else
			info="$info, через туннель только сети из AllowedIPs"
		fi
		ds=$(dns_state 1)
		dmode=$(echo "$ds" | sed -n 's/^dns=//p')
		dsrv=$(echo "$ds" | sed -n 's/^dns_server=//p')
		case "$dmode" in
			tunnel) info="$info, DNS клиентов: $dsrv через туннель" ;;
			dnspkg)
				if [ -n "$dsrv" ]; then info="$info, DNS клиентов: пакет dns, его серверы через туннель"
				else info="$info, DNS клиентов: пакет dns, мимо туннеля"; fi ;;
			*) info="$info, DNS клиентов: оператора, мимо туннеля" ;;
		esac
		[ -n "$hs" ] || info="$info, рукопожатия еще не было"
		if [ "$engine" = "go" ]; then
			rss=$(grep VmRSS "/proc/$pid/status" | tr -s ' ' | sed 's/VmRSS:[^0-9]*//; s/ kB//')
			info="$info, движок amneziawg-go, память $rss КиБ"
		else
			info="$info, движок модуль ядра"
		fi
	else
		echo "running=0"
		info="остановлен"
		[ -n "$(active_name)" ] && [ -s "$CONF" ] || info="остановлен, нет активного профиля"
		rules_left && info="$info; правила остались: выполните stop"
	fi
	if [ -f "$FLAG" ]; then echo "enabled=1"; else echo "enabled=0"; fi
	echo "info=$info"
	echo "rx=$rx"
	echo "tx=$tx"
	echo "handshake=$hs"
	echo "engine=$engine"
	if [ "$engine" = "go" ] && [ -f "$FALLBACK" ]; then echo "engine_fallback=1"; else echo "engine_fallback=0"; fi
	echo "profile=$(active_name)"
	a=$(active_name)
	if [ -n "$a" ]; then echo "profile_label=$(label_of "$a")"; else echo "profile_label="; fi
	if tunnel_up; then dns_state 1; else dns_state; fi
	do_split_status | grep -E '^split(|_active|_reason|_list|_prefixes|_date)='
	# Совет, без автоматики: DNS оператора подменяет заблокированные зарубежные сайты
	if split_usable && [ "$dmode" = "operator" ]; then
		echo "split_hint=DNS клиентов идет к оператору: заблокированные сайты не откроются. Включите пакет dns с пресетом auto"
	else
		echo "split_hint="
	fi
	do_failover_status | grep -E '^(failover|failover_running|failover_reason|primary)='
}

# svc.sh dns on|off — DNS клиентов через туннель; пишет DNS_TUNNEL в settings и применяет без перезапуска туннеля
do_dns() {
	case "$1" in
		on) v=1 ;;
		off) v=0 ;;
		"")
			if tunnel_up; then dns_state 1; else dns_state; fi
			return 0
			;;
		*) echo "использование: $0 dns on|off"; return 2 ;;
	esac
	set_setting DNS_TUNNEL "$v"
	DNS_TUNNEL=$v
	if tunnel_up && [ -f "$STATE" ]; then
		dns_down
		dns_up
		$IP route flush cache 2>/dev/null
	fi
	if [ "$v" = 1 ]; then echo "DNS клиентов через туннель: включено"; else echo "DNS клиентов через туннель: выключено"; fi
	if tunnel_up; then dns_state 1; else dns_state; fi
}

# Значение Endpoint профиля: только адрес сервера (без порта), без ключей
endpoint_host() {
	awk '{ l = $0; sub(/\r$/, "", l); gsub(/[ \t]/, "", l); if (tolower(l) ~ /^endpoint=/) { sub(/^[^=]*=/, "", l); print l; exit } }' "$1" |
	sed 's/:[0-9]*$//; s/^\[//; s/\]$//'
}

# Поколение протокола по именам ключей (значения не читаются)
proto_of() {
	awk '{ l = $0; gsub(/[ \t]/, "", l); k = tolower(l); sub(/=.*/, "", k); print k }' "$1" | awk '
		/^(headerprotectionkey|contentpaddingaddition|rekeyaftertime|rekeytimeout|rejectaftertime|keepalivetimeout|maxhandshakeattempts)$/ { v3 = 1 }
		/^(randomtrailers|disablecookies)$/ { v31 = 1 }
		/^(s3|s4|i[1-5])$/ { v2 = 1 }
		/^(jc|jmin|jmax|s1|s2|h[1-4])$/ { v1 = 1 }
		END { print v31 ? "3.1" : v3 ? "3.0" : v2 ? "2.0" : v1 ? "1.0" : "wireguard" }'
}

do_profiles() {
	a=$(active_name)
	for f in "$PROF"/*.conf; do
		[ -f "$f" ] || continue
		n=$(basename "$f" .conf)
		valid_name "$n" || continue
		echo "name=$n"
		echo "label=$(label_of "$n")"
		if [ "$n" = "$a" ]; then echo "active=1"; else echo "active=0"; fi
		echo "endpoint_host=$(endpoint_host "$f")"
		echo "proto=$(proto_of "$f")"
	done
}

# Секунд с последнего рукопожатия или пусто
hs_ago() {
	last=$($AWG show "$IFACE" latest-handshakes 2>/dev/null | awk '$2 > m {m = $2} END {print m + 0}')
	[ "$last" -gt 0 ] 2>/dev/null && echo $(($(date +%s) - last))
}

# Для меню экрана: строка на профиль «id|подпись|протокол|активный»
do_list() {
	a=$(active_name)
	for f in "$PROF"/*.conf; do
		[ -f "$f" ] || continue
		n=$(basename "$f" .conf)
		valid_name "$n" || continue
		act=0
		[ "$n" = "$a" ] && act=1
		echo "$n|$(label_of "$n" | tr '|' '/')|$(proto_of "$f")|$act"
	done
	return 0
}

# Для меню экрана: одна строка «running=…|profile=…|label=…|handshake=…»
do_brief() {
	r=0
	hs=""
	eng=""
	if tunnel_up; then
		r=1
		hs=$(hs_ago)
		eng=$(engine_now)
	fi
	a=$(active_name)
	l=""
	[ -n "$a" ] && l=$(label_of "$a" | tr '|' '/')
	s=0
	split_usable && s=1
	echo "running=$r|profile=$a|label=$l|handshake=$hs|engine=$eng|split=$s"
	return 0
}

do_use() {
	if ! valid_name "$1" || [ ! -s "$PROF/$1.conf" ]; then
		err "нет профиля: $1"
		return 1
	fi
	running=0
	tunnel_up && running=1
	# Выбор пользователя становится основным профилем; переходы самого цикла основной не меняют
	if [ "$FAILOVER" = "1" ] && [ -z "$AWG_WATCHER" ]; then
		set_setting FAILOVER_PRIMARY "$1"
		FAILOVER_PRIMARY=$1
	fi
	if [ "$1" = "$(active_name)" ] && [ $running = 1 ]; then
		echo "профиль уже активен: $1"
		return 0
	fi
	echo "$1" >"$ACTIVE_F.new" && chmod 600 "$ACTIVE_F.new" && mv "$ACTIVE_F.new" "$ACTIVE_F"
	CONF=$PROF/$1.conf
	echo "активный профиль: $1"
	if [ $running = 1 ]; then
		do_stop >/dev/null
		do_start
	fi
}

do_delete() {
	if ! valid_name "$1" || [ ! -f "$PROF/$1.conf" ]; then
		err "нет профиля: $1"
		return 1
	fi
	if [ "$1" = "$(active_name)" ]; then
		err "нельзя удалить активный профиль: сначала выберите другой (use ИМЯ)"
		return 1
	fi
	rm -f "$PROF/$1.conf" "$PROF/$1.label"
	[ "$FAILOVER_PRIMARY" = "$1" ] && set_setting FAILOVER_PRIMARY ""
	[ "$(profile_count)" -ge 2 ] || watcher_stop
	echo "профиль удален: $1"
}

do_label() {
	if ! valid_name "$1" || [ ! -f "$PROF/$1.conf" ]; then
		err "нет профиля: $1"
		return 1
	fi
	set_label "$1" "$2" || return 1
	echo "подпись профиля $1: $2"
}

do_setconf() {
	label=$2
	if [ -n "$label" ] && ! valid_label "$label"; then
		err "неверная подпись: одна строка до 64 символов"
		return 1
	fi
	name=${1:-$(active_name)}
	[ -n "$name" ] || name=default
	if ! valid_name "$name"; then
		err "неверное имя профиля: латинские строчные буквы, цифры, _ и -, до 32 символов"
		return 1
	fi
	(umask 022; mkdir -p "$(dirname "$CONF_DIR")")
	mkdir -p "$PROF"
	chmod 700 "$CONF_DIR" "$PROF"
	tmp="$PROF/.new.$$"
	head -c 65537 >"$tmp"
	size=$(wc -c <"$tmp" | tr -d ' ')
	if [ "$size" -gt 65536 ] || [ "$size" -eq 0 ]; then
		rm -f "$tmp"
		err "конфиг пустой или больше 64 КиБ"
		return 1
	fi
	tr -d '\r' <"$tmp" >"$tmp.2" && mv "$tmp.2" "$tmp"
	for k in '\[Interface\]' 'PrivateKey' '\[Peer\]' 'PublicKey' 'Endpoint'; do
		if ! grep -qi "^[[:space:]]*$k" "$tmp"; then
			rm -f "$tmp"
			err "в конфиге нет $(echo "$k" | tr -d '\\')"
			return 1
		fi
	done
	chmod 600 "$tmp"
	mv "$tmp" "$PROF/$name.conf"
	[ -n "$label" ] && set_label "$name" "$label"
	echo "профиль сохранен: $name"
	if [ -z "$(active_name)" ]; then
		echo "$name" >"$ACTIVE_F"
		chmod 600 "$ACTIVE_F"
		echo "активный профиль: $name"
	fi
	if [ "$name" = "$(active_name)" ] && tunnel_up; then
		CONF=$PROF/$name.conf
		do_stop >/dev/null
		do_start
		return
	fi
	# Появился второй профиль: цикл переключения теперь нужен
	tunnel_up && watcher_start
	return 0
}

# Запуск, остановка и смена профиля — по одной: цикл переключения и пользователь не должны мешать друг другу
case "$1" in
	start | stop | restart | use | setconf)
		(umask 022; mkdir -p /tmp/mod)
		mkdir -p "$RUN"
		chmod 700 "$RUN"
		[ "$1" = "stop" ] && watcher_stop
		exec 8>"$RUN/op.lock"
		$BB flock 8
		;;
esac

case "$1" in
	start) do_start ;;
	stop) do_stop ;;
	restart) do_stop >/dev/null; do_start ;;
	status) do_status ;;
	enable) : >"$FLAG" && echo "автозапуск включен" ;;
	disable) rm -f "$FLAG"; echo "автозапуск выключен" ;;
	setconf) do_setconf "$2" "$3" ;;
	label) do_label "$2" "$3" ;;
	dns) do_dns "$2" ;;
	profiles) do_profiles ;;
	use) do_use "$2" ;;
	list) do_list ;;
	brief) do_brief ;;
	delete) do_delete "$2" ;;
	failover) do_failover "$2" "$3" ;;
	failover-status) do_failover_status ;;
	failover-run) do_failover_run ;;
	split) do_split "$2" ;;
	split-status) do_split_status ;;
	split-update) do_split_update "$2" ;;
	split-direct) do_split_ex direct "$2" "$3" ;;
	split-vpn) do_split_ex vpn "$2" "$3" ;;
	*) err "использование: $0 start|stop|restart|status|enable|disable|dns [on|off]|profiles|list|brief|use ИМЯ|setconf [ИМЯ [ПОДПИСЬ]]|label ИМЯ ПОДПИСЬ|delete ИМЯ|split on|off|split-status|split-update ФАЙЛ|split-direct add|del|list [АДРЕС]|split-vpn add|del|list [АДРЕС]|failover on [ИМЯ]|off|failover-status"; exit 2 ;;
esac
