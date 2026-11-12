#!/usr/bin/env bash
# Собирает из исходников то, что лежит в prebuilt/: amneziawg-go, awg, dnsmasq. Результат — build/out/.
#
#   build/build.sh [amneziawg-go|awg|dnsmasq|all]    по умолчанию all
#
# Нужно: docker (образ golang:1.25.12) для amneziawg-go; curl, tar, xz, make для awg и dnsmasq.
# Исходные архивы скачиваются у авторов в build/work, sha256 сверяется. Модули Go скачивает go mod download.
#
# Переменные окружения:
#   TOOLCHAIN  каталог готового тулчейна armv6-unknown-linux-musleabi; пусто — скачать в build/work
#   GOMOD      каталог кэша модулей Go, по умолчанию build/work/gomod
#
# Тулчейн bol-van/musl-cross выходит под постоянным тегом latest. Если его архив изменился,
# скрипт предупреждает: программа соберется, но sha256 результата может отличаться от prebuilt/.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$HERE/work
OUT=$HERE/out
WHAT=${1:-all}
TC_URL=https://github.com/bol-van/musl-cross/releases/download/latest/armv6-unknown-linux-musleabi.tar.xz
TC_SHA=2a92a8d71ed22ad0a984d5a1377a30bbbe0aaaf7492a1861d9417f1476243ecf
CROSS=armv6-unknown-linux-musleabi

die() { echo "Ошибка: $*" >&2; exit 1; }
case "$WHAT" in amneziawg-go|awg|dnsmasq|all) ;; -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; *) die "неизвестная цель: $WHAT" ;; esac
mkdir -p "$WORK" "$OUT"

src_get() { # URL ФАЙЛ SHA256
	if [ ! -f "$2" ]; then
		echo "Скачиваю $1"
		curl -fsSL --retry 3 -o "$2.part" "$1" || die "не удалось скачать $1"
		mv -f "$2.part" "$2"
	fi
	[ "$(sha256sum "$2" | cut -d' ' -f1)" = "$3" ] || die "sha256 файла $2 не совпал (ожидается $3). Удалите файл и повторите."
}
report() { # ФАЙЛ_В_OUT SHA256_PREBUILT
	local got
	got=$(sha256sum "$OUT/$1" | cut -d' ' -f1)
	if [ "$got" = "$2" ]; then echo "$1: совпадает с prebuilt/ ($got)"
	else echo "$1: НЕ совпадает с prebuilt/: $got, в prebuilt/ $2 (другой тулчейн или образ)"; fi
}

toolchain() {
	if [ -n "${TOOLCHAIN:-}" ]; then
		[ -x "$TOOLCHAIN/bin/$CROSS-gcc" ] || die "нет $TOOLCHAIN/bin/$CROSS-gcc"
	else
		TOOLCHAIN=$WORK/$CROSS
		if [ ! -x "$TOOLCHAIN/bin/$CROSS-gcc" ]; then
			echo "Скачиваю тулчейн $TC_URL"
			curl -fsSL --retry 3 -o "$WORK/tc.tar.xz" "$TC_URL" || die "не удалось скачать тулчейн"
			[ "$(sha256sum "$WORK/tc.tar.xz" | cut -d' ' -f1)" = "$TC_SHA" ] ||
				echo "Внимание: архив тулчейна изменился, sha256 результата может отличаться от prebuilt/" >&2
			tar -xJf "$WORK/tc.tar.xz" -C "$WORK"
		fi
	fi
	export PATH=$TOOLCHAIN/bin:$PATH
}

build_go() {
	local a=$WORK/amneziawg-go-v3.1.20260828.tar.gz d=$WORK/amneziawg-go-3.1.20260828
	local mod=${GOMOD:-$WORK/gomod} cache=$WORK/gocache
	src_get https://github.com/amnezia-vpn/amneziawg-go/archive/refs/tags/v3.1.20260828.tar.gz "$a" 24c656cfb80ff6855702710eaf2e3729fa710bf6bfdbbbdfba01984ccd17de95
	rm -rf "$d"; tar -xzf "$a" -C "$WORK"
	# В архиве в version.go старая строка версии: Makefile проекта берет версию из git. Других правок нет.
	printf 'package main\n\nconst Version = "v3.1.20260828"\n' > "$d/version.go"
	mkdir -p "$mod" "$cache"
	docker run --rm -u "$(id -u):$(id -g)" -v "$d:/src" -v "$OUT:/out" -v "$cache:/gocache" -v "$mod:/gomod" \
		-e HOME=/tmp -e GOCACHE=/gocache -e GOMODCACHE=/gomod -w /src golang:1.25.12 sh -c \
		'go mod download && go mod verify && GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/amneziawg-go .'
	report amneziawg-go 0a5b18764769e4e1bd7328a390ba4a12a560dac87f15afbf5328b2f16c6a9492
}

build_awg() {
	local a=$WORK/amneziawg-tools-v3.1.20260812.tar.gz d=$WORK/amneziawg-tools-3.1.20260812
	src_get https://github.com/amnezia-vpn/amneziawg-tools/archive/refs/tags/v3.1.20260812.tar.gz "$a" dbd8ce0748d835d18f30bb76720246b7bfc80bd09cd17c379b1c59f683a18493
	toolchain
	rm -rf "$d"; tar -xzf "$a" -C "$WORK"
	# Флаги — переменными окружения: как аргументы make они затирают путь к заголовкам uapi/linux.
	( cd "$d/src" && CC=$CROSS-gcc CFLAGS="-Os -march=armv7-a -mthumb -ffunction-sections -fdata-sections" \
		LDFLAGS="-static -Wl,--gc-sections -s" make -j"$(nproc)" wg )
	cp -f "$d/src/wg" "$OUT/awg"
	report awg 36be7da619361c20ae319d6ec9bd1732975f87c2e8bb51deb8f575c5dddaca61
}

build_dnsmasq() {
	local a=$WORK/dnsmasq-2.93.tar.xz d=$WORK/dnsmasq-2.93
	src_get https://thekelleys.org.uk/dnsmasq/dnsmasq-2.93.tar.xz "$a" 0c00d4e5c97c8306e5fb932b348b34269c9c29a0e7df0e8e82958b407092bc19
	toolchain
	rm -rf "$d"; tar -xJf "$a" -C "$WORK"
	make -C "$d" -j"$(nproc)" CC=$CROSS-gcc \
		COPTS="-DNO_DHCP -DNO_DHCP6 -DNO_TFTP -DNO_SCRIPT -DNO_AUTH -DNO_LOOP -DNO_ID -DNO_DUMPFILE" \
		CFLAGS="-Os -march=armv7-a -mtune=cortex-a17 -mthumb -ffunction-sections -fdata-sections" \
		LDFLAGS="-static -Wl,--gc-sections -s"
	cp -f "$d/src/dnsmasq" "$OUT/dnsmasq"
	report dnsmasq e5b27c7f40532d09e4ce069ddf3584e4ec0b9391f124f93cc4c8fbdf0642c1ff
}

case "$WHAT" in
amneziawg-go) build_go ;;
awg) build_awg ;;
dnsmasq) build_dnsmasq ;;
all) build_go; build_awg; build_dnsmasq ;;
esac
echo "Готово: $OUT. Положить в пакеты: src/pkg/get-bins.sh --built"
