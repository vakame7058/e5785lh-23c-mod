#!/usr/bin/env bash
# Установка веб-панели на роутер E5785Lh-23c с компьютера.
#
#   install.sh [--dry-run] [--only=web,api,pkg] [ключи]
#
# --dry-run        собрать пакет и показать, что изменится на роутере; ничего не менять
# --only=СПИСОК    что ставить: web (SPA), api (обработчики Lua и помощник), pkg (пакеты);
#                  по умолчанию все три
# --dist=КАТАЛОГ   готовая сборка SPA вместо src/frontend/dist (build.py не запускается)
# --backend=КАТ.   вместо src/backend (в нем api/mod/ и helper/)
# --pkg=КАТАЛОГ    вместо src/pkg (в нем каталог на каждый пакет)
# --pkg-only=СПИСОК ставить только эти пакеты, например --only=pkg --pkg-only=awg,dns
# --no-build       не запускать build.py, взять src/frontend/dist как есть
# --check-api=ИМЯ  обработчик для проверки «нужен вход» (по умолчанию sysinfo)
# --host=АДРЕС     адрес роутера (по умолчанию 192.168.1.1)
# --iface=ИМЯ      интерфейс компьютера к роутеру (по умолчанию wwx001e101f0000)
# --via=jump       через другой компьютер по SSH, который подключен к сети роутера (с --jump и --jump-iface):
# --jump=ИМЯ       хост из ~/.ssh/config; ключ хоста роутера сверяется
# --jump-iface=ИМЯ интерфейс этого хоста в сети роутера: на нем маршрут к роутеру должен идти через него
# --save=ФАЙЛ      только собрать пакет и сохранить в ФАЙЛ (tar), на роутер не ходить
#
# Перед обращением к роутеру проверяется, что маршрут к нему идет через этот интерфейс
# и ключ хоста SSH совпадает; иначе отказ. Ключ SSH и файл ключей хостов — переменные
# ROUTER_KEY и ROUTER_KNOWN_HOSTS, см. host-lib.sh. Запись на роутер идет под локом
# /tmp/e5785.lock. Если вызывающий уже держит лок, задайте MOD_LOCK_HELD=1.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/host-lib.sh"
P=$(cd "$HERE/../.." && pwd)
ONLY=web,api,pkg
DRY=0
BUILD=1
DIST=""
BACKEND=$P/src/backend
PKGDIR=$P/src/pkg
CHECK_API=sysinfo
SAVE=""
PKG_ONLY=""

for a in "$@"; do
	case "$a" in
	--dry-run) DRY=1 ;;
	--only=*) ONLY=${a#--only=} ;;
	--dist=*) DIST=${a#--dist=}; BUILD=0 ;;
	--backend=*) BACKEND=${a#--backend=} ;;
	--pkg=*) PKGDIR=${a#--pkg=} ;;
	--pkg-only=*) PKG_ONLY=${a#--pkg-only=} ;;
	--no-build) BUILD=0 ;;
	--check-api=*) CHECK_API=${a#--check-api=} ;;
	--host=*) ROUTER_HOST=${a#--host=} ;;
	--iface=*) ROUTER_IFACE=${a#--iface=} ;;
	--via=*) ROUTER_VIA=${a#--via=} ;;
	--jump=*) JUMP_HOST=${a#--jump=} ;;
	--jump-iface=*) JUMP_IFACE=${a#--jump-iface=} ;;
	--save=*) SAVE=${a#--save=} ;;
	-h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) die "неизвестный ключ: $a (справка: --help)" ;;
	esac
done

has() { case ",$ONLY," in *",$1,"*) return 0 ;; esac; return 1; }
for c in ${ONLY//,/ }; do
	case "$c" in web|api|pkg) ;; *) die "в --only неизвестная часть: $c (можно web, api, pkg)" ;; esac
done

ssh_cmd   # SSH с учетом --host

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/mod-pkg.XXXXXX")
F=$STAGE/files
W=$F/app/webroot/WebApp/common
mkdir -p "$F"

