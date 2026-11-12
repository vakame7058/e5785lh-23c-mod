#!/bin/bash
# Сборка balong-usbdload и balong_flash из исходников forth32: Linux x86-64, статически, без путей сборки.
#
# Запуск на компьютере:   tools/recovery/bin/build.sh [КАТАЛОГ_РЕЗУЛЬТАТА]
# По умолчанию результат в tools/recovery/bin. Нужны git, musl-gcc (пакет musl-tools) для balong-usbdload,
# gcc со статическими libc и libz (libc6-dev, zlib1g-dev) для balong_flash.
# Коммиты зафиксированы. Загрузчики usblsafe-*.bin и usbloader-*.bin из репозитория в сборку не входят.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-$HERE}
USBD_REPO=https://github.com/forth32/balong-usbdload.git
USBD_COMMIT=4fa8b92d654c
FLASH_REPO=https://github.com/forth32/balongflash.git
FLASH_COMMIT=bf43faa4b5f6
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

fetch() {  # fetch URL COMMIT КАТАЛОГ
	git clone -q "$1" "$3"
	git -C "$3" checkout -q "$2"
}
# пути исходников не попадают в файл; номер сборки фиксирован значением из репозитория
CF="-O2 -w -ffile-prefix-map=$T=. -fno-ident -static -s -Wl,--build-id=none"

fetch "$USBD_REPO" "$USBD_COMMIT" "$T/usbd"
(cd "$T/usbd" && musl-gcc $CF -o "$T/balong-usbdload" balong-usbdload.c parts.c patcher.c exploit.c)

fetch "$FLASH_REPO" "$FLASH_COMMIT" "$T/flash"
(cd "$T/flash" && gcc $CF -D_7ZIP_ST -DBUILDNO="$(cat build)" -o "$T/balong_flash" \
	balong_flash.c hdlcio_linux.c ptable.c flasher.c util.c signver.c lzma/*.c -lz)

mkdir -p "$OUT"
cp "$T/balong-usbdload" "$T/balong_flash" "$OUT/"
(cd "$OUT" && sha256sum balong-usbdload balong_flash)
