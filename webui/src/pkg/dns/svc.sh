#!/system/bin/busyboxx sh
# DNS-фильтр: dnsmasq (кэш и блокировка рекламы) + smartdns (шифрованный DNS: DoT, DoH).
# DNS-запросы клиентов LAN перенаправляются на dnsmasq правилами iptables; стоковый DNS не меняется.
# Договор: svc.sh start|stop|status|enable|disable
# status печатает строки running=0|1, enabled=0|1, info=<текст>.
# Пакет awg при запуске туннеля вызывает vpn-up: служба поднимается, если пользователь ее сам не выключил.
# Выключил: stop работающей службы или disable, в settings DNS_USER_OFF=1. Снимается: start или enable.
# Дополнительно: svc.sh update [ФАЙЛ] — скачать список рекламы по LIST_URL или взять из файла.
# status дополнительно печатает preset=<id>, preset_label=<подпись>, adblock=0|1, dns_fallback=0|1, dns_upstream=preset|backup|operator, user_off=0|1, last_error=<текст>.
# Выбор сервера (меню экрана и панель), код 0 — успех, 1 — ошибка одной строкой в stderr:
#   presets                  строки id|подпись|активный(0|1)
#   use-preset ID            запомнить в settings; если служба запущена — применить; сама служба не запускается
#   set-custom АДРЕС         адрес для пресета custom: IP, https://…/dns-query или tls://имя
#   adblock on|off           блокировка рекламы отдельно от выбора сервера
#   brief                    одна строка running=0|1|preset=<id>|label=<подпись>|adblock=0|1|fallback=0|1
#   vpn-up                   для пакета awg, см. выше; watch — внутренний цикл: следит за службой и серверами

NAME=dns
umask 022
BB=/system/bin/busyboxx
for a in awk cat chmod cut date dirname grep head kill mkdir mv rm sed sleep sort tr wc wget; do
	eval "$a() { $BB $a \"\$@\"; }"
done
IPT4=/system/bin/iptables
IPT6=/system/bin/ip6tables

D=$(cd "$(dirname "$0")" && pwd)
RUN=/tmp/mod/$NAME
FLAG=$D/enabled
LISTS=$D/lists
BLOCK=$LISTS/block.conf
ALLOW=$LISTS/allow.txt
C4=MOD_DNS
C6=MOD_DNS6

. "$D/conf"
PRESETS=$D/presets.txt
# Выбор пользователя лежит вне пакета, установка новой версии его не сбрасывает. conf — только значения по умолчанию.
SETTINGS_DIR=/online/mod/conf/dns
SETTINGS=$SETTINGS_DIR/settings
[ -r "$SETTINGS" ] && . "$SETTINGS"

err() {
	echo "$*" >&2
}

# Записать выбор пользователя в settings: строки КЛЮЧ="значение", без секретов
set_setting() {
	(umask 022; mkdir -p "$SETTINGS_DIR")
	if [ -f "$SETTINGS" ] && grep -q "^$1=" "$SETTINGS"; then
		sed -i "s|^$1=.*|$1=\"$2\"|" "$SETTINGS"
	else
		echo "$1=\"$2\"" >>"$SETTINGS"
	fi
	chmod 644 "$SETTINGS"
}

# Значения пресета в P_ID, P_LABEL, P_PROTO, P_SERVERS, P_TLS. auto — рекомендуемый из списка
resolve_preset() {
	want=$1
	[ "$want" = "auto" ] && want=$(awk -F'|' '!/^#/ && NF >= 6 && $6 == "1" {print $1; exit}' "$PRESETS" 2>/dev/null)
	[ -n "$want" ] || return 1
	line=$(awk -F'|' -v id="$want" '!/^#/ && NF >= 6 && $1 == id {print; exit}' "$PRESETS" 2>/dev/null)
	[ -n "$line" ] || return 1
	P_ID=$want
	P_LABEL=$(echo "$line" | cut -d'|' -f2)
	P_PROTO=$(echo "$line" | cut -d'|' -f3)
	P_SERVERS=$(echo "$line" | cut -d'|' -f4 | tr ',' ' ')
	P_TLS=$(echo "$line" | cut -d'|' -f5)
	[ "$1" = "auto" ] && P_LABEL="Авто: $P_LABEL"
	return 0
}