# Копирует дерево без мусора редакторов и git.
copy_tree() {
	local src=$1 dst=$2
	mkdir -p "$dst"
	tar -C "$src" --exclude=.git --exclude='*~' --exclude='*.swp' --exclude=__pycache__ \
		--exclude='*.pyc' --exclude=.DS_Store --exclude=enabled -cf - . | tar -C "$dst" -xf -
}

# --- SPA ---
if has web; then
	if [ -z "$DIST" ]; then
		DIST=$P/src/frontend/dist
		if [ $BUILD = 1 ] && [ -f "$P/src/frontend/build.py" ]; then
			echo "Сборка SPA: python3 src/frontend/build.py"
			python3 "$P/src/frontend/build.py" || die "сборка SPA не прошла"
		fi
	fi
	[ -d "$DIST" ] || die "нет сборки SPA: $DIST"
	[ -f "$DIST/html/mod.html" ] || die "нет $DIST/html/mod.html"
	grep -qi '<head>' "$DIST/html/mod.html" ||
		warn "в mod.html нет тега <head>: веб-сервер не вставит csrf_token"
	grep -q '/js/mod/' "$DIST/html/mod.html" ||
		warn "mod.html не ссылается на /js/mod/: пути должны быть абсолютными (/js/mod/app.js)"
	# Оболочка SPA отдается на корень сайта: / → /app/html/redirect.html.
	mkdir -p "$F/app/html"
	cp "$DIST/html/mod.html" "$F/app/html/redirect.html"
	# Запасной адрес той же оболочки: /js/mod/index.html.
	mkdir -p "$W/js/mod"
	gzip -9 -n -c "$DIST/html/mod.html" > "$W/js/mod/index.html.gz"
	# js и css: веб-сервер сам отдает X.gz по запросу X; если есть оба, отдает X.
	# Поэтому кладем только .gz (место на флеше и трафик меньше).
	for sub in js/mod css/mod; do
		[ -d "$DIST/$sub" ] || die "нет $DIST/$sub"
		while IFS= read -r -d '' f; do
			rel=${f#"$DIST/"}
			case "$rel" in
			*.gz) ;;
			*) [ -f "$f.gz" ] && continue ;;
			esac
			mkdir -p "$W/$(dirname "$rel")"
			case "$rel" in
			*.gz) cp "$f" "$W/$rel" ;;
			*.js|*.css|*.html|*.svg|*.json|*.txt) gzip -9 -n -c "$f" > "$W/$rel.gz" ;;
			*) cp "$f" "$W/$rel" ;;
			esac
		done < <(find "$DIST/$sub" -type f -print0)
	done
fi

# --- обработчики и помощник ---
if has api; then
	n=0
	if [ -d "$BACKEND/api/mod" ]; then copy_tree "$BACKEND/api/mod" "$F/app/html/api/mod"; n=1; fi
	# единая точка входа: веб пускает только пути из подписанного списка, /api/mod/* в нем нет
	if [ -d "$BACKEND/api/vsim" ]; then copy_tree "$BACKEND/api/vsim" "$F/app/html/api/vsim"; fi
	if [ -d "$BACKEND/helper" ]; then
		copy_tree "$BACKEND/helper" "$F/online/mod/helper"; n=1
		# Обработчик помощника лежит в исходниках как helper/h, на роутере — www/cgi-bin/h.
		if [ -f "$F/online/mod/helper/h" ] && [ ! -e "$F/online/mod/helper/www/cgi-bin/h" ]; then
			mkdir -p "$F/online/mod/helper/www/cgi-bin"
			mv "$F/online/mod/helper/h" "$F/online/mod/helper/www/cgi-bin/h"
		fi
	fi
	[ $n = 1 ] || warn "в $BACKEND нет ни api/mod/, ни helper/: часть api пропущена"
fi

