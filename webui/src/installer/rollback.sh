#!/usr/bin/env bash
# Откат веб-панели на роутере E5785Lh-23c с компьютера.
#
#   rollback.sh [--last] [--dry-run] [--host=АДРЕС]
#
# Без ключей отменяет все установки и возвращает роутер к состоянию до первой установки.
# --last      отменить только последнюю установку (вернуть предыдущую версию)
# --dry-run   показать, что будет сделано, ничего не менять
# --host=...  адрес роутера (по умолчанию 192.168.1.1)
# --iface=... интерфейс компьютера к роутеру (по умолчанию wwx001e101f0000)
# --via=jump --jump=ИМЯ --jump-iface=ИМЯ  через другой компьютер по SSH, см. install.sh --help
#
# Перед обращением к роутеру проверяется, что маршрут к нему идет через этот интерфейс
# и ключ хоста SSH совпадает; иначе отказ. Ключ SSH и файл ключей хостов — переменные
# ROUTER_KEY и ROUTER_KNOWN_HOSTS, см. host-lib.sh. Запись на роутер идет под локом
# /tmp/e5785.lock. Если вызывающий уже держит лок, задайте MOD_LOCK_HELD=1.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/host-lib.sh"
ARGS=()
LAST=0
DRY=0

for a in "$@"; do
	case "$a" in
	--last) ARGS+=(--last); LAST=1 ;;
	--dry-run) ARGS+=(--dry-run); DRY=1 ;;
	--host=*) ROUTER_HOST=${a#--host=} ;;
	--iface=*) ROUTER_IFACE=${a#--iface=} ;;
	--via=*) ROUTER_VIA=${a#--via=} ;;
	--jump=*) JUMP_HOST=${a#--jump=} ;;
	--jump-iface=*) JUMP_IFACE=${a#--jump-iface=} ;;
	-h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) die "неизвестный ключ: $a (справка: --help)" ;;
	esac
done

ssh_cmd   # SSH с учетом --host

# Скрипт отката берется с компьютера и запускается из /tmp роутера:
# откат удаляет /online/mod/mod-uninstall.sh, а работать должен и без него.
REMOTE="B=/system/bin/busyboxx; \$B rm -rf /tmp/mod-uninst && \$B mkdir -p /tmp/mod-uninst && cd /tmp/mod-uninst && \$B tar -xf - && \$B sh ./mod-uninstall.sh ${ARGS[*]:-}; rc=\$?; cd /; \$B rm -rf /tmp/mod-uninst; exit \$rc"

preflight

if [ "${MOD_LOCK_HELD:-0}" != 1 ]; then
	exec 9>/tmp/e5785.lock
	echo "Жду лок /tmp/e5785.lock..."
	flock 9
fi
set +e
tar -C "$HERE/router" --format=ustar --owner=0 --group=0 --numeric-owner -cf - mod-uninstall.sh mod-lib.sh |
	"${SSH[@]}" "$REMOTE"
rc=$?
set -e
[ "${MOD_LOCK_HELD:-0}" != 1 ] && flock -u 9
[ $rc = 0 ] || die "откат на роутере прошел с ошибкой (код $rc)"
[ $DRY = 1 ] && exit 0

check_route
echo ""
echo "Проверка:"
URL=http://$ROUTER_HOST
if [ $LAST = 0 ]; then
	root=$("${CURL[@]}" -s -m 15 "$URL/" || true)
	if grep -q '/html/index.html' <<<"$root" && ! grep -q '/js/mod/' <<<"$root"; then
		echo "  /: стоковое перенаправление на /html/index.html"
	else
		die "/ отдает не стоковое перенаправление"
	fi
	js=$("${CURL[@]}" -s -m 15 "$URL/js/mod/app.js" | head -c 300 || true)
	if grep -q '<code>100002</code>' <<<"$js"; then
		echo "  /js/mod/app.js: файла нет"
	else
		die "/js/mod/app.js еще отдается"
	fi
fi
code=$("${CURL[@]}" -s -m 15 -o /dev/null -w '%{http_code}' "$URL/html/index.html" || true)
[ "$code" = 200 ] || die "/html/index.html: код $code"
echo "  /html/index.html: 200, стоковый интерфейс на месте"
echo "Готово."