url_host() {
	h=${1#*://}
	h=${h%%/*}
	echo "${h%%:*}"
}

# Перевести пресет в UPSTREAM, SECURE_SERVERS, PLAIN_SERVERS
preset_vars() {
	case "$P_PROTO" in
		dot | doh)
			UPSTREAM=secure
			SECURE_SERVERS=""
			for ip in $P_SERVERS; do
				if [ "$P_PROTO" = "dot" ]; then e="tls://$ip#$P_TLS"; else e="https://$ip/dns-query#$P_TLS"; fi
				SECURE_SERVERS="$SECURE_SERVERS${SECURE_SERVERS:+ }$e"
			done
			;;
		plain)
			UPSTREAM=plain
			PLAIN_SERVERS=$P_SERVERS
			;;
		operator) UPSTREAM=stock ;;
		custom)
			case "$CUSTOM_DNS" in
				"") return 1 ;;
				https://* | tls://*)
					UPSTREAM=secure
					SECURE_SERVERS="$CUSTOM_DNS#$(url_host "$CUSTOM_DNS")"
					;;
				*)
					UPSTREAM=plain
					PLAIN_SERVERS=$CUSTOM_DNS
					;;
			esac
			;;
		*) return 1 ;;
	esac
	return 0
}

# Текущий пресет: подпись и серверы. Без ключа PRESET в conf (старая настройка) — как записано в conf
CUR_PRESET=${PRESET:-}
CUR_LABEL=""
init_preset() {
	if [ -z "$CUR_PRESET" ]; then
		CUR_PRESET=manual
		CUR_LABEL="Вручную (conf)"
		return 0
	fi
	if resolve_preset "$CUR_PRESET"; then
		CUR_LABEL=$P_LABEL
		preset_vars
	else
		CUR_LABEL=$CUR_PRESET
	fi
	return 0
}

# PID процесса $1 (dnsmasq или smartdns), если он жив и это наш
get_pid() {
	f=$RUN/$1.pid
	[ -f "$f" ] || return 1
	pid=$(cat "$f" 2>/dev/null)
	[ -n "$pid" ] && [ -d "/proc/$pid" ] || return 1
	grep -q "bin/$1" "/proc/$pid/cmdline" 2>/dev/null || return 1
	echo "$pid"
}

rss_of() {
	grep VmRSS "/proc/$1/status" 2>/dev/null | tr -s ' ' | sed 's/VmRSS:[^0-9]*//; s/ kB//'
}

stop_one() {
	pid=$(get_pid "$1")
	if [ -n "$pid" ]; then
		kill "$pid"
		n=0
		while [ -d "/proc/$pid" ] && [ $n -lt 30 ]; do
			n=$((n + 1))
			sleep 0.1 2>/dev/null || sleep 1
		done
		[ -d "/proc/$pid" ] && kill -9 "$pid"
	fi
	rm -f "$RUN/$1.pid"
}

# Снять все переходы в цепочку $4 из цепочки $3 таблицы $2 программой $1
unhook() {
	$1 -t "$2" -S "$3" 2>/dev/null | grep -- "-j $4\$" | sed 's/^-A /-D /' |
	while read -r line; do
		# shellcheck disable=SC2086
		$1 -t "$2" $line
	done
}

lan_ip() {
	ip -4 addr show dev "$IFACE_LAN" 2>/dev/null | awk '/inet /{sub("/.*", "", $2); print $2; exit}'
}

rules_up() {
	$IPT4 -t nat -N $C4 2>/dev/null
	$IPT4 -t nat -F $C4
	dst=""
	if [ "$FORCE" != "1" ]; then
		ip=$(lan_ip)
		[ -n "$ip" ] && dst="-d $ip"
	fi
	# shellcheck disable=SC2086
	$IPT4 -t nat -A $C4 $dst -p udp --dport 53 -j REDIRECT --to-ports "$PORT" || return 1
	# shellcheck disable=SC2086
	$IPT4 -t nat -A $C4 $dst -p tcp --dport 53 -j REDIRECT --to-ports "$PORT" || return 1
	unhook $IPT4 nat PREROUTING $C4
	# Первым в PREROUTING: раньше стокового перехвата DNS (PRE_REDIRECT)
	$IPT4 -t nat -I PREROUTING 1 -i "$IFACE_LAN" -j $C4
	if [ "$BLOCK_DNS6" = "1" ]; then
		$IPT6 -t filter -N $C6 2>/dev/null
		$IPT6 -t filter -F $C6
		$IPT6 -t filter -A $C6 -p udp --dport 53 -j REJECT
		$IPT6 -t filter -A $C6 -p tcp --dport 53 -j REJECT --reject-with tcp-reset
		unhook $IPT6 filter INPUT $C6
		unhook $IPT6 filter FORWARD $C6
		$IPT6 -t filter -I INPUT 1 -i "$IFACE_LAN" -j $C6
		[ "$FORCE" = "1" ] && $IPT6 -t filter -I FORWARD 1 -i "$IFACE_LAN" -j $C6
	fi
	return 0
}

rules_down() {
	unhook $IPT4 nat PREROUTING $C4
	$IPT4 -t nat -F $C4 2>/dev/null
	$IPT4 -t nat -X $C4 2>/dev/null
	unhook $IPT6 filter INPUT $C6
	unhook $IPT6 filter FORWARD $C6
	$IPT6 -t filter -F $C6 2>/dev/null
	$IPT6 -t filter -X $C6 2>/dev/null
	return 0
}

rules_ok() {
	$IPT4 -t nat -S PREROUTING 2>/dev/null | grep -q -- "-j $C4\$" &&
	$IPT4 -t nat -S $C4 2>/dev/null | grep -q -- "REDIRECT"
}

rules_left() {
	$IPT4 -t nat -S 2>/dev/null | grep -q -- "-N $C4\$" && return 0
	$IPT6 -t filter -S 2>/dev/null | grep -q -- "-N $C6\$"
}

# Конфиг smartdns: только пересылка по TLS/HTTPS, без кэша (кэш у dnsmasq)
make_smartdns_conf() {
	{
		echo "bind 127.0.0.1:$SECURE_PORT"
		# По TCP отвечает циклу проверки: nc в busybox роутера не умеет UDP
		echo "bind-tcp 127.0.0.1:$SECURE_PORT"
		if [ "$FALLBACK" = "1" ]; then
			echo "bind 127.0.0.1:$BACKUP_PORT -group backup"
			echo "bind-tcp 127.0.0.1:$BACKUP_PORT -group backup"
		fi
		echo "cache-size 0"
		echo "prefetch-domain no"
		echo "serve-expired no"
		echo "speed-check-mode none"
		echo "dualstack-ip-selection no"
		echo "log-level warn"
		echo "log-file $RUN/smartdns.log"
		echo "log-size 64K"
		echo "log-num 1"
		echo "ca-file $D/cacert.pem"
		boot=0
		for s in $SECURE_SERVERS; do
			url=${s%%#*}
			host=${s#*#}
			[ "$host" = "$s" ] && host=""
			opt=""
			[ -n "$host" ] && opt="-host-name $host -tls-host-verify $host"
			case "$(url_host "$url")" in *[a-zA-Z]*) boot=1 ;; esac
			case "$url" in
				tls://*) echo "server-tls ${url#tls://} $opt" ;;
				https://*) echo "server-https $url $opt${host:+ -http-host $host}" ;;
			esac
		done
		# Запасные серверы отвечают только на своем порту: обычные запросы к ним не идут
		if [ "$FALLBACK" = "1" ]; then
			for s in $FALLBACK_SERVERS; do
				url=${s%%#*}
				host=${s#*#}
				opt="-host-name $host -tls-host-verify $host -group backup -exclude-default-group"
				case "$url" in
					tls://*) echo "server-tls ${url#tls://} $opt" ;;
					https://*) echo "server-https $url $opt -http-host $host" ;;
				esac
			done
		fi
		# Сервер задан именем: адрес узнаем через рекомендуемый пресет (DNS оператора имя может подменить).
		# Для обычных запросов этот сервер не используется.
		if [ $boot = 1 ]; then
			if resolve_preset auto && [ "$P_PROTO" = "dot" ]; then
				echo "server-tls ${P_SERVERS%% *} -host-name $P_TLS -tls-host-verify $P_TLS -bootstrap-dns -exclude-default-group"
			else
				echo "server 127.0.0.1 -bootstrap-dns -exclude-default-group"
			fi
		fi
	} >"$RUN/smartdns.conf"
}

# Куда dnsmasq шлет запросы в режиме secure: 0 — пресет, 1 — запасные серверы, 2 — DNS оператора
level_server() {
	case "$1" in
		1) echo "server=127.0.0.1#$BACKUP_PORT" ;;
		2) echo "server=127.0.0.1#53" ;;
		*) echo "server=127.0.0.1#$SECURE_PORT" ;;
	esac
}

level_now() {
	v=$(cat "$RUN/level" 2>/dev/null)
	echo "${v:-0}"
}

# Сменить сервер без перезапуска. SIGHUP заодно чистит кэш: подмененные ответы оператора в нем не останутся
set_level() {
	echo "$1" >"$RUN/level"
	level_server "$1" >"$RUN/servers.conf.new" && mv "$RUN/servers.conf.new" "$RUN/servers.conf"
	p=$(get_pid dnsmasq)
	[ -n "$p" ] && kill -HUP "$p"
	echo "$(date '+%Y-%m-%d %H:%M:%S') сервер DNS: $(level_name "$1")" >>"$RUN/svc.log"
}

level_name() {
	case "$1" in
		1) echo backup ;;
		2) echo operator ;;
		*) echo preset ;;
	esac
}

