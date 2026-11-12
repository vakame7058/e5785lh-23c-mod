#!/system/bin/busyboxx sh
# Быстрая проверка SMS/USSD после установки SMS=1 и перезагрузки роутера.
# Запуск от root из каталога набора: busyboxx sh check_sms.sh
# Ничего не меняет: только читает файлы и процессы, спрашивает счетчик SMS
# у хука (sms_webhook_client) и у веб-интерфейса (GET /api/sms/sms-count).
# В конце - итог и команда отката SMS.

BB="${HIJ_B:-/system/bin/busyboxx}"
HERE=$(cd "$($BB dirname "$0")" && pwd)
MAN="$HERE/MANIFEST"
CLIENT=/app/hijacks/bin/sms_webhook_client
SOCK=/var/sms_webhook
CURL="${HIJ_CURL:-/online/mod/pkg/dns/bin/curl}"
OUT=/tmp/check_sms.out

FAIL=0
ok()   { echo "  ок      $*"; }
bad()  { echo "  ОШИБКА  $*"; FAIL=$((FAIL + 1)); }
note() { echo "  -       $*"; }
md5() { $BB md5sum "$1" 2>/dev/null | $BB cut -d' ' -f1; }

# команда не дольше 10 с: KILL, а не TERM - программы ATP перехватывают TERM.
# Вывод - в файл $OUT, а не через $(...): иначе ждали бы, пока закроют канал
# оставшиеся дети убитой команды (у sms_webhook_client свой alarm 60 с).
# busybox 1.21 роутера: timeout -t СЕК; новый busybox: timeout СЕК
if $BB timeout -t 1 -s KILL true 2>/dev/null; then TMO="$BB timeout -t 10 -s KILL"
elif $BB timeout -s KILL 1 true 2>/dev/null; then TMO="$BB timeout -s KILL 10"
else TMO=""; fi
tmo() { $TMO "$@" > "$OUT" 2>&1 < /dev/null; }
tmo_in() { $TMO "$@" > "$OUT" 2>&1; }
[ -n "$TMO" ] || note "в $BB нет timeout -t -s: шаги без ограничения по времени"

echo "1. Файлы компонента SMS"
if [ -f "$MAN" ]; then
    $BB grep '^FILE sms ' "$MAN" > /tmp/check_sms.files
    while read -r kind comp dst sum rest; do
        if [ "$(md5 "$dst")" = "$sum" ]; then ok "$dst"; else bad "$dst: md5 $(md5 "$dst"), ждали $sum"; fi
    done < /tmp/check_sms.files
    $BB rm -f /tmp/check_sms.files
else
    note "нет MANIFEST рядом - md5 не сверяю"
fi
[ -f /app/bin/sms.orig ] && ok "/app/bin/sms.orig на месте" || bad "нет /app/bin/sms.orig"
$BB grep -q sms_webhook.so /app/bin/sms 2>/dev/null && ok "/app/bin/sms - обертка с хуком" || bad "/app/bin/sms - не обертка"

echo "2. Процесс sms"
PID=""
for p in $($BB ls /proc | $BB grep -E '^[0-9]+$'); do
    case "$($BB readlink /proc/$p/exe 2>/dev/null)" in
        /app/bin/sms.orig) PID=$p; break ;;
    esac
done
if [ -n "$PID" ]; then
    ok "sms.orig работает, pid $PID"
    $BB grep -q sms_webhook.so /proc/$PID/maps && ok "в нем загружен sms_webhook.so" || bad "sms_webhook.so в процессе не загружен"
else
    bad "процесса /app/bin/sms.orig нет (SMS в веб-интерфейсе работать не будут)"
fi
[ -S "$SOCK" ] && ok "сокет $SOCK есть" || bad "нет сокета $SOCK"

echo "3. Счетчик SMS через хук"
tmo "$CLIENT" sms sms-count 1 0
ANS=$($BB cat "$OUT")
IN=$(echo "$ANS" | $BB sed -n 's:.*<LocalInbox>\([0-9]*\)</LocalInbox>.*:\1:p' | $BB head -n 1)
UN=$(echo "$ANS" | $BB sed -n 's:.*<LocalUnread>\([0-9]*\)</LocalUnread>.*:\1:p' | $BB head -n 1)
if [ -n "$IN" ]; then
    ok "входящих $IN, непрочитанных ${UN:-?}"
