#!/usr/bin/env bash
# Проверки install-all.sh на заглушках: ssh, curl, ip, установщики панели и меню. Роутер не нужен.
# Запуск: packaging/test/test_install_all.sh
# Заглушка ssh ведет журнал команд; FAIL_MATCH=ШАБЛОН - команда с этим шаблоном завершается с кодом 1.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; failn=0
ok() { pass=$((pass + 1)); echo "ok    $1"; }
bad() { failn=$((failn + 1)); echo "FAIL  $1"; [ -n "${2:-}" ] && sed 's/^/      /' <<<"$2"; }

# --- дерево комплекта с заглушками установщиков ---
K=$T/kit; mkdir -p "$K/webui/src/installer" "$K/webui/src/pkg/awg/bin" "$K/webui/src/pkg/dns/bin" \
	"$K/oled-menu/install/files/hijacks/lib" "$K/boot/logo" "$K/tools/logo"
cp "$ROOT/install-all.sh" "$K/"; cp "$ROOT/tools/logo/mklogo.py" "$K/tools/logo/"
cp "$ROOT/webui/src/installer/host-lib.sh" "$K/webui/src/installer/"
for p in awg dns; do echo x > "$K/webui/src/pkg/$p/svc.sh"; echo x > "$K/webui/src/pkg/$p/bin/x"; done
cat > "$K/webui/src/installer/install.sh" <<'S'
#!/bin/bash
echo "panel-install $*" >> "$STATE/log"
case " $* " in *" $PANEL_FAIL "*) echo "Ошибка: заглушка отказала" >&2; exit 1 ;; esac
exit 0
S
cp "$K/webui/src/installer/install.sh" "$K/webui/src/installer/rollback.sh"; chmod +x "$K/webui/src/installer/"*.sh
for f in install.sh rollback.sh mk_oled_cfg.sh; do echo "# $f" > "$K/oled-menu/install/$f"; done
echo so > "$K/oled-menu/install/files/hijacks/lib/oled_hijack.so"
SO=$(md5sum < "$K/oled-menu/install/files/hijacks/lib/oled_hijack.so" | cut -d' ' -f1)
echo "FILE core /app/hijacks/lib/oled_hijack.so $SO 0775 3 меню" > "$K/oled-menu/install/MANIFEST"
python3 -c "from PIL import Image; Image.new('RGB',(128,128),(0,120,200)).save('$K/boot/logo/logo3_A.png')"

# --- заглушки команд ---
BIN=$T/bin; mkdir -p "$BIN"
cat > "$BIN/ip" <<'S'
#!/bin/bash
echo "192.168.1.1 dev ${ROUTE_DEV:-wwx001e101f0000} src 192.168.1.200"
S
cat > "$BIN/curl" <<'S'
#!/bin/bash
echo "curl $*" >> "$STATE/log"
printf '%s' "${HTTP_CODE:-200}"
S
cat > "$BIN/ssh" <<'S'
#!/bin/bash
c=${*: -1}
echo "ssh: ${c//$'\n'/ ; }" >> "$STATE/log"
if [ -n "${FAIL_MATCH:-}" ] && [[ "$c" == *$FAIL_MATCH* ]]; then cat >/dev/null 2>&1 </dev/null; echo "заглушка: отказ" >&2; exit 1; fi
case "$c" in
true) exit 0 ;;
*BOARD=*)
	cat <<P
BB=${P_BB-1}
BOARD=${P_BOARD-hi6932_E5785Lh-23c}
PRODUCT=${P_PRODUCT-E5785Lh-23c}
APPSIZE=${P_APPSIZE-013c0000}
LOGOSIZE=00100000
LOGOIDX=mtd20
REV=${P_REV-21.191.63.02.00}
APPDEV=/dev/block/mtdblock24
OLEDCFG=1
APPFREE=${P_APPFREE-4256}
ONLINEFREE=${P_ONLINEFREE-30000}
SOMD5=old
P
	[ -n "${P_MISSING:-}" ] && echo "MISSING=$P_MISSING"
	exit 0 ;;
