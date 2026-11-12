#!/bin/sh
# Готовит sysroot и crt для сборки меню: заголовки и crt из bionic Android 10, библиотеки с роутера.
#
# Запуск на компьютере:
#   prepare_sysroot.sh BIONIC СИСТЕМНЫЕ ПРИЛОЖЕНИЯ
#     BIONIC       клон bionic: git clone -b android10-release https://github.com/aosp-mirror/platform_bionic.git
#     СИСТЕМНЫЕ    копия /system/lib с роутера (нужны libc.so, libdl.so, libm.so)
#     ПРИЛОЖЕНИЯ   копия /app/lib с роутера (нужны liblua.so, libmsgapi.so, librestcore.so, только для hijlua)
# Результат: build/sysroot и build/crt. В комплект и в git они не входят.
set -e
[ $# -eq 3 ] || { sed -n '2,9p' "$0" | sed 's/^# \?//'; exit 2; }
BIONIC=$1; SYSLIB=$2; APPLIB=$3
H=$(cd "$(dirname "$0")" && pwd); S=$H/sysroot; C=$H/crt
rm -rf "$S" "$C"
mkdir -p "$S/usr/include" "$S/usr/lib" "$S/app_lib" "$C"

cp -r "$BIONIC"/libc/include/. "$S/usr/include/"
for d in asm-generic drm linux misc mtd rdma scsi sound video xen; do
    cp -r "$BIONIC/libc/kernel/uapi/$d" "$S/usr/include/"
done
cp -r "$BIONIC/libc/kernel/android/uapi/linux/." "$S/usr/include/linux/" 2>/dev/null || true
cp -r "$BIONIC/libc/kernel/uapi/asm-arm/asm" "$S/usr/include/asm"
for f in libc.so libdl.so libm.so; do cp "$SYSLIB/$f" "$S/usr/lib/"; done
for f in liblua.so libmsgapi.so librestcore.so; do cp "$APPLIB/$f" "$S/app_lib/"; done

A=$BIONIC/libc/arch-common/bionic
T="--target=armv7a-linux-androideabi19 --sysroot=$S"
clang $T -DPLATFORM_SDK_VERSION=19 -c "$A/crtbrand.S" -o "$C/crtbrand.o"
clang $T -O2 -fPIC -I"$A" -c "$A/crtbegin_so.c" -o "$C/crtbegin_so_c.o"
clang $T -O2 -fPIE -I"$A" -c "$A/crtbegin.c" -o "$C/crtbegin_dyn_c.o"
ld.lld -r "$C/crtbegin_so_c.o" "$C/crtbrand.o" -o "$C/crtbegin_so.o"
ld.lld -r "$C/crtbegin_dyn_c.o" "$C/crtbrand.o" -o "$C/crtbegin_dynamic.o"
clang $T -c "$A/crtend_so.S" -o "$C/crtend_so.o"
clang $T -c "$A/crtend.S" -o "$C/crtend_android.o"
echo "готово: $S, $C"