# Запрос A example.com по TCP. Первые байты ответа: длина 2, id 2, флаги 2, вопросов 2, ответов 2
PROBE_WAIT=3
PROBE_QUERY='\000\035\253\315\001\000\000\001\000\000\000\000\000\000\007example\003com\000\000\001\000\001'

probe() {
	( $BB printf "$PROBE_QUERY"; sleep "$PROBE_WAIT" ) | $BB timeout -t "$PROBE_WAIT" $BB nc 127.0.0.1 "$1" >"$RUN/probe" 2>/dev/null
	# shellcheck disable=SC2046
	set -- $($BB od -An -tx1 -v "$RUN/probe" 2>/dev/null | head -n 1)
	rm -f "$RUN/probe"
	[ "$3$4" = "abcd" ] || return 1
	case "$6" in ?0) ;; *) return 1 ;; esac
	[ "${10}" != "00" ]
}

# Сбои пересылки по счетчикам самого dnsmasq (SIGUSR1 пишет их в журнал): код 0 — появились новые.
# Запросов наружу нет. Проверка по DoT — около 17 КБ на настоящих серверах, поэтому только при признаке сбоя
upstream_failed() {
	p=$(get_pid dnsmasq)
	[ -n "$p" ] || return 1
	kill -USR1 "$p"
	sleep 1
	n=$(awk '/server 127\.0\.0\.1#/ {
		for (i = 1; i < NF; i++) if ($i == "retried" || $i == "failed") s += $(i + 1) + 0
	} END {print s + 0}' "$RUN/dnsmasq.log" 2>/dev/null)
	: >"$RUN/dnsmasq.log"
	[ "$n" != "$failed_seen" ] || return 1
	failed_seen=$n
	return 0
}

