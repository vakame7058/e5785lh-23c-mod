#!/system/bin/busybox sh
# Тест скорости для секретного меню: сначала прием, потом передача.
#   speedtest.sh       - замер; в stdout строки, которые читает виджет (как вывод Ookla speedtest -f json):
#                        {"type":"download","bandwidth":Б/с,"progress":0..1}
#                        {"type":"upload","bandwidth":Б/с,"progress":0..1}
#                        {"type":"upload","none":1} - отдачу мерить негде
#   speedtest.sh stop  - остановить идущий замер
# Список серверов - файл веб-интерфейса (только чтение), # - комментарии:
#   id|название|страна|url|размер_байт|range|https|медиана_Мбит/с|upload_url
#   строка из 8 полей или пустой upload_url - сервер отдачу не принимает.
# Прием: GET не больше 8 МиБ с начала файла (Range), не дольше 15 с, сервер - с наименьшим
#   временем TCP-соединения; скорость по счетчику приема интерфейса маршрута по умолчанию.
# Передача: POST на upload_url, данные из /dev/urandom на лету, не больше 8 МиБ или 8 с;
#   график - по счетчику передачи интерфейса, итог = отправлено / (время до первого байта
#   ответа - время до начала отправки), по замерам curl.
# https и передача - только через curl веб-интерфейса с проверкой по cacert.pem;
# без curl - прием с первого сервера с http:// через busyboxx wget, передачи нет.

B=/system/bin/busyboxx
[ -x "$B" ] || B=busybox
LIST="${HIJ_SPEED_LIST:-/online/mod/helper/speedtest-servers.txt}"
CURL="${HIJ_CURL:-/online/mod/pkg/dns/bin/curl}"
CACERT="${HIJ_CACERT:-/online/mod/pkg/dns/cacert.pem}"
RUN="${HIJ_SPEED_RUN:-/tmp/hij_speedtest}"
DL_MAX_BYTES=8388608     # 8 МиБ
DL_MAX_SECONDS=15
UP_MAX_BYTES=8388608     # 8 МиБ
UP_MAX_SECONDS=8

stop_test() {
    for f in "$RUN/dl.pid" "$RUN/main.pid"; do
        p=$($B cat "$f" 2>/dev/null)
        [ -n "$p" ] && $B kill "$p" 2>/dev/null
    done
    $B rm -f "$RUN/dl.pid" "$RUN/main.pid"
}

if [ "$1" = stop ]; then
    stop_test
    exit 0
fi

stop_test
$B mkdir -p "$RUN"
echo $$ > "$RUN/main.pid"
trap 'p=$($B cat "$RUN/dl.pid" 2>/dev/null); [ -n "$p" ] && $B kill "$p" 2>/dev/null; $B rm -f "$RUN/dl.pid" "$RUN/main.pid"' EXIT
$B rm -f "$RUN/error" "$RUN/up.w"

# причина ошибки - в $RUN/error (дописывается)
note() { echo "$1" >> "$RUN/error"; }
# замер не удался: итоговая строка с нулем, чтобы виджет не ждал вечно
fail() {
    note "$1"
    echo "{\"type\":\"$2\",\"bandwidth\":0,\"progress\":1.0}"
}

[ -r "$LIST" ] || { fail "нет списка серверов $LIST" download; echo '{"type":"upload","none":1}'; exit 1; }
HAVE_CURL=0
[ -x "$CURL" ] && [ -r "$CACERT" ] && HAVE_CURL=1

# строки списка: url приема и url передачи (пусто - нет)
$B grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$LIST" | $B tr -d '\r' \
    | $B awk -F'|' -v c=$HAVE_CURL '
        $4 ~ /^http:\/\// || (c == 1 && $4 ~ /^https:\/\//) {print $4}' > "$RUN/urls"
if [ "$HAVE_CURL" = 1 ]; then
    $B grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$LIST" | $B tr -d '\r' \
        | $B awk -F'|' '$9 ~ /^https?:\/\// {print $4 "|" $9}' > "$RUN/upurls"
else
    : > "$RUN/upurls"
fi

# время TCP-соединения с адресом, с; пусто - не соединились
connect_time() {
    t=$("$CURL" -s -o /dev/null --cacert "$CACERT" --connect-timeout 3 --max-time 4 \
        $2 -w '%{time_connect}' "$1" 2>/dev/null)
    case "$t" in ''|0|0.000*|*[!0-9.]*) echo "" ;; *) echo "$t" ;; esac
}
# первый ряд с наименьшим временем: best_of ФАЙЛ ПОЛЕ КЛЮЧИ_CURL
best_of() {
    best=""; pick=""
    while IFS='|' read -r a b; do
        [ "$2" = 1 ] && u=$a || u=$b
        t=$(connect_time "$u" "$3")
        [ -n "$t" ] || continue
        if [ -z "$best" ] || $B awk -v x="$t" -v y="$best" 'BEGIN {exit !(x < y)}'; then
            best=$t; pick=$u
        fi
    done < "$1"
    echo "$pick"
}

