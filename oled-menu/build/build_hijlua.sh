#!/bin/sh
# build_hijlua.sh КАТАЛОГ_РЕЗУЛЬТАТА - сборка hijlua (luarun для скриптов меню).
set -e
H=$(cd "$(dirname "$0")" && pwd); S=$H/sysroot; C=$H/crt
mkdir -p "$1"
clang --target=armv7a-linux-androideabi19 --sysroot="$S" -fPIE -O2 -s -nostdlib -fuse-ld=lld -pie \
    -Wl,-z,defs -Wl,--as-needed -Wl,--hash-style=both -Wl,-z,now -Wl,--build-id=sha1 \
    -Wl,-dynamic-linker,/system/bin/linker -Wl,-z,noexecstack \
    -o "$1/hijlua" "$C/crtbegin_dynamic.o" "$H/../hijlua/hijlua.c" \
    -L"$S/app_lib" -L"$S/usr/lib" -lrestcore -lmsgapi -llua -lc "$C/crtend_android.o"