# --- пакеты ---
if has pkg; then
	if [ -d "$PKGDIR" ] && [ -n "$(ls -A "$PKGDIR" 2>/dev/null)" ]; then
		for d in "$PKGDIR"/*/; do
			[ -d "$d" ] || continue
			if [ -n "$PKG_ONLY" ]; then
				case ",$PKG_ONLY," in *",$(basename "$d"),"*) ;; *) continue ;; esac
			fi
			[ -d "$d/bin" ] || die "в пакете $(basename "$d") нет каталога bin: сначала запустите src/pkg/get-bins.sh"
			copy_tree "$d" "$F/online/mod/pkg/$(basename "$d")"
			[ -f "$d/svc.sh" ] || warn "в пакете $(basename "$d") нет svc.sh: он не будет запускаться"
		done
	else
		warn "нет пакетов в $PKGDIR: часть pkg пропущена"
	fi
fi

# --- служебные файлы ---
mkdir -p "$F/online/mod"
cp "$HERE/router/mod-uninstall.sh" "$HERE/router/mod-lib.sh" "$F/online/mod/"
if has api || has pkg; then
	cp "$HERE/router/mod-ctl.sh" "$F/online/mod/"
	mkdir -p "$F/system/etc/autorun.d"
	cp "$HERE/router/autorun-mod.sh" "$F/system/etc/autorun.d/mod.sh"
fi
{
	echo "сборка: $(date '+%Y-%m-%d %H:%M:%S') на $(hostname)"
	echo "состав: $ONLY"
} > "$F/online/mod/VERSION"
cp "$HERE/router/mod-install.sh" "$HERE/router/mod-uninstall.sh" "$HERE/router/mod-lib.sh" "$STAGE/"

# Скрипты помощника и пакетов (первая строка #!) — исполняемые.
while IFS= read -r -d '' f; do
	[ "$(head -c 2 "$f")" = '#!' ] && chmod 755 "$f"
done < <(find "$F/online" "$F/system" -type f -print0 2>/dev/null)

# --- проверки пакета ---
crlf=$(grep -rlI $'\r' "$F" --include='*.sh' --include='*.lua' || true)
[ -z "$crlf" ] || die "переводы строк CRLF в файлах: $crlf"
if command -v busybox >/dev/null; then
	while IFS= read -r -d '' f; do
		busybox sh -n "$f" || die "ошибка синтаксиса: $f"
	done < <(find "$STAGE" -name '*.sh' -print0)
fi
# На роутере Lua 5.1: проверять только luac5.1, у новых версий другой синтаксис.
if command -v luac5.1 >/dev/null; then
	while IFS= read -r -d '' f; do
		luac5.1 -p "$f" || die "ошибка синтаксиса Lua: $f"
	done < <(find "$F" -name '*.lua' -print0)
fi
nfiles=$(find "$F" -type f | wc -l)
[ "$nfiles" -gt 0 ] || die "пакет пуст"

# Владелец root, без записи для группы и остальных.
tar -C "$STAGE" --format=ustar --sort=name --owner=0 --group=0 --numeric-owner --mode=go-w \
	-cf "$STAGE.tar" mod-install.sh mod-uninstall.sh mod-lib.sh files
echo "Пакет: $nfiles файлов, $(du -k "$STAGE.tar" | cut -f1) КиБ, состав: $ONLY"
if [ -n "$SAVE" ]; then
	cp "$STAGE.tar" "$SAVE"
	echo "Пакет сохранен: $SAVE"
	exit 0
fi

preflight
# --- на роутер ---
DRYFLAG=""; [ $DRY = 1 ] && DRYFLAG=--dry-run
REMOTE="B=/system/bin/busyboxx; \$B rm -rf /tmp/mod-inst && \$B mkdir -p /tmp/mod-inst && cd /tmp/mod-inst && \$B tar -xf - && \$B sh ./mod-install.sh $DRYFLAG; rc=\$?; cd /; \$B rm -rf /tmp/mod-inst; exit \$rc"

if [ "${MOD_LOCK_HELD:-0}" != 1 ]; then
	exec 9>/tmp/e5785.lock
	echo "Жду лок /tmp/e5785.lock..."
	flock 9
fi
set +e
"${SSH[@]}" "$REMOTE" < "$STAGE.tar"
rc=$?
set -e
[ "${MOD_LOCK_HELD:-0}" != 1 ] && flock -u 9
[ $rc = 0 ] || die "установка на роутере не прошла (код $rc)"
[ $DRY = 1 ] && exit 0

# --- проверка с компьютера ---
check_route
echo ""
echo "Проверка:"
fail=0
URL=http://$ROUTER_HOST
check_gz() { # путь_на_сайте файл_сборки
	local body hdr
	hdr=$("${CURL[@]}" -s -m 15 -D - -o "$STAGE.body" "$URL$1" | tr -d '\r') || true
	if ! grep -qi '^content-encoding: gzip' <<<"$hdr"; then
		echo "  $1: нет Content-Encoding: gzip"; fail=1; return
	fi
	body=$(gzip -dc "$STAGE.body" 2>/dev/null | md5sum | cut -d' ' -f1)
	if [ "$body" = "$(md5sum < "$2" | cut -d' ' -f1)" ]; then
		echo "  $1: совпадает со сборкой"
	else
		echo "  $1: НЕ совпадает со сборкой"; fail=1
	fi
}
if has web; then
	root=$("${CURL[@]}" -s -m 15 "$URL/" || true)
	if grep -q '/js/mod/' <<<"$root" && grep -q 'csrf_token' <<<"$root"; then
		echo "  /: отдается оболочка SPA, csrf_token вставлен"
	else
		echo "  /: НЕ оболочка SPA"; fail=1
	fi
	for sub in js/mod/app.js css/mod/app.css; do
		src=$DIST/$sub; [ -f "$src" ] || src=""
		[ -n "$src" ] && check_gz "/$sub" "$src"
	done
	code=$("${CURL[@]}" -s -m 15 -o /dev/null -w '%{http_code}' "$URL/html/index.html" || true)
	if [ "$code" = 200 ]; then echo "  /html/index.html: 200, стоковый интерфейс на месте"
	else echo "  /html/index.html: код $code"; fail=1; fi
fi
if has api; then
	resp=$("${CURL[@]}" -s -m 15 "$URL/api/vsim/config-vsim" | tr -d '\r\n' || true)
	case "$resp" in
	*'<code>125002</code>'*|*'<code>100003</code>'*)
		echo "  /api/vsim/config-vsim без входа: нужен вход" ;;
	*'<response>'*)
		echo "  /api/vsim/config-vsim без входа: ОТВЕЧАЕТ ДАННЫМИ — проверьте, что обработчик требует вход"; fail=1 ;;
	*)
		echo "  /api/vsim/config-vsim без входа: неожиданный ответ: ${resp:0:200}"; fail=1 ;;
	esac
	if [ -d "$F/app/html/api/mod" ]; then
		want=$(cd "$F" && find app/html/api/mod app/html/api/vsim -type f 2>/dev/null | sort | xargs md5sum)
		got=$("${SSH[@]}" "cd / && /system/bin/busyboxx md5sum $(cd "$F" && find app/html/api/mod app/html/api/vsim -type f 2>/dev/null | sort | tr '\n' ' ')" 2>&1 || true)
		if [ "$want" = "$got" ]; then echo "  обработчики в /app/html/api/{mod,vsim}: совпадают с пакетом"
		else echo "  обработчики в /app/html/api/{mod,vsim}: НЕ совпадают с пакетом"; fail=1; fi
	fi
fi
if has api || has pkg; then
	echo "  процессы:"
	"${SSH[@]}" "/system/bin/busyboxx sh /online/mod/mod-ctl.sh status" || true
fi
[ $fail = 0 ] || die "проверка нашла расхождения, см. выше; откат: $HERE/rollback.sh"
echo "Готово. Откат: $HERE/rollback.sh"