watch_pid() {
	p=$(cat "$RUN/watch.pid" 2>/dev/null)
	[ -n "$p" ] && grep -q "watch" "/proc/$p/cmdline" 2>/dev/null && echo "$p"
}

watch_start() {
	watch_pid >/dev/null && return 0
	$BB setsid $BB sh "$D/svc.sh" watch </dev/null >/dev/null 2>&1 8>&- &
	echo $! >"$RUN/watch.pid"
}

watch_stop() {
	p=$(watch_pid)
	[ -n "$p" ] && kill "$p" 2>/dev/null
	rm -f "$RUN/watch.pid"
}

lock_on() {
	exec 8>"$RUN/op.lock"
	$BB flock 8
}

lock_off() {
	exec 8>&-
}

watch_log() {
	echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$RUN/svc.log"
}

uptime_s() {
	cut -d. -f1 /proc/uptime
}

# Строка для svc.log в первые минуты после запуска: почему пресет не отвечает. Показывает процессор, маршрут и порт сервера
start_diag() {
	cpu=$(awk '$1 == "cpu" {print $2 + $3 + $4 + $5 + $6 + $7 + $8, $5; exit}' /proc/stat)
	free=$(echo "$cpu_prev $cpu" | awk 'NF == 4 && $3 > $1 {printf "%d", ($4 - $2) * 100 / ($3 - $1)}')
	cpu_prev=$cpu
	r=нет
	/system/bin/ip route show 0.0.0.0/0 2>/dev/null | grep -q default && r=есть
	s=${SECURE_SERVERS%% *}
	h=$(url_host "${s%%#*}")
	case "$s" in tls://*) port=853 ;; *) port=443 ;; esac
	c=есть
	$BB timeout -t 3 $BB nc -w 2 "$h" "$port" </dev/null >/dev/null 2>&1
	[ $? = 1 ] && c=нет
	watch_log "пресет не отвечает, с загрузки $(uptime_s) с: процессор свободен ${free:-?} %, маршрут $r, порт $port $c"
}

