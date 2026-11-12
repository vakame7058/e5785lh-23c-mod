#!/system/bin/busyboxx sh
# zapret2 (nfqws2): обход DPI подменой и разрезанием первых пакетов соединения.
# Договор: svc.sh start|stop|status|enable|disable
# status печатает строки running=0|1, enabled=0|1, info=<текст>.

NAME=zapret2
BIN=nfqws2
umask 022
BB=/system/bin/busyboxx
for a in cat chmod cp dirname grep kill mkdir rm sed sleep tr; do
	eval "$a() { $BB $a \"\$@\"; }"
done
IPT4=/system/bin/iptables
IPT6=/system/bin/ip6tables

D=$(cd "$(dirname "$0")" && pwd)
RUN=/tmp/mod/$NAME
PIDF=$RUN/$BIN.pid
LOG=$RUN/$BIN.log
FLAG=$D/enabled
C_SKIP=MOD_ZAP2_SKIP
C_OUT=MOD_ZAP2_OUT
C_IN=MOD_ZAP2_IN

. "$D/conf"

get_pid() {
	[ -f "$PIDF" ] || return 1
	pid=$(cat "$PIDF" 2>/dev/null)
	[ -n "$pid" ] && [ -d "/proc/$pid" ] || return 1
	grep -q "bin/$BIN" "/proc/$pid/cmdline" 2>/dev/null || return 1
	echo "$pid"
}

# Снять все переходы в цепочку $4 из цепочки $3 таблицы $2 программой $1
unhook() {
	$1 -t "$2" -S "$3" 2>/dev/null | grep -- "-j $4\$" | sed 's/^-A /-D /' |
	while read -r line; do
		# shellcheck disable=SC2086
		$1 -t "$2" $line
	done
}

# Первые N пакетов каждого соединения: hashlimit по адресам и портам, запас N, потом 1 в час.
# 1/day ядро не принимает: avg*burst не влезает в 32 бита (ERANGE).
# Замена connbytes, которого нет в ядре роутера.
first_n() {
	echo "-m hashlimit --hashlimit-upto 1/hour --hashlimit-burst $1 --hashlimit-mode srcip,srcport,dstip,dstport --hashlimit-name $2 --hashlimit-htable-max 16384 --hashlimit-htable-expire 120000"
}

rules_up_one() {
	ipt=$1
	sfx=$2
	jq="-j NFQUEUE --queue-num $QNUM --queue-bypass"
	for c in $C_SKIP $C_OUT $C_IN; do
		$ipt -t mangle -N $c 2>/dev/null
		$ipt -t mangle -F $c
	done
	# Пакеты самого nfqws2 (бит FWMARK) — без перехвата и мимо правил TTL/HL мода
	$ipt -t mangle -A $C_SKIP -m mark --mark "$FWMARK/$FWMARK" -j ACCEPT || return 1
	# shellcheck disable=SC2046
	# Пакеты с SYN не перехватываются: иначе они пропустят стоковое TCPMSS, которое стоит в mangle позже
	$ipt -t mangle -A $C_OUT -p tcp -m multiport --dports "$PORTS_TCP" --tcp-flags SYN NONE $(first_n "$TCP_PKT_OUT" "mz2to$sfx") $jq || return 1
	# shellcheck disable=SC2046
	$ipt -t mangle -A $C_IN -p tcp -m multiport --sports "$PORTS_TCP" --tcp-flags SYN NONE $(first_n "$TCP_PKT_IN" "mz2ti$sfx") $jq || return 1
	if [ -n "$PORTS_UDP" ]; then
		# shellcheck disable=SC2046
		$ipt -t mangle -A $C_OUT -p udp -m multiport --dports "$PORTS_UDP" $(first_n "$UDP_PKT_OUT" "mz2uo$sfx") $jq || return 1
		# shellcheck disable=SC2046
		$ipt -t mangle -A $C_IN -p udp -m multiport --sports "$PORTS_UDP" $(first_n "$UDP_PKT_IN" "mz2ui$sfx") $jq || return 1
	fi
	unhook "$ipt" mangle OUTPUT $C_SKIP
	unhook "$ipt" mangle POSTROUTING $C_SKIP
	unhook "$ipt" mangle POSTROUTING $C_OUT
	unhook "$ipt" mangle PREROUTING $C_IN
	$ipt -t mangle -I OUTPUT 1 -j $C_SKIP
	$ipt -t mangle -I POSTROUTING 1 -j $C_SKIP
	# В конец POSTROUTING: правило TTL мода уже отработало, исходный пакет уходит с TTL 64
	$ipt -t mangle -A POSTROUTING -o "$IFACE_WAN" -m mark ! --mark "$FWMARK/$FWMARK" -j $C_OUT
	$ipt -t mangle -I PREROUTING 1 -i "$IFACE_WAN" -j $C_IN
}