*"dd if=/dev/mtd/mtd20"*) cat "$STATE/logo" ;;
*"dd of=/tmp/logo_new.img"*) cat > "$STATE/tmpimg" ;;
*"md5sum /tmp/logo_new.img"*) md5sum < "$STATE/tmpimg" ;;
*"dd if=/tmp/logo_new.img of=/dev/block/mtdblock20"*)
	[ -n "${LOGO_CORRUPT:-}" ] && { head -c 65535 "$STATE/tmpimg" > "$STATE/logo"; printf 'X' >> "$STATE/logo"; exit 0; }
	cp "$STATE/tmpimg" "$STATE/logo" ;;
*"tar -xf -"*) cat >/dev/null ;;
*"mod-ctl.sh status"*) echo "  помощник: ${HELPER_ST-работает: 123, очередь отвечает (5 с)}" ;;
*"svc.sh brief"*) echo "running=1|profile=p|label=l|handshake=4|engine=kernel" ;;
*"md5sum /app/hijacks/lib/oled_hijack.so"*) echo "${AFTER_MD5-$SO_MD5}  /app/hijacks/lib/oled_hijack.so" ;;
esac
exit 0
S
chmod +x "$BIN/"*

fresh() { STATE=$T/st; rm -rf "$STATE"; mkdir -p "$STATE"; head -c 65536 /dev/zero | tr '\0' 'L' > "$STATE/logo"; : > "$STATE/log"; }
run() { # run ОКРУЖЕНИЕ... -- КЛЮЧИ...
	local e=(); while [ "$1" != -- ]; do e+=("$1"); shift; done; shift
	OUT=$(cd "$T" && env PATH="$BIN:$PATH" STATE="$STATE" SO_MD5="$SO" PANEL_FAIL=__none__ E5785_REBOOT_PAUSE=0 E5785_REBOOT_STEP=0 \
		ROUTER_KNOWN_HOSTS=/dev/null MOD_LOCK_HELD=1 "${e[@]}" bash "$K/install-all.sh" "$@" 2>&1 </dev/null); RC=$?
}
writes() { grep -cE 'tar -xf|rm -rf /online|install.sh|dd of=|mtdblock20|reboot' "$STATE/log"; }