# Цикл следит за службой, пока пользователь ее не выключил.
# 1. dnsmasq нет: правила снять, чтобы клиенты получали стоковый DNS, и пробовать запуск раз в START_RETRY.
# 2. smartdns нет или не слушает порт 3 минуты: запустить заново. Трафика это не тратит.
# 3. Пресет не отвечает: запасные серверы, потом DNS оператора; только secure и FALLBACK=1.
# Пока работает пресет и сбоев нет, запросов наружу нет: трафик и радиомодуль не тратятся.
# На запасном пути пресет проверяется чаще первые 10 раз, потом раз в FALLBACK_RETRY: долгая блокировка не должна расходовать трафик.
# Первые START_WINDOW секунд после запуска (сеть и процессор при загрузке заняты): проверка раз в 10 с и с большим ожиданием,
# smartdns перезапускается раз в минуту, причины пишутся в svc.log.
do_watch() {
	echo $$ >"$RUN/watch.pid"
	started=$(uptime_s)
	restarted=0
	failed_seen=0
	# Первая проверка сразу после запуска: при запуске серверы могут быть недоступны
	first=1
	quick=10
	waited=0
	unready=0
	pause=2
	while :; do
		sleep "$pause"
		pause=$WATCH_POLL
		now=$(uptime_s)
		early=0
		if [ $((now - started)) -lt "$START_WINDOW" ]; then
			early=1
			PROBE_WAIT=5
			[ "$pause" -gt 10 ] && pause=10
		else
			PROBE_WAIT=3
		fi
		[ -r "$SETTINGS" ] && . "$SETTINGS"
		CUR_PRESET=${PRESET:-}
		init_preset
		if ! get_pid dnsmasq >/dev/null; then
			[ "$DNS_USER_OFF" = "1" ] && break
			rules_ok && rules_down
			lock_on
			if ! get_pid dnsmasq >/dev/null; then
				if do_start >/dev/null 2>&1; then
					watch_log "служба запущена повторно"
				else
					watch_log "запуск не удался: $(cat "$RUN/last_error" 2>/dev/null)"
					pause=$START_RETRY
				fi
			fi
			lock_off
			continue
		fi
		[ "$UPSTREAM" = "secure" ] || continue
		if ! get_pid smartdns >/dev/null; then
			lock_on
			get_pid smartdns >/dev/null || smartdns_spawn
			lock_off
			watch_log "smartdns запущен заново"
		elif smartdns_listening; then
			[ "$unready" -gt 0 ] && watch_log "smartdns готов, ждали около $unready с"
			unready=0
		else
			[ "$unready" = "0" ] && watch_log "smartdns еще не слушает порт: $(cat "/proc/$(get_pid smartdns)/wchan" 2>/dev/null)"
			unready=$((unready + WATCH_POLL))
			if [ "$unready" -ge 180 ]; then
				watch_log "smartdns не слушает порт 3 минуты, запускаю заново"
				lock_on
				stop_one smartdns
				smartdns_spawn
				lock_off
				unready=0
			fi
		fi
		[ "$FALLBACK" = "1" ] || continue
		bad=0
		upstream_failed && bad=1
		lvl=$(level_now)
		if [ "$lvl" = "0" ]; then
			if [ "$first" = "1" ]; then
				first=0
			elif [ "$bad" = "0" ]; then
				continue
			fi
			probe "$SECURE_PORT" && continue
			# Один сбой — еще не отказ
			sleep 5
			probe "$SECURE_PORT" && continue
		else
			due=0
			if [ "$early" = "1" ]; then
				due=1
			elif [ "$quick" -gt 0 ]; then
				quick=$((quick - 1))
				due=1
			else
				waited=$((waited + WATCH_POLL))
				if [ "$waited" -ge "$FALLBACK_RETRY" ]; then
					waited=0
					due=1
				fi
			fi
			if [ "$due" = "1" ] && probe "$SECURE_PORT"; then
				lock_on
				set_level 0
				lock_off
				quick=10
				continue
			fi
			if [ "$early" = "1" ]; then
				start_diag
				if [ $((now - restarted)) -ge 60 ]; then
					restarted=$now
					lock_on
					stop_one smartdns
					smartdns_spawn
					lock_off
					watch_log "smartdns запущен заново, пресет не отвечает"
					sleep 1
					if probe "$SECURE_PORT"; then
						lock_on
						set_level 0
						lock_off
						quick=10
						continue
					fi
				fi
			fi
			# Запасной сервер проверяется, только если на нем были сбои или пора подняться с DNS оператора
			if [ "$lvl" = "1" ] && [ "$bad" = "0" ]; then continue; fi
			if [ "$lvl" = "2" ] && [ "$due" = "0" ]; then continue; fi
		fi
		if probe "$BACKUP_PORT"; then want=1; else want=2; fi
		if [ "$want" != "$lvl" ]; then
			lock_on
			set_level "$want"
			lock_off
			quick=10
			waited=0
		fi
	done
	rm -f "$RUN/watch.pid"
}

