#!/system/bin/busyboxx sh
# Помощник веб-панели (root): очередь запросов qd в /var/modq, обработчик www/cgi-bin/h, сторож wd.
#
#   start.sh boot        при загрузке роутера: помощник и сторож, через 60 с — VPN, номер SIM
#                        и скрипты с автозапуском
#   start.sh start       запустить помощник и сторож, если не запущены
#   start.sh stop        остановить сторож и помощник
#   start.sh restart     перезапустить
#   start.sh status      код 0 — очередь отвечает, 1 — не запущен, 3 — процесс есть, но не отвечает
#   start.sh probe       пробный запрос через очередь (код 0 — ответ получен)
#   start.sh tick        для сторожа: убрать устаревшие PID-файлы и сделать probe
#   start.sh restart-qd  для сторожа: перезапустить только qd
#
# Файлы: /online/mod/helper/{start.sh,qd,hc,wd,www/cgi-bin/h,secret,autorun.list,modem_write,nv_write}
# Журнал: /var/log/modhelper.log (в ОЗУ, не больше 64 КБ + .1)

B=/system/bin/busyboxx
H=/online/mod/helper
RUN=/var/modhelper
Q=/var/modq
LOG=/var/log/modhelper.log
SLOG=/var/log/modscripts.log

export PATH=/system/bin:/system/xbin:/app/bin:/sbin:/bin
umask 022

log() { echo "$($B date '+%m-%d %H:%M:%S') start.sh $*" >> "$LOG"; }

# is_proc PID ИМЯ — процесс "sh /online/mod/helper/ИМЯ"
is_proc() {
    local line
    [ -r "/proc/$1/cmdline" ] || return 1
    line=$($B tr '\0' ' ' < "/proc/$1/cmdline")
    case "$line" in *"sh $H/$2"*) return 0 ;; esac
    return 1
}

# proc_pid ИМЯ — PID по файлу $RUN/ИМЯ.pid, иначе поиск по /proc
proc_pid() {
    local p d
    p=$($B cat "$RUN/$1.pid" 2>/dev/null)
    case "$p" in
        ''|*[!0-9]*) ;;
        *) is_proc "$p" "$1" && { echo "$p"; return 0; } ;;
    esac
    for d in /proc/[0-9]*; do
        p=${d#/proc/}
        is_proc "$p" "$1" && { echo "$p" > "$RUN/$1.pid" 2>/dev/null; echo "$p"; return 0; }
    done
    return 1
}

helper_pid() { proc_pid qd; }

make_secret() {
    if [ ! -s "$H/secret" ]; then
        $B head -c 24 /dev/urandom | $B od -v -An -tx1 | $B tr -d ' \n' > "$H/secret.tmp"
        echo >> "$H/secret.tmp"
        $B mv -f "$H/secret.tmp" "$H/secret"
    fi
    $B chown 0:1000 "$H/secret"
    $B chmod 640 "$H/secret"
}

# пробный запрос helper.show через очередь, как от веба
do_probe() {
    local id out
    [ -p "$Q/in" ] || return 1
    id=p$$_$($B date +%s)
    { echo "a=helper.show"; $B cat "$H/secret"; } > "$Q/$id.req" 2>/dev/null || return 1
    out=$($B sh "$H/hc" "$id" 10 2>/dev/null)
    $B rm -f "$Q/$id.req"
    case "$out" in *"S 0"*) return 0 ;; esac
    return 1
}

# PID-файлы помощника, процесс которых уже завершился
clean_pids() {
    local pf p
    for pf in "$RUN"/*.pid; do
        [ -f "$pf" ] || continue
        p=$($B head -n 1 "$pf" 2>/dev/null)
        case "$p" in ''|*[!0-9]*) $B rm -f "$pf"; continue ;; esac
        [ -d "/proc/$p" ] || { $B rm -f "$pf"; log "убран устаревший ${pf##*/}"; }
    done
}

start_qd() {
    $B setsid $B sh "$H/qd" < /dev/null > /dev/null 2>&1 &
    echo $! > "$RUN/qd.pid"
    $B sleep 1
    helper_pid > /dev/null
}

start_wd() {
    proc_pid wd > /dev/null && return 0
    $B setsid $B sh "$H/wd" < /dev/null > /dev/null 2>&1 &
    echo $! > "$RUN/wd.pid"
}

