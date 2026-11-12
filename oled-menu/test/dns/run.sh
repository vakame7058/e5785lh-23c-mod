#!/bin/bash
# Стенд пункта «DNS»: настоящие oled_widgets.c, dns_menu.sh и svc.sh пакета dns, без сети.
# Заглушки: dnsmasq, smartdns, iptables, busyboxx = busybox компьютера. /online и /system свои.
# Нужны clang с ASan и UBSan, bwrap, busybox.
#   run.sh СЦЕНАРИЙ...   сценарий как у menu_test: m - МЕНЮ, p - POWER, s<имя> - снимок в out/dns/<имя>.raw
# Без аргументов: главное меню, пункт DNS, переключение блокировки рекламы: снимки в out/dns/png.
# Переменная FAILD="dnsmasq smartdns": эти заглушки падают при запуске.
set -eu
T=$(cd "$(dirname "$0")" && pwd); M=$T/../..; SRC=$M/src; PKG=$M/../webui/src/pkg/dns; OUT=$T/../out/dns
mkdir -p "$OUT/png"
CF="-std=gnu11 -g -O1 -fno-omit-frame-pointer -D_GNU_SOURCE -I$SRC -include stdint.h -include stdio.h -include string.h -include errno.h -include unistd.h -w"
clang $CF -fsanitize=address,undefined -fno-sanitize-recover=all -DOLED_CFG_OVERRIDE_DIR='"/app/hijacks/oled_cfg"' -DNATIVE_MENU_ITEM=13 \
    "$T/menu_test9.c" "$T/../menu/stubs7.c" "$SRC/oled_widgets.c" "$SRC/oled_paint.c" "$SRC/oled_text.c" "$SRC/oled_orbit.c" \
    "$SRC/oled_home.c" "$SRC/oled_home_paint.c" -o "$OUT/menu_test9" -ldl -lpthread
O=$OUT/online; rm -rf "$O"; mkdir -p "$O/mod/pkg/dns/bin" "$O/mod/pkg/dns/lists" "$O/mod/conf"
cp -r "$PKG/svc.sh" "$PKG/conf" "$PKG/presets.txt" "$O/mod/pkg/dns/"
cp "$T/stub/daemon" "$O/mod/pkg/dns/bin/dnsmasq"; cp "$T/stub/daemon" "$O/mod/pkg/dns/bin/smartdns"
echo "address=/ads.example/0.0.0.0" > "$O/mod/pkg/dns/lists/block.conf"
[ $# -gt 0 ] || set -- smenu mmmmp sdns_off mmp sdns_on
BB=$(readlink -f "$(command -v busybox)")
exec bwrap --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --ro-bind /etc /etc --proc /proc --dev /dev --tmpfs /tmp \
    --dir /system/bin --ro-bind "$BB" /system/bin/busyboxx --ro-bind "$T/stub/iptables" /system/bin/iptables --ro-bind "$T/stub/iptables" /system/bin/ip6tables \
    --bind "$O" /online --ro-bind "$M" "$M" --bind "$OUT" "$OUT" --unshare-net --unshare-pid --die-with-parent \
    --setenv HIJ_TEST_ENV "HIJ_B=/system/bin/busyboxx" --setenv ASAN_OPTIONS detect_leaks=0 \
    bash -c 'for f in '"${FAILD:-}"'; do : > /tmp/fail_$f; done; exec "$0"/menu_test9 "$1" /nonexistent/svc.sh "$0"/png "${@:2}"' "$OUT" "$SRC" "$@"