make_dnsmasq_conf() {
	{
		echo "port=$PORT"
		echo "interface=$IFACE_LAN"
		echo "bind-dynamic"
		echo "no-resolv"
		echo "no-hosts"
		echo "domain-needed"
		echo "bogus-priv"
		echo "cache-size=$CACHE"
		echo "user="
		echo "pid-file=$RUN/dnsmasq.pid"
		echo "log-facility=$RUN/dnsmasq.log"
		case "$UPSTREAM" in
			# Отдельный файл: dnsmasq перечитывает его по SIGHUP, переход на запасной сервер не требует перезапуска
			secure) echo "servers-file=$RUN/servers.conf" ;;
			plain)
				for ip in $PLAIN_SERVERS; do echo "server=$ip"; done
				;;
			*) echo "server=127.0.0.1#53" ;;
		esac
		if [ "$ADBLOCK" = "1" ] && [ -s "$BLOCK" ]; then
			echo "conf-file=$BLOCK"
			# Исключения: домены из allow.txt идут к обычным серверам
			if [ -s "$ALLOW" ]; then
				tr 'A-Z' 'a-z' <"$ALLOW" | grep -E '^[a-z0-9_.-]+$' | sed 's#.*#server=/&/\##'
			fi
		fi
	} >"$RUN/dnsmasq.conf"
}

# smartdns без своего режима демона: тот ждет готовности около 3 с и убивает процесс, а при загрузке роутера этого мало.
# Здесь процесс живет, сколько нужно, готовность видна по порту.
smartdns_spawn() {
	make_smartdns_conf
	$BB setsid "$D/bin/smartdns" -f -c "$RUN/smartdns.conf" -p - </dev/null >"$RUN/smartdns.out" 2>&1 8>&- &
	echo $! >"$RUN/smartdns.pid"
}

smartdns_listening() {
	$BB netstat -ltn 2>/dev/null | grep -q "127.0.0.1:$SECURE_PORT "
}

start_failed() {
	echo "$1" >"$RUN/last_error"
	echo "$1"
	[ -f "$RUN/dnsmasq.out" ] && cat "$RUN/dnsmasq.out"
}

# Повторный вызов ничего не ломает. При отказе правил нет, клиенты получают стоковый DNS; цикл watch повторит запуск
do_start() {
	mkdir -p "$RUN"
	chmod 755 /tmp/mod "$RUN"
	watch_start
	if [ "$UPSTREAM" = "secure" ]; then
		get_pid smartdns >/dev/null || smartdns_spawn
	else
		stop_one smartdns
	fi
	if get_pid dnsmasq >/dev/null; then
		rules_ok || rules_up
		echo "dnsmasq уже запущен"
		return 0
	fi
	make_dnsmasq_conf
	rm -f "$RUN/level"
	level_server 0 >"$RUN/servers.conf"
	rm -f "$RUN/dnsmasq.pid"
	if ! "$D/bin/dnsmasq" -C "$RUN/dnsmasq.conf" >"$RUN/dnsmasq.out" 2>&1 8>&-; then
		start_failed "dnsmasq не запустился"
		return 1
	fi
	n=0
	while ! get_pid dnsmasq >/dev/null; do
		n=$((n + 1))
		if [ $n -gt 50 ]; then
			start_failed "dnsmasq не запустился"
			return 1
		fi
		sleep 0.1 2>/dev/null || sleep 1
	done
	if ! rules_up; then
		rules_down
		stop_one dnsmasq
		start_failed "не удалось поставить правила iptables"
		return 1
	fi
	rm -f "$RUN/last_error"
	echo "DNS-фильтр запущен: $CUR_LABEL"
}

do_stop() {
	watch_stop
	rules_down
	stop_one dnsmasq
	stop_one smartdns
	echo "DNS-фильтр остановлен"
}

do_status() {
	p1=$(get_pid dnsmasq)
	p2=$(get_pid smartdns)
	n=0
	[ -s "$BLOCK" ] && n=$(wc -l <"$BLOCK" | tr -d ' ')
	# smartdns перезапускает цикл watch; пока его нет, клиенты получают ответы через dnsmasq с признаком dns_fallback
	if [ -n "$p1" ] && { [ "$UPSTREAM" != "secure" ] || [ -n "$p2" ] || watch_pid >/dev/null; }; then
		if rules_ok; then r="есть"; else r="нет"; fi
		mem="dnsmasq $(rss_of "$p1") КиБ"
		[ -n "$p2" ] && mem="$mem, smartdns $(rss_of "$p2") КиБ"
		echo "running=1"
		case "$(level_now)" in
			1) cur="запасной сервер, пресет $CUR_LABEL не отвечает" ;;
			2) cur="DNS оператора, серверы не отвечают" ;;
			*) cur=$CUR_LABEL ;;
		esac
		info="сервер: $cur, в списке рекламы $n доменов, правила: $r, память: $mem"
	else
		echo "running=0"
		info="остановлен, в списке рекламы $n доменов"
		{ [ -n "$p1" ] || [ -n "$p2" ]; } && info="работает не полностью: выполните stop и start"
		watch_pid >/dev/null && info="не запустилась, цикл повторяет запуск; клиенты получают стоковый DNS"
		rules_left && info="$info; правила остались: выполните stop"
	fi
	if [ -f "$FLAG" ]; then echo "enabled=1"; else echo "enabled=0"; fi
	echo "info=$info"
	echo "preset=$CUR_PRESET"
	echo "preset_label=$CUR_LABEL"
	echo "adblock=$adblock_now"
	l=$(level_now)
	f=0
	[ "$l" = "0" ] || f=1
	echo "dns_fallback=$f"
	echo "dns_upstream=$(level_name "$l")"
	u=0
	[ "$DNS_USER_OFF" = "1" ] && u=1
	echo "user_off=$u"
	echo "last_error=$(cat "$RUN/last_error" 2>/dev/null)"
}

