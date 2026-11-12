#!/usr/bin/env bash
# Кладет бинарники пакетов в src/pkg/ИМЯ/bin на компьютере. На роутер не ходит.
#
#   src/pkg/get-bins.sh [--only=awg,dns,tpws,zapret2] [--built] [--fetch] [--dl=КАТАЛОГ] [--module[=ФАЙЛ]]
#
# --only=СПИСОК   какие пакеты готовить, по умолчанию все
# --built         amneziawg-go, awg и dnsmasq взять из build/out (собраны build/build.sh), а не из prebuilt/
# --fetch         smartdns, curl, tpws, nfqws2 скачать из релизов авторов, а не брать из prebuilt/
# --dl=КАТАЛОГ    куда скачивать архивы, по умолчанию src/pkg/.dl; что уже там лежит, повторно не скачивается
# --module        положить в пакет awg модуль ядра amneziawg.ko из ../kernel-module/prebuilt/neon общего комплекта
# --module=ФАЙЛ   то же из своего файла. Без этих ключей модуля в пакете нет, туннель держит amneziawg-go
#
# Все бинарники лежат в prebuilt/, сеть не нужна. Файла в prebuilt/ нет — скачивается из релиза автора.
# Каждый файл сверяется по sha256; при расхождении скрипт останавливается.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PRE=$ROOT/prebuilt
ONLY=awg,dns,tpws,zapret2
BUILT=0
FETCH=0
DL=$HERE/.dl
MODULE=""

for a in "$@"; do
	case "$a" in
	--only=*) ONLY=${a#--only=} ;;
	--built) BUILT=1 ;;
	--fetch) FETCH=1 ;;
	--dl=*) DL=${a#--dl=} ;;
	--module) MODULE=$ROOT/../kernel-module/prebuilt/neon/amneziawg.ko ;;
	--module=*) MODULE=${a#--module=} ;;
	-h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) echo "Ошибка: неизвестный ключ: $a (справка: --help)" >&2; exit 2 ;;
	esac
done

die() { echo "Ошибка: $*" >&2; exit 1; }
has() { case ",$ONLY," in *",$1,"*) return 0 ;; esac; return 1; }
for c in ${ONLY//,/ }; do
	case "$c" in awg|dns|tpws|zapret2) ;; *) die "в --only неизвестный пакет: $c" ;; esac
done

# sha256_ok ФАЙЛ SHA256
sha256_ok() { [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ]; }

# fetch URL ИМЯ SHA256 — скачивает в каталог загрузок, проверяет хеш
fetch() {
	local url=$1 name=$2 sha=$3 f=$DL/$2
	mkdir -p "$DL"
	if [ ! -f "$f" ]; then
		echo "  скачиваю $name"
		curl -fsSL --retry 3 -o "$f.part" "$url" || die "не удалось скачать $url"
		mv -f "$f.part" "$f"
	fi
	sha256_ok "$f" "$sha" || die "sha256 файла $f не совпал (ожидается $sha). Удалите файл и повторите."
}

# put ФАЙЛ SHA256 ПАКЕТ/bin/ИМЯ
put() {
	local src=$1 sha=$2 dst=$HERE/$3
	sha256_ok "$src" "$sha" || die "sha256 файла $src не совпал (ожидается $sha)"
	mkdir -p "$(dirname "$dst")"
	cp -f "$src" "$dst"
	chmod 755 "$dst"
	echo "  $3"
}

# Брать ли файл из prebuilt/
pre() { [ $FETCH = 0 ] && [ -f "$PRE/$1" ]; }

# Бинарники из prebuilt/ или своей сборки
own() { # ИМЯ_В_PREBUILT ИМЯ_ФАЙЛА SHA256 ЦЕЛЬ
	if [ $BUILT = 1 ]; then
		local f=$ROOT/build/out/$2
		[ -f "$f" ] || die "нет $f: сначала build/build.sh"
		mkdir -p "$(dirname "$HERE/$4")"
		cp -f "$f" "$HERE/$4"
		chmod 755 "$HERE/$4"
		echo "  $4 (своя сборка)"
	else
		put "$PRE/$1/$2" "$3" "$4"
	fi
}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/get-bins.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

if has awg; then
	echo "awg:"
	own amneziawg-go amneziawg-go 0a5b18764769e4e1bd7328a390ba4a12a560dac87f15afbf5328b2f16c6a9492 awg/bin/amneziawg-go
	own amneziawg-tools awg 36be7da619361c20ae319d6ec9bd1732975f87c2e8bb51deb8f575c5dddaca61 awg/bin/awg
	if [ -n "$MODULE" ]; then
		[ -f "$MODULE" ] || die "нет файла модуля $MODULE; его сборка и исходники — каталог kernel-module общего комплекта"
		cp -f "$MODULE" "$HERE/awg/amneziawg.ko"
		chmod 644 "$HERE/awg/amneziawg.ko"
		# Проверенная сборка NEON: md5 6650d98a006f25c1edf326693b81125a
		sha256_ok "$HERE/awg/amneziawg.ko" f2b6991c0aa2895cd6b5e4c234cbf8732cff922ab8082ff999aad1101fc6afff ||
			echo "  Внимание: это не та сборка модуля, что проверена на роутере"
		echo "  awg/amneziawg.ko (модуль нельзя выгружать, снять — только перезагрузкой; см. awg/README.md)"
	fi