# интерфейс маршрута по умолчанию
DEV=${HIJ_SPEED_DEV:-$($B awk '$2 == "00000000" {print $1; exit}' /proc/net/route)}
[ -n "$DEV" ] || DEV=$($B ip route show default 2>/dev/null | $B sed -n 's/^default .* dev \([^ ]*\).*/\1/p' | $B head -n 1)
# счетчик интерфейса: поле 1 - принято байт, 9 - передано; без интерфейса - сумма всех, кроме lo
dev_bytes() {
    $B awk -v d="$DEV" -v k="$1" '{sub(/^ */, ""); i = index($0, ":"); n = substr($0, 1, i - 1);
        split(substr($0, i + 1), f, " ")}
        i > 0 && ((d != "" && n == d) || (d == "" && n != "lo")) {s += f[k]} END {print s + 0}' /proc/net/dev
}
# время с загрузки, сотые доли секунды
now_cs() { $B awk '{split($1, t, "."); print t[1] * 100 + t[2]}' /proc/uptime; }

# measure ТИП ПОЛЕ МАКС_БАЙТ МАКС_С PID - строки виджета, пока процесс PID жив
measure() {
    kind=$1; field=$2; maxb=$3; maxs=$4; pid=$5
    start_b=$(dev_bytes $field); start_t=$(now_cs)
    prev_b=$start_b; prev_t=$start_t
    while :; do
        $B usleep 500000
        b=$(dev_bytes $field); t=$(now_cs)
        got=$((b - start_b)); dt=$((t - prev_t)); el=$((t - start_t))
        [ "$dt" -gt 0 ] || dt=1
        bw=$(( (b - prev_b) * 100 / dt ))
        alive=0
        $B kill -0 "$pid" 2>/dev/null && alive=1
        if [ "$alive" = 0 ] || [ "$got" -ge "$maxb" ] || [ "$el" -ge $((maxs * 100)) ]; then
            [ "$alive" = 1 ] && $B kill "$pid" 2>/dev/null
            [ "$el" -gt 0 ] || el=1
            AVG=$((got * 100 / el))
            return 0
        fi
        # доля: по байтам или по времени, что больше
        prog=$($B awk -v g=$got -v m=$maxb -v e=$el -v s=$maxs \
            'BEGIN {p = g / m; q = e / (s * 100); if (q > p) p = q; if (p > 0.99) p = 0.99; printf "%.3f", p}')
        echo "{\"type\":\"$kind\",\"bandwidth\":$bw,\"progress\":$prog}"
        prev_b=$b; prev_t=$t
    done
}

# ---- прием
URL=$($B head -n 1 "$RUN/urls" 2>/dev/null)
if [ -z "$URL" ]; then
    fail "в списке нет годных серверов приема (curl $HAVE_CURL)" download
else
    if [ "$HAVE_CURL" = 1 ]; then
        $B awk '{print $0 "|"}' "$RUN/urls" > "$RUN/dl.list"
        u=$(best_of "$RUN/dl.list" 1 "-r 0-0")
        [ -n "$u" ] && URL=$u
        "$CURL" -s -o /dev/null --cacert "$CACERT" --connect-timeout 5 --max-time "$DL_MAX_SECONDS" \
            -r "0-$((DL_MAX_BYTES - 1))" "$URL" &
    else
        $B timeout -t "$DL_MAX_SECONDS" $B wget -q -O /dev/null "$URL" &
    fi
    DL=$!
    echo $DL > "$RUN/dl.pid"
    echo "$URL" > "$RUN/download.url"
    measure download 1 $DL_MAX_BYTES $DL_MAX_SECONDS $DL
    echo "{\"type\":\"download\",\"bandwidth\":$AVG,\"progress\":1.0}"
fi

# ---- передача
if [ ! -s "$RUN/upurls" ]; then
    [ "$HAVE_CURL" = 1 ] && note "в списке нет серверов передачи" || note "передача только через curl"
    echo '{"type":"upload","none":1}'
    exit 0
fi
# сервер приема, если у него есть upload_url, иначе - самый быстрый по TCP-соединению
UP=$($B awk -F'|' -v u="$URL" '$1 == u {print $2; exit}' "$RUN/upurls")
[ -n "$UP" ] || UP=$(best_of "$RUN/upurls" 2 "-I")
[ -n "$UP" ] || UP=$($B head -n 1 "$RUN/upurls" | $B cut -d'|' -f2)
echo "$UP" > "$RUN/upload.url"

$B head -c "$UP_MAX_BYTES" /dev/urandom | "$CURL" -s -o /dev/null --cacert "$CACERT" \
    --connect-timeout 5 --max-time "$UP_MAX_SECONDS" \
    -w '%{size_upload} %{time_pretransfer} %{time_starttransfer} %{time_total}\n' \
    --data-binary @- "$UP" > "$RUN/up.w" 2>/dev/null &
UPID=$!
echo $UPID > "$RUN/dl.pid"
measure upload 9 $UP_MAX_BYTES $((UP_MAX_SECONDS + 2)) $UPID
wait "$UPID" 2>/dev/null
# итог по замерам curl: отправлено / (первый байт ответа - начало отправки)
BW=$($B awk '{s = $1; d = $3 - $2; if (d <= 0) d = $4; if (s > 0 && d > 0) printf "%d", s / d}' "$RUN/up.w" 2>/dev/null)
[ -n "$BW" ] || { note "curl не сообщил итог передачи, взят счетчик интерфейса"; BW=$AVG; }
echo "{\"type\":\"upload\",\"bandwidth\":$BW,\"progress\":1.0}"
exit 0