is_running() {
	get_pid dnsmasq >/dev/null || return 1
	[ "$UPSTREAM" != "secure" ] || get_pid smartdns >/dev/null || watch_pid >/dev/null
}

# Применить настройки к работающей службе; правила iptables остаются
apply_running() {
	stop_one dnsmasq
	[ "$1" = "dnsmasq" ] || stop_one smartdns
	if ! out=$(do_start 2>&1); then
		err "служба не запустилась: $(echo "$out" | head -n 1)"
		return 1
	fi
	return 0
}

do_presets() {
	if [ ! -r "$PRESETS" ]; then
		err "нет файла пресетов: $PRESETS"
		return 1
	fi
	resolve_preset auto && {
		a=0
		[ "$CUR_PRESET" = "auto" ] && a=1
		echo "auto|$P_LABEL|$a"
	}
	awk -F'|' -v cur="$CUR_PRESET" '!/^#/ && NF >= 6 {print $1 "|" $2 "|" ($1 == cur ? 1 : 0)}' "$PRESETS"
	return 0
}

do_use_preset() {
	if ! resolve_preset "$1"; then
		err "нет пресета: $1"
		return 1
	fi
	if ! preset_vars; then
		err "для пресета custom сначала задайте адрес: set-custom АДРЕС"
		return 1
	fi
	CUR_PRESET=$1
	CUR_LABEL=$P_LABEL
	set_setting PRESET "$1"
	if get_pid dnsmasq >/dev/null; then
		apply_running || return 1
	fi
	echo "пресет: $CUR_LABEL"
	return 0
}

valid_custom() {
	case "$1" in
		https://*) echo "$1" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._-]+)*/dns-query$' ;;
		tls://*) echo "$1" | grep -Eq '^tls://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' ;;
		*)
			echo "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' &&
			echo "$1" | awk -F. '$1 <= 255 && $2 <= 255 && $3 <= 255 && $4 <= 255 {ok = 1} END {exit !ok}'
			;;
	esac
}

do_set_custom() {
	if ! valid_custom "$1"; then
		err "неверный адрес: нужен IPv4, https://сервер/dns-query или tls://имя"
		return 1
	fi
	# Сертификат проверяется по имени, поэтому для DoH и DoT нужно имя сервера, а не адрес
	case "$1" in
		https://* | tls://*)
			if echo "$(url_host "$1")" | grep -Eq '^[0-9.]+$'; then
				err "для https:// и tls:// укажите имя сервера, а не адрес: по нему проверяется сертификат"
				return 1
			fi
			;;
	esac
	set_setting CUSTOM_DNS "$1"
	CUSTOM_DNS=$1
	if [ "$CUR_PRESET" = "custom" ]; then
		do_use_preset custom >/dev/null || return 1
	fi
	case "$1" in
		https://* | tls://*) echo "свой сервер: $1" ;;
		*) echo "свой сервер: $1 (без шифрования: оператор может подменять ответы)" ;;
	esac
	return 0
}

do_adblock() {
	case "$1" in
		on) v=1 ;;
		off) v=0 ;;
		*)
			err "нужно: adblock on или off"
			return 1
			;;
	esac
	set_setting ADBLOCK "$v"
	ADBLOCK=$v
	adblock_now=$v
	if get_pid dnsmasq >/dev/null; then
		apply_running dnsmasq || return 1
	fi
	if [ "$v" = 1 ]; then echo "блокировка рекламы включена"; else echo "блокировка рекламы выключена"; fi
	return 0
}

# IPv4-адреса серверов DoH и DoT текущего пресета и запасных: пакет awg ставит к ним маршруты через туннель
do_upstreams() {
	[ "$UPSTREAM" = "secure" ] || return 0
	s=$SECURE_SERVERS
	[ "$FALLBACK" = "1" ] && s="$s $FALLBACK_SERVERS"
	for x in $s; do
		url_host "${x%%#*}"
	done
	return 0
}

# Выбор пользователя: выключил — stop работающей службы или disable; включил — start или enable
set_user_off() {
	[ "$DNS_USER_OFF" = "$1" ] && return 0
	set_setting DNS_USER_OFF "$1"
	DNS_USER_OFF=$1
}

