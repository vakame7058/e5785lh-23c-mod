#!/bin/sh
# build.sh КАТАЛОГ_ИСХОДНИКОВ КАТАЛОГ_РЕЗУЛЬТАТА [ФЛАГИ] - сборка hijack_ng под E5785 (bionic 4.4, armv7a) без NDK
set -e
H=$(cd "$(dirname "$0")" && pwd); S=$H/sysroot; C=$H/crt
src=$1; out=$2; shift 2; EXTRA="$*"
mkdir -p "$out"
T="--target=armv7a-linux-androideabi19 --sysroot=$S"
SOF="-shared -nostdlib -fuse-ld=lld -Wl,-z,defs -Wl,--as-needed -Wl,--hash-style=both -Wl,-z,now -Wl,--build-id=sha1 -Wl,-z,noexecstack"
EXEF="-nostdlib -fuse-ld=lld -pie -Wl,-z,defs -Wl,--as-needed -Wl,--hash-style=both -Wl,-z,now -Wl,--build-id=sha1 -Wl,-dynamic-linker,/system/bin/linker -Wl,-z,noexecstack"
LIBS="-L$S/usr/lib -ldl -lc"
cd "$src"
o=oled_hijack.so
clang $T -W -fPIC -O2 -s $EXTRA $SOF -Wl,-soname,$o -o "$out/$o" $C/crtbegin_so.o oled_*.c $LIBS $C/crtend_so.o 2>"$out/$o.log" || { cat "$out/$o.log"; exit 1; }
# имена как в Makefile исходника
if grep -q device_webhook Makefile 2>/dev/null; then hooks="device:/var/device_webhook sms:/var/sms_webhook"; else hooks="web:/var/webhook"; fi
[ -n "$SOCK_OVERRIDE" ] && hooks="$SOCK_OVERRIDE"
for h in $hooks; do
  n=${h%%:*}; sock=${h#*:}
  case $n in web) so=web_hook.so; cl=web_hook_client;; *) so=${n}_webhook.so; cl=${n}_webhook_client;; esac
  clang $T -fPIC -O2 -s -pthread -DHOOK -DSOCK_NAME="\"$sock\"" $EXTRA $SOF -Wl,-soname,$so -o "$out/$so" $C/crtbegin_so.o web_hook.c $LIBS $C/crtend_so.o 2>"$out/$so.log" || { cat "$out/$so.log"; exit 1; }
  clang $T -fPIE -O2 -s -DCLIENT -DSOCK_NAME="\"$sock\"" $EXTRA $EXEF -o "$out/$cl" $C/crtbegin_dynamic.o web_hook.c $LIBS $C/crtend_android.o 2>"$out/$cl.log" || { cat "$out/$cl.log"; exit 1; }
done
for f in "$out"/*.log; do [ -s "$f" ] || rm -f "$f"; done
ls -la "$out"
