#!/system/bin/busyboxx sh
# lt.sh ДЕЙСТВИЕ [k=v ...] — вызов помощника так же, как обработчик Lua (запускать от uid 1000).
# Значения k=v — уже в %XX. Данные (для save) — в переменной PAYLOAD.
B=/system/bin/busyboxx
A=$1; shift
q="a=$A"; for kv in "$@"; do q="$q&$kv"; done
id=t$$_$($B date +%s)
{ echo "$q"; $B cat /online/mod/helper/secret; printf '%s' "$PAYLOAD"; } > /var/modq/$id.req
$B sh /online/mod/helper/hc $id ${HC_TIMEOUT:-60}