do_start() {
    $B mkdir -p "$RUN" /var/log
    $B chmod 700 "$RUN"
    if helper_pid > /dev/null; then
        start_wd
        echo "уже запущен: $(helper_pid)"
        return 0
    fi
    $B rm -rf "$RUN"/r.*
    clean_pids
    make_secret
    $B chmod 755 "$H/www/cgi-bin/h" "$H/qd" "$H/hc" "$H/wd"
    $B cut -d. -f1 /proc/uptime > "$RUN/started"
    if start_qd; then
        start_wd
        log "запущен, pid $(helper_pid), сторож $(proc_pid wd)"
        echo "запущен: $(helper_pid)"
        return 0
    fi
    log "не запустился"
    echo "не запустился" >&2
    return 1
}

stop_one() {
    local p i=0
    p=$(proc_pid "$1") || return 0
    kill "$p"
    while [ -d "/proc/$p" ] && [ $i -lt 5 ]; do $B sleep 1; i=$((i + 1)); done
    [ -d "/proc/$p" ] && kill -9 "$p"
    $B rm -f "$RUN/$1.pid"
    echo "$p"
}

do_stop() {
    local w p
    w=$(stop_one wd)
    p=$(stop_one qd)
    $B rm -f "$Q/in"
    if [ -n "$p" ]; then
        log "остановлен, pid $p${w:+, сторож $w}"
        echo "остановлен: $p"
    else
        echo "не запущен"
    fi
}

do_restart_qd() {
    local p
    p=$(stop_one qd)
    $B rm -f "$Q/in"
    if start_qd; then
        log "qd перезапущен: было ${p:-нет}, стало $(helper_pid)"
        echo "qd перезапущен: $(helper_pid)"
        return 0
    fi
    log "qd не запустился"
    return 1
}

do_status() {
    local p w
    clean_pids
    w=$(proc_pid wd) && w="сторож $w" || w="сторожа нет"
    if ! p=$(helper_pid); then
        echo "не запущен ($w)"
        return 1
    fi
    if do_probe; then
        echo "работает: $p, очередь отвечает ($w)"
        return 0
    fi
    echo "процесс $p есть, но очередь не отвечает ($w)"
    return 3
}

# вызов действия помощника напрямую, без очереди
call_h() {
    local q=$1
    printf '%s\n' "$($B cat "$H/secret")" > "$RUN/boot.body"
    REQUEST_METHOD=POST REMOTE_ADDR=127.0.0.1 QUERY_STRING="$q" \
        CONTENT_LENGTH=$($B wc -c < "$RUN/boot.body") \
        $B sh "$H/www/cgi-bin/h" < "$RUN/boot.body"
    $B rm -f "$RUN/boot.body"
}

boot_tasks() {
    local n
    [ -f /online/mod/vpn/wg.autostart ] && { log "автозапуск WireGuard"; call_h "a=vpn.start&type=wg" > /dev/null 2>&1; }
    [ -f /online/mod/vpn/ovpn.autostart ] && { log "автозапуск OpenVPN"; call_h "a=vpn.start&type=ovpn" > /dev/null 2>&1; }
    # номер SIM: в фоне ждет домашнюю сеть до 10 мин; USSD — только если номера нет (см. h, msisdn)
    call_h "a=msisdn.auto" > /dev/null 2>&1
    [ -f "$H/autorun.list" ] || return 0
    while read -r n; do
        case "$n" in ''|.*|*[!A-Za-z0-9_.-]*) continue ;; esac
        [ -f "/online/scripts/$n" ] || continue
        log "автозапуск скрипта $n"
        echo "== $($B date '+%m-%d %H:%M:%S') автозапуск $n" >> "$SLOG"
        [ -x "/online/scripts/$n" ] || $B chmod 755 "/online/scripts/$n"
        ( cd /online/scripts && $B setsid "./$n" < /dev/null >> "$SLOG" 2>&1 & )
    done < "$H/autorun.list"
}

case "$1" in
    boot)
        do_start
        ( $B sleep 60; boot_tasks ) < /dev/null > /dev/null 2>&1 &
        ;;
    start) do_start ;;
    stop) do_stop ;;
    restart) do_stop; $B sleep 1; do_start ;;
    status) do_status; exit $? ;;
    probe) do_probe; exit $? ;;
    tick) clean_pids; do_probe; exit $? ;;
    restart-qd) do_restart_qd; exit $? ;;
    *)
        echo "использование: $0 boot|start|stop|restart|status|probe|tick|restart-qd" >&2
        exit 2
        ;;
esac