fi

if has dns; then
	echo "dns:"
	own dnsmasq dnsmasq e5b27c7f40532d09e4ce069ddf3584e4ec0b9391f124f93cc4c8fbdf0642c1ff dns/bin/dnsmasq
	if pre smartdns/smartdns; then
		put "$PRE/smartdns/smartdns" c1675c98e9b34e8327eda6561c27559727c52bd92fe5669639a10ac56ebb931b dns/bin/smartdns
	else
		fetch https://github.com/pymumu/smartdns/releases/download/Release48.4/smartdns-arm smartdns-arm \
			1abf76864b7976387f7b2345a9f4acf229707f755a21b430c1756296a91ef7e3
		put "$DL/smartdns-arm" 1abf76864b7976387f7b2345a9f4acf229707f755a21b430c1756296a91ef7e3 dns/bin/smartdns
		# strip экономит на роутере около 900 КиБ; без него smartdns работает так же
		st=""
		for t in armv6-unknown-linux-musleabi-strip arm-linux-gnueabi-strip arm-linux-gnueabihf-strip llvm-strip; do
			command -v "$t" >/dev/null && { st=$t; break; }
		done
		if [ -n "$st" ]; then
			"$st" "$HERE/dns/bin/smartdns" && echo "  dns/bin/smartdns: уменьшен через $st"
		else
			echo "  dns/bin/smartdns: strip для ARM не найден, оставлен как есть (4,1 МиБ)"
		fi
	fi
	if pre curl/curl; then
		put "$PRE/curl/curl" 990b46936967f134ac933724ae10266068a2adb5623a7d527620ee9bcd68405f dns/bin/curl
	else
		fetch https://github.com/stunnel/static-curl/releases/download/8.23.0-1/curl-linux-armv7-musl-8.23.0-1.tar.xz \
			curl-linux-armv7-musl-8.23.0-1.tar.xz 10245cccca6e81b654ec7454c0397ab26e4a31910440548625a3802ce0971b3b
		tar -xJf "$DL/curl-linux-armv7-musl-8.23.0-1.tar.xz" -C "$TMP" curl
		put "$TMP/curl" 990b46936967f134ac933724ae10266068a2adb5623a7d527620ee9bcd68405f dns/bin/curl
	fi
fi

if has tpws; then
	echo "tpws:"
	if pre tpws/tpws; then
		put "$PRE/tpws/tpws" 412032484525f7fef8ea7d69e7eefc2c972098aee8879a5f93c70dcfb75b1438 tpws/bin/tpws
	else
		fetch https://github.com/bol-van/zapret/releases/download/v72.13/zapret-v72.13.tar.gz \
			zapret-v72.13.tar.gz 25c74e6c5f48963fa244c2955e76694a07c39447245a0457e2efdc74b3317e68
		tar -xzf "$DL/zapret-v72.13.tar.gz" -C "$TMP" zapret-v72.13/binaries/linux-arm/tpws
		put "$TMP/zapret-v72.13/binaries/linux-arm/tpws" 412032484525f7fef8ea7d69e7eefc2c972098aee8879a5f93c70dcfb75b1438 tpws/bin/tpws
	fi
fi

if has zapret2; then
	echo "zapret2:"
	if pre zapret2/nfqws2; then
		lua=$PRE/zapret2/lua
		put "$PRE/zapret2/nfqws2" 32dc4a573830a334d4cec48194814e9eb6a1ad312cb4f630beefcdc157128c8b zapret2/bin/nfqws2
	else
		fetch https://github.com/bol-van/zapret2/releases/download/v1.0.6/zapret2-v1.0.6.tar.gz \
			zapret2-v1.0.6.tar.gz eb412aebc82cdef1f09b6aa9df45c8ff60fb88683b6663e6c4a9275d87ea2db4
		tar -xzf "$DL/zapret2-v1.0.6.tar.gz" -C "$TMP" zapret2-v1.0.6/binaries/linux-arm/nfqws2 \
			zapret2-v1.0.6/lua/zapret-lib.lua zapret2-v1.0.6/lua/zapret-antidpi.lua
		lua=$TMP/zapret2-v1.0.6/lua
		put "$TMP/zapret2-v1.0.6/binaries/linux-arm/nfqws2" 32dc4a573830a334d4cec48194814e9eb6a1ad312cb4f630beefcdc157128c8b zapret2/bin/nfqws2
	fi
	mkdir -p "$HERE/zapret2/lua"
	for f in zapret-lib.lua:6bf528fef1f0fc3c65e189216fc8a06bb873f6e25d1c29d2bfa4695a09b73440 \
		zapret-antidpi.lua:6d1fa9168e5de1682fef91fd174f68b58c50f6739ef00f42ca7db2b940b6246d; do
		n=${f%%:*}
		sha256_ok "$lua/$n" "${f#*:}" || die "sha256 файла $n не совпал"
		cp -f "$lua/$n" "$HERE/zapret2/lua/$n"
		echo "  zapret2/lua/$n"
	done
fi

echo "Готово. Установка: src/installer/install.sh"