# Туннель запущен: DNS нужен и ему, иначе DNS оператора подменяет ответы для заблокированных сайтов
do_vpn_up() {
	[ "$DNS_USER_OFF" = "1" ] && return 0
	do_start
}

do_brief() {
	r=0
	is_running && r=1
	f=0
	[ "$(level_now)" = "0" ] || f=1
	echo "running=$r|preset=$CUR_PRESET|label=$(echo "$CUR_LABEL" | tr '|' '/')|adblock=$adblock_now|fallback=$f"
	return 0
}

# Скачать или взять из файла список и сделать lists/block.conf
do_update() {
	mkdir -p "$RUN" "$LISTS"
	src=$1
	if [ -z "$src" ]; then
		src=$RUN/list.download
		rm -f "$src"
		if [ -x "$D/bin/curl" ]; then
			if ! "$D/bin/curl" -fsSL --cacert "$D/cacert.pem" --max-time 180 --max-filesize 16000000 \
				-o "$src" "$LIST_URL"; then
				rm -f "$src"
				echo "не удалось скачать список: $LIST_URL"
				return 1
			fi
		else
			case "$LIST_URL" in
				https://*)
					echo "нет bin/curl, а встроенный wget не умеет https"
					return 1
					;;
			esac
			wget -q -O "$src" "$LIST_URL" || { rm -f "$src"; echo "не удалось скачать список"; return 1; }
		fi
	fi
	if [ ! -s "$src" ]; then
		echo "список пуст или нет файла: $src"
		return 1
	fi
	# Строки: «домен», «0.0.0.0 домен», «127.0.0.1 домен», «||домен^». Остальное отбрасывается.
	tr -d '\r' <"$src" | tr 'A-Z' 'a-z' | awk '
		/^[ \t]*[#!]/ { next }
		{
			d = $1
			if ((d == "0.0.0.0" || d == "127.0.0.1" || d == "::" || d == "::1") && NF >= 2) d = $2
			sub(/^\|\|/, "", d); sub(/\^.*$/, "", d); sub(/^\*\./, "", d); sub(/\.$/, "", d)
			if (d !~ /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/) next
			if (d == "localhost" || d ~ /\.local$/ || d ~ /\.localdomain$/) next
			print d
		}' | sort -u | head -n "$LIST_MAX" | sed 's#.*#address=/&/\##' >"$BLOCK.new"
	cnt=$(wc -l <"$BLOCK.new" | tr -d ' ')
	if [ "$cnt" -eq 0 ]; then
		rm -f "$BLOCK.new"
		echo "в списке не нашлось ни одного домена"
		return 1
	fi
	mv "$BLOCK.new" "$BLOCK"
	[ -z "$1" ] && rm -f "$src"
	echo "список обновлен: $cnt доменов"
	if get_pid dnsmasq >/dev/null; then
		lock_on
		stop_one dnsmasq
		do_start >/dev/null && echo "dnsmasq перезапущен"
		lock_off
	fi
	return 0
}

init_preset
# Запуск и остановка — по одному: пакет awg, mod-ctl, панель и цикл watch могут обратиться одновременно
case "$1" in
	start | stop | restart | vpn-up | use-preset | set-custom | adblock)
		mkdir -p "$RUN"
		chmod 755 /tmp/mod "$RUN" 2>/dev/null
		[ "$1" = "stop" ] && watch_stop
		[ "$1" = "restart" ] && watch_stop
		lock_on
		;;
esac
adblock_now=0
[ "$ADBLOCK" = "1" ] && adblock_now=1

case "$1" in
	start) set_user_off 0; do_start ;;
	stop)
		# Остановка уже остановленной службы — не выбор: так делает mod-ctl перед обновлением
		get_pid dnsmasq >/dev/null && set_user_off 1
		do_stop
		;;
	restart) set_user_off 0; do_stop >/dev/null; do_start ;;
	status) do_status ;;
	enable) set_user_off 0; : >"$FLAG" && echo "автозапуск включен" ;;
	disable) set_user_off 1; rm -f "$FLAG"; echo "автозапуск выключен" ;;
	vpn-up) do_vpn_up ;;
	watch) do_watch ;;
	update) do_update "$2" ;;
	presets) do_presets ;;
	use-preset) do_use_preset "$2" ;;
	set-custom) do_set_custom "$2" ;;
	adblock) do_adblock "$2" ;;
	brief) do_brief ;;
	upstreams) do_upstreams ;;
	*) echo "использование: $0 start|stop|restart|status|enable|disable|update [ФАЙЛ]|presets|use-preset ID|set-custom АДРЕС|adblock on|off|brief"; exit 2 ;;
esac
