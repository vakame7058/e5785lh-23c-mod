#!/system/bin/busyboxx sh
# lt-root.sh ДЕЙСТВИЕ [k=v ...] — вызов обработчика помощника напрямую от root, без очереди
# (для заглушек: переменные AWG_PKG, AWG_CONF передаются в обработчик). Данные — в PAYLOAD.
B=/system/bin/busyboxx
A=$1; shift
q="a=$A"; for kv in "$@"; do q="$q&$kv"; done
f=/var/modhelper/lt.$$
{ $B cat /online/mod/helper/secret; printf '%s' "$PAYLOAD"; } > $f
REQUEST_METHOD=POST REMOTE_ADDR=127.0.0.1 QUERY_STRING="$q" CONTENT_LENGTH=$($B wc -c < $f) \
    $B sh /online/mod/helper/www/cgi-bin/h < $f
$B rm -f $f