rules_down_one() {
	ipt=$1
	unhook "$ipt" mangle OUTPUT $C_SKIP
	unhook "$ipt" mangle POSTROUTING $C_SKIP
	unhook "$ipt" mangle POSTROUTING $C_OUT
	unhook "$ipt" mangle PREROUTING $C_IN
	for c in $C_SKIP $C_OUT $C_IN; do
		$ipt -t mangle -F $c 2>/dev/null
		$ipt -t mangle -X $c 2>/dev/null
	done
	return 0
}

rules_up() {
	rules_up_one $IPT4 4 || return 1
	if [ "$IPV6" = "1" ]; then
		rules_up_one $IPT6 6 || return 1
	fi
	return 0
}

rules_down() {
	rules_down_one $IPT4
	rules_down_one $IPT6
}

rules_ok() {
	$IPT4 -t mangle -S POSTROUTING 2>/dev/null | grep -q -- "-j $C_OUT\$" &&
	$IPT4 -t mangle -S PREROUTING 2>/dev/null | grep -q -- "-j $C_IN\$"
}

rules_left() {
	for ipt in $IPT4 $IPT6; do
		$ipt -t mangle -S 2>/dev/null | grep -q -- "-N MOD_ZAP2_" && return 0
	done
	return 1
}

do_start() {
	if get_pid >/dev/null; then
		rules_ok || rules_up
		echo "nfqws2 уже запущен"
		return 0
	fi
	# После запуска nfqws2 работает не от root и не видит /online: Lua и списки — копией в /tmp
	mkdir -p "$RUN"
	chmod 755 /tmp/mod "$RUN"
	cp "$D"/lua/*.lua "$RUN/"
	chmod 644 "$RUN"/*.lua
	opt="$NFQWS2_OPT"
	if [ -n "$HOSTLIST" ]; then
		if [ ! -r "$HOSTLIST" ]; then
			echo "нет файла списка доменов: $HOSTLIST"
			return 1
		fi
		cp "$HOSTLIST" "$RUN/hostlist.txt"
		chmod 644 "$RUN/hostlist.txt"
		opt="$(echo "$opt" | sed "s#--new#--hostlist=$RUN/hostlist.txt --new#g") --hostlist=$RUN/hostlist.txt"
	fi
	rm -f "$PIDF"
	# shellcheck disable=SC2086
	"$D/bin/$BIN" --daemon --pidfile="$PIDF" --qnum="$QNUM" --fwmark="$FWMARK" --uid="$RUN_UID" \
		--lua-init=@"$RUN/zapret-lib.lua" --lua-init=@"$RUN/zapret-antidpi.lua" \
		$opt >"$LOG" 2>&1
	n=0
	while ! get_pid >/dev/null; do
		n=$((n + 1))
		if [ $n -gt 50 ]; then
			echo "nfqws2 не запустился:"
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
	echo "nfqws2 запущен, очередь $QNUM"
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
	echo "nfqws2 остановлен"
}

do_status() {
	pid=$(get_pid)
	if [ -n "$pid" ]; then
		rss=$(grep VmRSS "/proc/$pid/status" | tr -s ' ' | sed 's/VmRSS:[^0-9]*//; s/ kB//')
		if rules_ok; then r="есть"; else r="нет"; fi
		echo "running=1"
		info="очередь $QNUM, правила: $r, память $rss КиБ"
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
