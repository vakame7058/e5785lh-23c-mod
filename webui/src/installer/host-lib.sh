# Общее для install.sh и rollback.sh (bash, компьютер).
# Подключение: . host-lib.sh — после того, как заданы ROUTER_HOST и ROUTER_IFACE.
#
# Настройки через переменные окружения:
#   ROUTER_KEY          файл ключа SSH; пусто — ключи по умолчанию программы ssh и ssh-agent
#   ROUTER_KNOWN_HOSTS  файл ключей хостов, по умолчанию ~/.ssh/known_hosts
#   JUMP_HOST, JUMP_IFACE, JUMP_HTTP_PORT — то же, что ключи --jump, --jump-iface и порт проброса HTTP

ROUTER_HOST=${ROUTER_HOST:-192.168.1.1}
ROUTER_IFACE=${ROUTER_IFACE:-wwx001e101f0000}
ROUTER_KEY=${ROUTER_KEY:-}
ROUTER_KNOWN_HOSTS=${ROUTER_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}
# usb — роутер подключен к этому компьютеру; jump — через другой компьютер по SSH (свой хост в сети роутера)
ROUTER_VIA=${ROUTER_VIA:-usb}
JUMP_HOST=${JUMP_HOST:-}
JUMP_IFACE=${JUMP_IFACE:-}
JUMP_HTTP_PORT=${JUMP_HTTP_PORT:-18081}
# Соединение к промежуточному хосту — отдельное, без общего мастера (ControlPath=none).
jump_ssh() {
	JUMP_SSH=(ssh -o ControlPath=none -o BatchMode=yes -o ConnectTimeout=10 "$JUMP_HOST")
}
CURL=(curl)

# Уборка при выходе: фоновый проброс порта и временный пакет install.sh.
on_exit() {
	[ -n "${JUMP_FWD_PID:-}" ] && kill "$JUMP_FWD_PID" 2>/dev/null
	[ -n "${STAGE:-}" ] && rm -rf "$STAGE" "$STAGE.tar"
	return 0
}
trap on_exit EXIT

die() { echo "Ошибка: $*" >&2; exit 1; }
warn() { echo "Внимание: $*" >&2; }

ssh_cmd() {
	SSH=(ssh)
	[ -n "$ROUTER_KEY" ] && SSH+=(-i "$ROUTER_KEY" -o IdentitiesOnly=yes)
	SSH+=(-o UserKnownHostsFile="$ROUTER_KNOWN_HOSTS" -o HostKeyAlias=e5785-router
		-o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o BatchMode=yes
		-o ServerAliveInterval=10)
	if [ "$ROUTER_VIA" = jump ]; then
		jump_ssh
		SSH+=(-o ProxyCommand="${JUMP_SSH[*]} -W %h:%p")
	fi
	SSH+=("root@$ROUTER_HOST")
}
ssh_cmd

# Маршрут к роутеру должен идти через его интерфейс. Если интерфейс пропал
# (перезагрузка роутера, другой режим USB), адрес роутера уходит по маршруту
# по умолчанию и может оказаться чужим устройством.
check_route() {
	case "$ROUTER_VIA" in
	usb) ;;
	jump) check_route_jump; return ;;
	*) die "неизвестное значение --via: $ROUTER_VIA (можно usb, jump)" ;;
	esac
	local r dev
	r=$(ip route get "$ROUTER_HOST" 2>&1) || die "не удалось узнать маршрут к $ROUTER_HOST: $r"
	dev=$(sed -n 's/.* dev \([^ ]*\).*/\1/p' <<<"$r" | head -n 1)
	[ "$dev" = "$ROUTER_IFACE" ] || die "маршрут к $ROUTER_HOST идет через «${dev:-?}», а не через $ROUTER_IFACE.
Роутер не подключен к этому интерфейсу, по этому адресу может отвечать другое устройство. Ничего не отправлено.
Проверьте: ip -br addr show $ROUTER_IFACE; lsusb | grep 12d1
Другой интерфейс к роутеру — ключ --iface=ИМЯ; через другой компьютер — ключи --via=jump --jump=ИМЯ --jump-iface=ИМЯ."
}

# Через другой компьютер: на нем маршрут к роутеру должен идти через интерфейс JUMP_IFACE
# (сеть роутера). Иначе хост в другой сети, где этот адрес — чужое устройство.
# HTTP-проверки идут через проброс порта на этот хост.
check_route_jump() {
	[ -n "$JUMP_HOST" ] || die "для --via=jump нужен ключ --jump=ИМЯ (имя хоста из ~/.ssh/config)"
	[ -n "$JUMP_IFACE" ] || die "для --via=jump нужен ключ --jump-iface=ИМЯ: интерфейс этого хоста в сети роутера"
	local r dev
	jump_ssh
	r=$("${JUMP_SSH[@]}" "ip route get $ROUTER_HOST" 2>&1) || die "$JUMP_HOST: не удалось узнать маршрут к $ROUTER_HOST: $r
Ничего не отправлено."
	dev=$(sed -n 's/.* dev \([^ ]*\).*/\1/p' <<<"$r" | head -n 1)
	[ "$dev" = "$JUMP_IFACE" ] || die "на $JUMP_HOST маршрут к $ROUTER_HOST идет через «${dev:-?}», а не через $JUMP_IFACE.
По этому адресу может отвечать другое устройство. Ничего не отправлено."
	# проброс для HTTP-проверок: свое фоновое соединение, закрывается при выходе
	if ! (exec 3<>/dev/tcp/127.0.0.1/$JUMP_HTTP_PORT) 2>/dev/null; then
		"${JUMP_SSH[@]}" -f -N -o ExitOnForwardFailure=yes -L "127.0.0.1:$JUMP_HTTP_PORT:$ROUTER_HOST:80" \
			|| die "не удалось открыть проброс порта через $JUMP_HOST"
		JUMP_FWD_PID=$(pgrep -n -f "127.0.0.1:$JUMP_HTTP_PORT:$ROUTER_HOST:80" || true)
	fi
	CURL=(curl --connect-to "$ROUTER_HOST:80:127.0.0.1:$JUMP_HTTP_PORT")
}

# Перед любым обращением к роутеру: путь к нему проверен и ключ хоста SSH совпадает.
preflight() {
	check_route
	local err
	err=$("${SSH[@]}" true 2>&1) || die "SSH до $ROUTER_HOST не прошел или ключ хоста не совпал с $ROUTER_KNOWN_HOSTS. Ничего не отправлено.
Первое подключение делается вручную, см. README.md, раздел об установке.
$err"
}