else
    bad "хук не ответил: $(echo "$ANS" | $BB head -n 1)"
fi

echo "4. Счетчик SMS через веб-интерфейс"
# адрес веб-интерфейса - адрес роутера в домашней сети (br0), не 127.0.0.1
LAN=$($BB ip -4 addr show br0 2>/dev/null | $BB sed -n 's/.*inet \([0-9.]*\).*/\1/p' | $BB head -n 1)
WEB="${HIJ_WEB:-http://${LAN:-192.168.1.1}}"
if [ -x "$CURL" ]; then
    TI=$($CURL -s --connect-timeout 3 -m 5 "$WEB/api/webserver/SesTokInfo" 2>/dev/null)
    SES=$(echo "$TI" | $BB sed -n 's:.*<SesInfo>\(.*\)</SesInfo>.*:\1:p')
    TOK=$(echo "$TI" | $BB sed -n 's:.*<TokInfo>\(.*\)</TokInfo>.*:\1:p')
    R=$($CURL -s --connect-timeout 3 -m 5 -H "Cookie: $SES" -H "__RequestVerificationToken: $TOK" "$WEB/api/sms/sms-count" 2>/dev/null)
    RC=$?
    WIN=$(echo "$R" | $BB sed -n 's:.*<LocalInbox>\([0-9]*\)</LocalInbox>.*:\1:p' | $BB head -n 1)
    CODE=$(echo "$R" | $BB sed -n 's:.*<code>\([0-9]*\)</code>.*:\1:p' | $BB head -n 1)
    if [ -n "$WIN" ]; then
        ok "веб-интерфейс: входящих $WIN"
    elif [ "$CODE" = 125002 ] || [ "$CODE" = 100003 ]; then
        note "веб-интерфейс просит вход (код $CODE): откройте SMS в браузере"
    elif [ -n "$R" ]; then
        bad "веб-интерфейс ответил: $(echo "$R" | $BB tr -d '\r\n' | $BB head -c 120)"
    else
        bad "веб-интерфейс не ответил на $WEB (код curl $RC)"
    fi
else
    note "нет $CURL - проверьте SMS в браузере"
fi

echo "5. Пункт меню «SMS и USSD»"
for f in /app/hijacks/bin/luarun /app/hijacks/bin/hijlua "$CLIENT" /app/hijacks/scripts/sms_and_ussd.sh; do
    [ -e "$f" ] || bad "нет $f (пункт будет скрыт)"
done
# luarun: только загрузка модуля dm, без запросов
echo 'local dm = require("dm"); print("dm ok")' | tmo_in /app/hijacks/bin/luarun
L=$($BB cat "$OUT")
case "$L" in *"dm ok"*) ok "luarun запускается, модуль dm есть" ;; *) bad "luarun: $(echo "$L" | $BB head -n 1)" ;; esac
# главный экран пункта (только счетчики; список SMS не открываю - он отмечает SMS прочитанными)
HIJ_LANG=ru tmo /system/bin/sh /app/hijacks/scripts/sms_and_ussd.sh
M=$($BB cat "$OUT")
if echo "$M" | $BB grep -qE '^item:.*\([0-9]+\)'; then
    ok "меню открывается, счетчики есть: $(echo "$M" | $BB grep '^item:' | $BB cut -d: -f2 | $BB tr '\n' ' ')"
else
    bad "меню без счетчиков SMS: $(echo "$M" | $BB grep -v '^text:' | $BB head -n 2 | $BB tr '\n' ' ')"
fi

echo
BK=""
for d in $($BB ls -d /online/hijacks_backup_* 2>/dev/null | $BB sort -r); do
    $BB grep -q '^MOVED /app/bin/sms ' "$d/STATE" 2>/dev/null && { BK=$d; break; }
done
if [ "$FAIL" = 0 ]; then
    echo "ИТОГ: SMS и USSD работают"
else
    echo "ИТОГ: ошибок $FAIL"
fi
if [ -n "$BK" ]; then
    echo "Откат SMS: busyboxx sh $HERE/rollback.sh $BK  (затем перезагрузка)"
else
    echo "Откат SMS: бэкап с переименованием /app/bin/sms не найден в /online/hijacks_backup_*"
fi
$BB rm -f "$OUT"
[ "$FAIL" = 0 ]
