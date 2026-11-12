#!/system/bin/busyboxx sh
# tpws: прозрачный прокси против DPI для TCP-соединений клиентов LAN.
# Договор: svc.sh start|stop|status|enable|disable
# status печатает строки running=0|1, enabled=0|1, info=<текст>.

NAME=tpws
umask 022
BB=/system/bin/busyboxx
for a in cat chmod dirname grep head kill mkdir cp rm sed sleep tr wc; do
	eval "$a() { $BB $a \"\$@\"; }"
done
IPT=/system/bin/iptables

D=$(cd "$(dirname "$0")" && pwd)
RUN=/tmp/mod/$NAME
PIDF=$RUN/$NAME.pid
LOG=$RUN/$NAME.log
FLAG=$D/enabled
CHAIN=MOD_TPWS
CHAIN_Q=MOD_TPWS_QUIC
CHAIN_T=MOD_TPWS_TTL

. "$D/conf"

# PID процесса, если он жив и это наш tpws
get_pid() {
	[ -f "$PIDF" ] || return 1
	pid=$(cat "$PIDF" 2>/dev/null)
	[ -n "$pid" ] && [ -d "/proc/$pid" ] || return 1
	grep -q "bin/$NAME" "/proc/$pid/cmdline" 2>/dev/null || return 1
	echo "$pid"
}

# Снять все переходы в цепочку $3 из цепочки $2 таблицы $1
unhook() {
	$IPT -t "$1" -S "$2" 2>/dev/null | grep -- "-j $3\$" | sed 's/^-A /-D /' |
	while read -r line; do
		# shellcheck disable=SC2086
		$IPT -t "$1" $line
	done
}

rules_up() {
	$IPT -t nat -N $CHAIN 2>/dev/null
	$IPT -t nat -F $CHAIN
	for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
		172.16.0.0/12 192.168.0.0/16 224.0.0.0/3; do
		$IPT -t nat -A $CHAIN -d $net -j RETURN
	done
	$IPT -t nat -A $CHAIN -p tcp -m multiport --dports "$PORTS" -j REDIRECT --to-ports "$PORT" || return 1
	unhook nat PREROUTING $CHAIN
	$IPT -t nat -I PREROUTING 1 -i "$IFACE_LAN" -p tcp -j $CHAIN
	# Сегменты с TTL=1 (--disorder) — мимо правила мода TTL --ttl-set 64, иначе перестановка не работает
	$IPT -t mangle -N $CHAIN_T 2>/dev/null
	$IPT -t mangle -F $CHAIN_T
	$IPT -t mangle -A $CHAIN_T -m ttl --ttl-eq 1 -j ACCEPT
	unhook mangle OUTPUT $CHAIN_T
	$IPT -t mangle -I OUTPUT 1 -o "$IFACE_WAN" -j $CHAIN_T
	if [ "$BLOCK_QUIC" = "1" ]; then
		$IPT -t filter -N $CHAIN_Q 2>/dev/null
		$IPT -t filter -F $CHAIN_Q
		$IPT -t filter -A $CHAIN_Q -p udp --dport 443 -j REJECT
		unhook filter FORWARD $CHAIN_Q
		$IPT -t filter -I FORWARD 1 -i "$IFACE_LAN" -p udp -j $CHAIN_Q
	fi
	return 0
}

rules_down() {
	unhook nat PREROUTING $CHAIN
	$IPT -t nat -F $CHAIN 2>/dev/null
	$IPT -t nat -X $CHAIN 2>/dev/null
	unhook filter FORWARD $CHAIN_Q
	$IPT -t filter -F $CHAIN_Q 2>/dev/null
	$IPT -t filter -X $CHAIN_Q 2>/dev/null
	unhook mangle OUTPUT $CHAIN_T
	$IPT -t mangle -F $CHAIN_T 2>/dev/null
	$IPT -t mangle -X $CHAIN_T 2>/dev/null
	return 0
}

rules_ok() {
	$IPT -t nat -S PREROUTING 2>/dev/null | grep -q -- "-j $CHAIN\$" &&
	$IPT -t nat -S $CHAIN 2>/dev/null | grep -q -- "REDIRECT"
}

rules_left() {
	$IPT -t nat -S 2>/dev/null | grep -q -- "-N $CHAIN\$" && return 0
	$IPT -t filter -S 2>/dev/null | grep -q -- "-N $CHAIN_Q\$" && return 0
	$IPT -t mangle -S 2>/dev/null | grep -q -- "-N $CHAIN_T\$"
}

do_start() {
	if get_pid >/dev/null; then
		rules_ok || rules_up
		echo "tpws уже запущен"
		return 0
	fi
	mkdir -p "$RUN"
	chmod 755 /tmp/mod "$RUN"
	opt="$TPWS_OPT"
	if [ -n "$HOSTLIST" ]; then
		if [ ! -r "$HOSTLIST" ]; then
			echo "нет файла списка доменов: $HOSTLIST"
			return 1
		fi
		# после запуска tpws работает не от root и не видит /online: копия в /tmp
		cp "$HOSTLIST" "$RUN/hostlist.txt"
		opt="$(echo "$opt" | sed "s#--new#--hostlist=$RUN/hostlist.txt --new#g") --hostlist=$RUN/hostlist.txt"
	fi
	ulimit -n "$NOFILE" 2>/dev/null
	rm -f "$PIDF"
	# shellcheck disable=SC2086
	"$D/bin/tpws" --daemon --pidfile="$PIDF" --bind-iface4="$IFACE_LAN" --port="$PORT" \
		--uid="$RUN_UID" $opt >"$LOG" 2>&1
	n=0
	while ! get_pid >/dev/null; do
		n=$((n + 1))
		if [ $n -gt 30 ]; then
			echo "tpws не запустился:"
			cat "$LOG"
			return 1
		fi
		sleep 0.1 2>/dev/null || sleep 1
	done
	if ! rules_up; then
		echo "не удалось поставить правила iptables"
		do_stop >/dev/null
		return 1
	fi
	echo "tpws запущен, порт $PORT"
}

do_stop() {
	rules_down
	pid=$(get_pid)
	if [ -n "$pid" ]; then
		kill "$pid"
		n=0
		while [ -d "/proc/$pid" ] && [ $n -lt 30 ]; do
			n=$((n + 1))
			sleep 0.1 2>/dev/null || sleep 1
		done
		[ -d "/proc/$pid" ] && kill -9 "$pid"
	fi
	rm -f "$PIDF"
	echo "tpws остановлен"
}

do_status() {
	pid=$(get_pid)
	if [ -n "$pid" ]; then
		rss=$(grep VmRSS "/proc/$pid/status" | tr -s ' ' | sed 's/VmRSS:[^0-9]*//; s/ kB//')
		if rules_ok; then r="есть"; else r="нет"; fi
		echo "running=1"
		info="порт $PORT, правила: $r, память $rss КиБ"
	else
		echo "running=0"
		info="остановлен"
		rules_left && info="остановлен, но правила остались: выполните stop"
	fi
	if [ -f "$FLAG" ]; then echo "enabled=1"; else echo "enabled=0"; fi
	echo "info=$info"
}

case "$1" in
	start) do_start ;;
	stop) do_stop ;;
	restart) do_stop >/dev/null; do_start ;;
	status) do_status ;;
	enable) : >"$FLAG" && echo "автозапуск включен" ;;
	disable) rm -f "$FLAG"; echo "автозапуск выключен" ;;
	*) echo "использование: $0 start|stop|restart|status|enable|disable"; exit 2 ;;
esac