# успех: по умолчанию панель и меню
fresh; run -- ; { [ $RC = 0 ] && grep -q 'panel-install.*--only=web,api' "$STATE/log" && grep -q 'pkg-only=awg' "$STATE/log" && grep -q 'pkg-only=dns' "$STATE/log" && grep -q 'SMS=1 /system/bin/busyboxx sh install.sh' "$STATE/log" && ! grep -q mtdblock20 "$STATE/log" && grep -q 'Нужна перезагрузка' <<<"$OUT" && grep -q 'rollback.sh' <<<"$OUT" && ! grep -q 'reboot -f.*&$' "$STATE/log"; } && ok "успех: панель и меню, логотипа нет, перезагрузки нет, откат напечатан" || bad "успех" "$OUT"
# порядок: панель раньше меню, DRY=1 раньше установки
fresh; run -- ; a=$(grep -n 'panel-install' "$STATE/log" | head -1 | cut -d: -f1); m=$(grep -n 'tar -xf' "$STATE/log" | head -1 | cut -d: -f1); d=$(grep -n 'DRY=1' "$STATE/log" | cut -d: -f1); i=$(grep -n '&& SMS=1 /system/bin/busyboxx sh install.sh' "$STATE/log" | cut -d: -f1); { [ "$a" -lt "$m" ] && [ "$d" -lt "$i" ]; } && ok "порядок: панель, меню, DRY=1 до установки" || bad "порядок" "$(cat "$STATE/log")"
# --dry-run: нет записи на флеш
fresh; run -- --dry-run; { [ $RC = 0 ] && grep -q 'panel-install --dry-run' "$STATE/log" && ! grep -q 'panel-install --host' "$STATE/log" && ! grep -qE '/online/hij_install|cd /online|mtdblock20' "$STATE/log" && grep -q '/tmp/hij_install_dry' "$STATE/log" && grep -q 'rm -rf /tmp/hij_install_dry$' "$STATE/log" && ! grep -qE 'sh install.sh$' <(grep -v 'DRY=1' "$STATE/log"); } && ok "--dry-run: на флеш ничего, временный каталог убран" || bad "--dry-run" "$OUT
$(cat "$STATE/log")"
fresh; run -- --dry-run --logo; { [ $RC = 0 ] && ! grep -q 'mtdblock20' "$STATE/log" && ! grep -q 'logo_new' "$STATE/log" && [ -z "$(ls "$T"/logo-backup-* 2>/dev/null)" ]; } && ok "--dry-run --logo: только чтение раздела" || bad "--dry-run --logo" "$OUT"
# не тот роутер и другие отказы проверок: ни одной записи
for c in "P_BOARD=hi6932_E5785Lh-22c|это не E5785Lh-23c" "P_BOARD=|не сообщил имя платы" "P_APPSIZE=011c0000|таблица разделов другой модели" "P_PRODUCT=|docs/nv-fix.md" "P_REV=21.191.67.00.00|нужна 21.191.63.02" "P_BB=|это не мод bay v5" "P_MISSING=/system/xbin/atc|нет файлов мода" "P_ONLINEFREE=100|мало места в /online" "P_APPFREE=0|мало места в /app" "ROUTE_DEV=wlp2s0|маршрут к" "FAIL_MATCH=true|SSH до"; do
	e=${c%%|*}; m=${c#*|}; fresh; run "$e" -- ; n=$(writes); { [ $RC = 1 ] && [ "$n" = 0 ] && grep -q "$m" <<<"$OUT"; } && ok "отказ до записи: $e" || bad "отказ до записи: $e (код $RC, записей $n)" "$OUT"
done
# отказ на каждом шаге: остановка, дальше ничего
fresh; run PANEL_FAIL=--only=web,api -- ; { [ $RC = 1 ] && ! grep -q 'tar -xf' "$STATE/log" && ! grep -q 'pkg-only' "$STATE/log"; } && ok "отказ панели web,api: меню не начато" || bad "отказ панели web,api" "$OUT"
fresh; run PANEL_FAIL=--pkg-only=dns -- ; { [ $RC = 1 ] && ! grep -q 'tar -xf' "$STATE/log" && grep -q 'rollback.sh' <<<"$OUT"; } && ok "отказ пакета: меню не начато, откат панели напечатан" || bad "отказ пакета" "$OUT"
fresh; run "FAIL_MATCH=tar -xf" -- ; { [ $RC = 1 ] && ! grep -q 'mk_oled_cfg' "$STATE/log"; } && ok "отказ копирования набора: mk_oled_cfg не запущен" || bad "отказ копирования" "$OUT"
fresh; run FAIL_MATCH=mk_oled_cfg -- ; { [ $RC = 1 ] && ! grep -q 'DRY=1' "$STATE/log"; } && ok "отказ mk_oled_cfg: install.sh не запущен" || bad "отказ mk_oled_cfg" "$OUT"
fresh; run FAIL_MATCH=DRY=1 -- ; { [ $RC = 1 ] && ! grep -q '&& SMS=1 /system/bin/busyboxx sh install.sh' "$STATE/log"; } && ok "отказ DRY=1: установка не начата" || bad "отказ DRY=1" "$OUT"
fresh; run "FAIL_MATCH=&& SMS=1" -- ; { [ $RC = 1 ] && grep -q 'rollback.sh' <<<"$OUT"; } && ok "отказ install.sh меню: остановка, откат напечатан" || bad "отказ install.sh меню" "$OUT"
fresh; run HTTP_CODE=000 -- ; { [ $RC = 1 ] && grep -q 'проверка после установки не прошла' <<<"$OUT"; } && ok "итоговая проверка: панель не отвечает" || bad "проверка панели" "$OUT"
fresh; run HELPER_ST=молчит -- ; { [ $RC = 1 ] && grep -q 'помощник: не отвечает' <<<"$OUT"; } && ok "итоговая проверка: помощник молчит" || bad "проверка помощника" "$OUT"
fresh; run AFTER_MD5=abc -- ; { [ $RC = 1 ] && grep -q 'совпадает с MANIFEST\|в MANIFEST' <<<"$OUT"; } && ok "итоговая проверка: другой файл меню" || bad "проверка меню" "$OUT"
# логотип
rm -f "$T"/logo-backup-*
fresh; run -- --logo; { [ $RC = 1 ] && ! grep -q mtdblock20 "$STATE/log" && grep -q 'запись логотипа отменена' <<<"$OUT"; } && ok "логотип без подтверждения: запись отменена" || bad "логотип без подтверждения" "$OUT"
fresh; run -- --logo --yes --panel; { [ $RC = 0 ] && grep -q mtdblock20 "$STATE/log" && [ "$(wc -c < "$STATE/logo")" = 65536 ] && [ "$(head -c 32768 "$STATE/logo" | tr -d L | wc -c)" = 0 ] && [ -n "$(ls "$T"/logo-backup-* 2>/dev/null)" ] && ! grep -q 'tar -xf' "$STATE/log"; } && ok "логотип с --yes: слот [0] цел, копия есть, сверка прошла, меню не ставилось" || bad "логотип с --yes" "$OUT"
rm -f "$T"/logo-backup-*
fresh; run LOGO_CORRUPT=1 -- --logo --yes --panel; { [ $RC = 1 ] && grep -q 'не совпал с образом' <<<"$OUT" && grep -q 'logo_old.img' <<<"$OUT"; } && ok "логотип: сверка ловит порчу, откат напечатан" || bad "логотип, порча" "$OUT"
rm -f "$T"/logo-backup-*
fresh; run "FAIL_MATCH=of=/dev/block/mtdblock20" -- --logo --yes --panel; { [ $RC = 1 ] && grep -q 'запись в mtdblock20 не прошла' <<<"$OUT"; } && ok "логотип: отказ записи" || bad "логотип, отказ записи" "$OUT"
rm -f "$T"/logo-backup-*
# части и перезагрузка
fresh; run -- --menu; { [ $RC = 0 ] && ! grep -q panel-install "$STATE/log" && grep -q 'tar -xf' "$STATE/log"; } && ok "--menu: панель не трогается" || bad "--menu" "$OUT"
fresh; run -- --panel --no-sms; { [ $RC = 0 ] && ! grep -q 'tar -xf' "$STATE/log"; } && ok "--panel: меню не трогается" || bad "--panel" "$OUT"
fresh; run -- --menu --no-sms; { [ $RC = 0 ] && ! grep -q 'SMS=1' "$STATE/log"; } && ok "--no-sms" || bad "--no-sms" "$OUT"
fresh; run -- --reboot; { [ $RC = 0 ] && grep -q 'reboot -f' "$STATE/log" && [ "$(grep -c 'mod-ctl.sh status' "$STATE/log")" = 2 ]; } && ok "--reboot: перезагрузка и повторная проверка" || bad "--reboot" "$OUT"
fresh; run -- --bad-key; [ $RC = 2 ] && ok "неверный ключ: код 2" || bad "неверный ключ" "$OUT"
# нет бинарников панели
mv "$K/webui/src/pkg/awg/bin" "$K/webui/src/pkg/awg/bin.x"; mv "$K/webui/src/pkg/dns/bin" "$K/webui/src/pkg/dns/bin.x"
fresh; run -- ; { [ $RC = 1 ] && grep -q 'get-bins.sh' <<<"$OUT" && ! grep -q ssh "$STATE/log"; } && ok "нет бинарников: остановка до обращения к роутеру" || bad "нет бинарников" "$OUT"
mv "$K/webui/src/pkg/awg/bin.x" "$K/webui/src/pkg/awg/bin"; mv "$K/webui/src/pkg/dns/bin.x" "$K/webui/src/pkg/dns/bin"
# испорченный файл набора
echo y >> "$K/oled-menu/install/files/hijacks/lib/oled_hijack.so"
fresh; run -- --menu; { [ $RC = 1 ] && grep -q 'не совпадает с MANIFEST' <<<"$OUT" && ! grep -q ssh "$STATE/log"; } && ok "испорченный набор: остановка до обращения к роутеру" || bad "испорченный набор" "$OUT"

echo ""; echo "пройдено $pass, ошибок $failn"; [ "$failn" = 0 ]
