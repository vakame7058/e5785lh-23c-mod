#!/usr/bin/env bash
# Установка комплекта одной командой: веб-панель, меню экрана, логотип.
# Запуск на компьютере, из любого каталога. На роутере уже должен стоять мод bay v5
# на прошивке 21.191.63.02. Прошивку, NV и загрузчики скрипт не трогает: см. docs/recovery.md, docs/nv-fix.md.
#
#   install-all.sh [--dry-run] [--panel] [--menu] [--logo] [ключи]
#
# --panel            веб-панель (без ключей частей: панель и меню)
# --menu             меню экрана
# --logo             логотип; только по этому ключу и с подтверждением
# --dry-run          показать план и ответы установщиков, ничего не менять на флеше
# --reboot           перезагрузить роутер в конце и повторить проверку
# --pkgs=СПИСОК      пакеты панели через запятую, по умолчанию все, у которых есть bin
# --no-sms           меню без компонента SMS и USSD
# --logo-image=ФАЙЛ  свой PNG 128x128 вместо boot/logo/logo3_A.png
# --yes              не спрашивать подтверждение логотипа
# --host=АДРЕС       адрес роутера, по умолчанию 192.168.1.1
# --iface=ИМЯ        интерфейс компьютера к роутеру, по умолчанию wwx001e101f0000
#
# Ключ SSH и файл ключей хостов: переменные ROUTER_KEY и ROUTER_KNOWN_HOSTS.
# Коды выхода: 0 - успех, 1 - отказ проверки или шага, 2 - неверный ключ.

set -uo pipefail

ROOT=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
WEBUI=$ROOT/webui
MENU=$ROOT/oled-menu/install
LOGO_TOOL=$ROOT/tools/logo/mklogo.py
LOGO_PNG=$ROOT/boot/logo/logo3_A.png
BB=/system/bin/busyboxx
SET_DIR=/online/hij_install
DRY_DIR=/tmp/hij_install_dry

DRY=0; REBOOT=0; PANEL=0; MENUPART=0; LOGO=0; SMS=1; YES=0; PKGS=""; EXPLICIT=0
for a in "$@"; do
	case "$a" in
	--dry-run) DRY=1 ;;
	--reboot) REBOOT=1 ;;
	--panel) PANEL=1; EXPLICIT=1 ;;
	--menu) MENUPART=1; EXPLICIT=1 ;;
	--logo) LOGO=1; EXPLICIT=1 ;;
	--no-sms) SMS=0 ;;
	--yes) YES=1 ;;
	--pkgs=*) PKGS=${a#--pkgs=} ;;
	--logo-image=*) LOGO_PNG=${a#--logo-image=} ;;
	--host=*) ROUTER_HOST=${a#--host=} ;;
	--iface=*) ROUTER_IFACE=${a#--iface=} ;;
	-h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) echo "Неизвестный ключ: $a. Список ключей: install-all.sh --help" >&2; exit 2 ;;
	esac
done
[ "$EXPLICIT" = 1 ] || { PANEL=1; MENUPART=1; }

DONE_PARTS=""
LOGO_BACKUP=""
stop() {   # stop ЧТО_СЛУЧИЛОСЬ [ЧТО_ДЕЛАТЬ]
	echo "" >&2
	echo "ОСТАНОВКА: $1" >&2
	[ -n "${2:-}" ] && echo "Что делать: $2" >&2
	[ -n "$DONE_PARTS" ] && print_rollback >&2
	exit 1
}

print_rollback() {
	echo ""
	echo "Откат того, что уже поставлено:"
	case " $DONE_PARTS " in *" panel "*) echo "  панель: $WEBUI/src/installer/rollback.sh        (--last - только последняя установка)" ;; esac
	case " $DONE_PARTS " in *" menu "*) echo "  меню:   ssh root@$ROUTER_HOST 'busyboxx sh $SET_DIR/rollback.sh'   и перезагрузка" ;; esac
	case " $DONE_PARTS " in *" logo "*)
		echo "  логотип: ssh root@$ROUTER_HOST 'busyboxx dd of=/tmp/logo_old.img' < $LOGO_BACKUP"
		echo "           ssh root@$ROUTER_HOST 'busyboxx dd if=/tmp/logo_old.img of=/dev/block/mtdblock20 bs=65536 count=1 conv=notrunc; busyboxx sync'" ;;
	esac
}

title() { echo ""; echo "=== $*"; }

# --- 1. Проверки на компьютере: роутера не касаются ---
title "Проверка файлов на компьютере"
for c in bash ssh tar curl ip md5sum; do
	command -v "$c" >/dev/null || stop "нет программы $c" "поставьте ее и запустите снова"
done

if [ "$PANEL" = 1 ] || [ "$MENUPART" = 1 ] || [ "$LOGO" = 1 ]; then
	[ -f "$WEBUI/src/installer/host-lib.sh" ] || stop "нет $WEBUI/src/installer/host-lib.sh" "распакуйте комплект целиком"
	# проверка маршрута и настройки SSH те же, что у установщика панели
	. "$WEBUI/src/installer/host-lib.sh"
fi

ALLPKGS=""
if [ "$PANEL" = 1 ]; then
	[ -x "$WEBUI/src/installer/install.sh" ] || stop "нет $WEBUI/src/installer/install.sh" "распакуйте комплект целиком"
	command -v python3 >/dev/null || stop "нет python3: он собирает страницы панели" "поставьте python3"
	for d in "$WEBUI"/src/pkg/*/; do
		[ -f "$d/svc.sh" ] || continue
		n=$(basename "$d")
		[ -n "$(ls -A "$d/bin" 2>/dev/null)" ] && ALLPKGS="$ALLPKGS $n"
	done
	if [ -n "$PKGS" ]; then
		for n in ${PKGS//,/ }; do
			case " $ALLPKGS " in *" $n "*) ;; *) stop "у пакета $n нет файлов в src/pkg/$n/bin" "выполните $WEBUI/src/pkg/get-bins.sh --only=$n" ;; esac
		done
		ALLPKGS=" ${PKGS//,/ }"
	fi
	[ -n "$ALLPKGS" ] || stop "нет бинарников пакетов панели в src/pkg/*/bin" "выполните $WEBUI/src/pkg/get-bins.sh (берет файлы из prebuilt/ и сверяет sha256), для модуля ядра добавьте --module"
fi

if [ "$MENUPART" = 1 ]; then
	for f in MANIFEST install.sh rollback.sh mk_oled_cfg.sh; do
		[ -f "$MENU/$f" ] || stop "нет $MENU/$f" "распакуйте комплект целиком"
	done
	while read -r kind comp dst sum rest; do
		[ "$kind" = FILE ] || continue
		case "$comp" in core|debug) ;; sms) [ "$SMS" = 1 ] || continue ;; *) continue ;; esac
		case "$dst" in /app/hijacks/oled_cfg/*) continue ;; esac   # их готовит mk_oled_cfg.sh на роутере
		f=$MENU/files/${dst#/app/}
		[ -f "$f" ] || stop "нет файла набора $f" "распакуйте комплект целиком"
		[ "$(md5sum < "$f" | cut -d' ' -f1)" = "$sum" ] || stop "файл набора $f не совпадает с MANIFEST" "распакуйте комплект заново"
	done < "$MENU/MANIFEST"
fi

if [ "$LOGO" = 1 ]; then
	[ -f "$LOGO_PNG" ] || stop "нет картинки $LOGO_PNG" "укажите PNG 128x128 ключом --logo-image"
	[ -f "$LOGO_TOOL" ] || stop "нет $LOGO_TOOL" "распакуйте комплект целиком"
	python3 -c 'import PIL' 2>/dev/null || stop "нет Pillow: он нужен для образа логотипа" "поставьте python3-pil"
fi
echo "  файлы на месте"

# Лок общий с установщиком панели: при MOD_LOCK_HELD=1 он его не берет
if [ "${MOD_LOCK_HELD:-0}" != 1 ]; then
	exec 9>/tmp/e5785.lock
	flock -n 9 || stop "занят лок /tmp/e5785.lock: идет другая работа с роутером" "дождитесь ее конца"
	export MOD_LOCK_HELD=1
fi

# --- 2. Проверки на роутере: только чтение ---
title "Проверка роутера (только чтение)"
check_route
ERR=$("${SSH[@]}" true 2>&1) || stop "SSH до $ROUTER_HOST не прошел: $ERR" "настройте вход: docs/install-all.md, раздел «Что нужно»; ключ передается через ROUTER_KEY, файл ключей хостов через ROUTER_KNOWN_HOSTS"

PROBE=$("${SSH[@]}" "B=$BB
echo BB=\$([ -x \$B ] && echo 1)
echo BOARD=\$(\$B tr -d '\\000' < /proc/device-tree/board_info/hisi,boardname 2>/dev/null)
echo PRODUCT=\$(cat /proc/productname 2>/dev/null)
echo APPSIZE=\$(\$B awk '\$4 == \"\\\"app\\\"\" {print \$2}' /proc/mtd)
echo LOGOSIZE=\$(\$B awk '\$4 == \"\\\"logo\\\"\" {print \$2}' /proc/mtd)
echo LOGOIDX=\$(\$B awk '\$4 == \"\\\"logo\\\"\" {sub(/:/,\"\",\$1); print \$1}' /proc/mtd)
echo REV=\$(/system/xbin/atc ATI 2>/dev/null | \$B awk '/Revision/ {print \$2}')
echo APPDEV=\$(\$B awk '\$2 == \"/app\" {print \$1}' /proc/mounts | \$B tail -n 1)
for f in /system/xbin/atc /system/xbin/balong-nvtool /system/xbin/dropbear /app/hijacks/lib/oled_hijack.so /app/hijacks/bin/web_hook_client /system/etc/autorun.d; do [ -e \$f ] || echo MISSING=\$f; done
echo OLEDCFG=\$([ -f /app/webroot/WebApp/common/config/oled/menue.xml ] && echo 1)
echo APPFREE=\$(\$B df -k /app | \$B tail -n 1 | \$B awk '{print \$(NF-2)}')
echo ONLINEFREE=\$(\$B df -k /online | \$B tail -n 1 | \$B awk '{print \$(NF-2)}')
echo SOMD5=\$(\$B md5sum /app/hijacks/lib/oled_hijack.so 2>/dev/null | \$B cut -d' ' -f1)
") || stop "не удалось прочитать данные роутера" "проверьте вход по SSH и запустите снова"

val() { sed -n "s/^$1=//p" <<<"$PROBE" | head -n 1; }
[ "$(val BB)" = 1 ] || stop "на роутере нет $BB: это не мод bay v5" "поставьте мод: docs/recovery.md"
BOARD=$(val BOARD); PRODUCT=$(val PRODUCT); APPSIZE=$(val APPSIZE)
case "$BOARD" in
	*E5785Lh-23c) ;;
	"") stop "роутер не сообщил имя платы" "ставьте только на E5785Lh-23c; чистый роутер — docs/recovery.md" ;;
	*) stop "это не E5785Lh-23c: плата $BOARD" "комплект только для 23c, на другой модели не ставьте" ;;
esac
[ "$APPSIZE" = 013c0000 ] || stop "раздел app размером ${APPSIZE:-?}, у 23c 013c0000: на флеше таблица разделов другой модели" "docs/recovery.md"
[ -n "$PRODUCT" ] || stop "пустое имя продукта: NV от чужой прошивки" "docs/nv-fix.md, потом запустите снова"
case "$(val REV)" in
	21.191.63.02*) ;;
	*) stop "прошивка ${PRODUCT} версии $(val REV), нужна 21.191.63.02" "docs/recovery.md" ;;
esac
MISSING=$(sed -n 's/^MISSING=//p' <<<"$PROBE" | tr '\n' ' ')
[ -z "$MISSING" ] || stop "нет файлов мода bay v5: $MISSING" "поставьте мод: docs/recovery.md"
[ "$(val APPDEV)" = /dev/block/mtdblock24 ] || stop "/app смонтирован с «$(val APPDEV)», а не с mtdblock24" "проверьте прошивку: docs/recovery.md"
[ "$(val LOGOIDX)" = mtd20 ] || [ "$LOGO" = 0 ] || stop "раздел logo на «$(val LOGOIDX)», а не на mtd20" "логотип не пишется, проверьте прошивку"
if [ "$MENUPART" = 1 ]; then
	[ "$(val OLEDCFG)" = 1 ] || stop "нет файлов экрана в веб-интерфейсе (/app/webroot/WebApp/common/config/oled)" "поставьте modwebui_1.5a: docs/recovery.md"
fi

# Место: установщики считают точно; здесь грубая проверка, чтобы не начинать зря
NEED_ONLINE=512; NEED_APP=0
if [ "$PANEL" = 1 ]; then
	for n in $ALLPKGS; do NEED_ONLINE=$((NEED_ONLINE + $(du -sk "$WEBUI/src/pkg/$n" | cut -f1))); done
fi
if [ "$MENUPART" = 1 ]; then
	NEED_ONLINE=$((NEED_ONLINE + $(du -sk "$MENU" | cut -f1)))
	WANT=$(awk '$1 == "FILE" && $3 == "/app/hijacks/lib/oled_hijack.so" {print $4}' "$MENU/MANIFEST")
	[ "$(val SOMD5)" = "$WANT" ] || NEED_APP=$(awk '$1 == "FILE" {s += $6} END {print int(s / 1024) + 64}' "$MENU/MANIFEST")
fi
AF=$(val APPFREE); OF=$(val ONLINEFREE)
[ "${OF:-0}" -ge "$NEED_ONLINE" ] || stop "мало места в /online: свободно ${OF:-?} КиБ, нужно около $NEED_ONLINE КиБ" "ставьте меньше пакетов: --pkgs=awg"
[ "${AF:-0}" -ge "$NEED_APP" ] || stop "мало места в /app: свободно ${AF:-?} КиБ, нужно около $NEED_APP КиБ" "освободите /app или откатите старые файлы меню"
echo "  плата $BOARD, прошивка $(val REV), мод bay v5 на месте"
echo "  свободно: /app $AF КиБ, /online $OF КиБ; нужно около: /app $NEED_APP КиБ, /online $NEED_ONLINE КиБ"

# --- 3. План ---
title "План"
n=0
if [ "$PANEL" = 1 ]; then
	n=$((n + 1)); echo "  $n. Панель: web и api, затем по одному пакеты:$ALLPKGS"
fi
if [ "$MENUPART" = 1 ]; then
	n=$((n + 1)); echo "  $n. Меню экрана: набор в $SET_DIR, mk_oled_cfg.sh, DRY=1, install.sh$([ "$SMS" = 1 ] && echo ' с SMS=1')"
fi
if [ "$LOGO" = 1 ]; then
	n=$((n + 1)); echo "  $n. Логотип: копия раздела logo на компьютер, образ из $(basename "$LOGO_PNG"), запись в mtdblock20, чтение назад и сверка"
fi
n=$((n + 1)); echo "  $n. Проверка: панель, помощник, VPN, файлы меню"
[ "$REBOOT" = 1 ] && echo "  $((n + 1)). Перезагрузка и повтор проверки"
echo "  NV, загрузчики и прошивка не меняются."

P_ARGS=(--host="$ROUTER_HOST" --iface="$ROUTER_IFACE")

# --- 4. Панель ---
panel_part() {
	local dry=() n
	[ "$DRY" = 1 ] && dry=(--dry-run)
	title "Панель: web и api"
	"$WEBUI/src/installer/install.sh" "${dry[@]}" "${P_ARGS[@]}" --only=web,api \
		|| stop "установка web и api не прошла" "прочитайте вывод выше; подробности в webui/src/installer/README.md"
	[ "$DRY" = 1 ] || DONE_PARTS="$DONE_PARTS panel"
	for n in $ALLPKGS; do
		title "Панель: пакет $n"
		"$WEBUI/src/installer/install.sh" "${dry[@]}" "${P_ARGS[@]}" --no-build --only=pkg --pkg-only="$n" \
			|| stop "установка пакета $n не прошла" "при «НЕ ХВАТАЕТ» ставьте меньше пакетов: --pkgs=СПИСОК"
	done
}

# --- 5. Меню ---
menu_part() {
	local dir=$SET_DIR env="" sms=""
	[ "$SMS" = 1 ] && sms="SMS=1"
	[ "$DRY" = 1 ] && dir=$DRY_DIR
	title "Меню: копирование набора в $dir"
	tar -C "$MENU" --owner=0 --group=0 --numeric-owner --exclude=files/hijacks/oled_cfg -cf - . \
		| "${SSH[@]}" "$BB rm -rf $dir && $BB mkdir -p $dir && cd $dir && $BB tar -xf -" \
		|| stop "набор меню не скопировался" "проверьте SSH и место на роутере"
	title "Меню: подписи родного меню"
	"${SSH[@]}" "$BB sh $dir/mk_oled_cfg.sh" \
		|| stop "mk_oled_cfg.sh отказал" "веб-интерфейс на роутере должен быть 21.100.52.00.03 или modwebui_1.5a"
	title "Меню: проверка установщика (DRY=1)"
	"${SSH[@]}" "cd $dir && DRY=1 $sms $BB sh install.sh" \
		|| stop "install.sh меню отказал при проверке" "прочитайте сообщение выше; docs/troubleshooting.md, раздел «Меню экрана»"
	if [ "$DRY" = 1 ]; then
		"${SSH[@]}" "$BB rm -rf $dir" || true
		return 0
	fi
	title "Меню: установка"
	"${SSH[@]}" "cd $dir && $sms $BB sh install.sh" \
		|| stop "install.sh меню не прошел" "откат: ssh root@$ROUTER_HOST 'busyboxx sh $SET_DIR/rollback.sh'"
	DONE_PARTS="$DONE_PARTS menu"
}

# --- 6. Логотип ---
logo_part() {
	local t rc ans
	t=$(mktemp -d) || stop "нет временного каталога"
	title "Логотип: чтение раздела logo"
	"${SSH[@]}" "$BB dd if=/dev/mtd/mtd20 bs=65536 count=1 2>/dev/null" > "$t/current.bin" \
		|| { rm -rf "$t"; stop "раздел logo не прочитался" "проверьте SSH"; }
	[ "$(stat -c %s "$t/current.bin")" = 65536 ] || { rm -rf "$t"; stop "прочитано не 64 КиБ раздела logo" "запись отменена, проверьте SSH"; }
	python3 "$LOGO_TOOL" "$LOGO_PNG" "$t/current.bin" "$t/new.img" >/dev/null \
		|| { rm -rf "$t"; stop "образ логотипа не собрался из $LOGO_PNG" "нужен PNG 128x128"; }
	if [ "$DRY" = 1 ]; then
		echo "  образ собран: $(stat -c %s "$t/new.img") Б, md5 $(md5sum < "$t/new.img" | cut -d' ' -f1)"
		echo "  запись пропущена: --dry-run"
		rm -rf "$t"
		return 0
	fi
	if [ "$YES" != 1 ]; then
		echo ""
		echo "Сейчас будет записан раздел logo (mtdblock20). Ошибка записи не мешает работе системы, но логотип при загрузке будет испорчен."
		printf 'Записать логотип из %s? Напишите «да»: ' "$(basename "$LOGO_PNG")"
		read -r ans || ans=""
		[ "$ans" = "да" ] || [ "$ans" = "yes" ] || { rm -rf "$t"; stop "запись логотипа отменена" "запустите снова без --logo или подтвердите"; }
	fi
	LOGO_BACKUP=$PWD/logo-backup-$(date +%Y%m%d-%H%M%S).bin
	cp "$t/current.bin" "$LOGO_BACKUP" || { rm -rf "$t"; stop "копия раздела не сохранилась в $LOGO_BACKUP" "запустите из каталога с правом записи"; }
	echo "  копия раздела: $LOGO_BACKUP"
	title "Логотип: запись"
	# сперва файл на роутере: dd с count=1 из канала SSH мог бы записать неполный блок
	"${SSH[@]}" "$BB dd of=/tmp/logo_new.img 2>/dev/null" < "$t/new.img" \
		|| { rm -rf "$t"; stop "образ не передался" "раздел не менялся, проверьте SSH"; }
	[ "$("${SSH[@]}" "$BB md5sum /tmp/logo_new.img" | cut -d' ' -f1)" = "$(md5sum < "$t/new.img" | cut -d' ' -f1)" ] \
		|| { rm -rf "$t"; stop "образ на роутере не совпал с собранным" "раздел не менялся, запустите снова"; }
	DONE_PARTS="$DONE_PARTS logo"
	"${SSH[@]}" "$BB dd if=/tmp/logo_new.img of=/dev/block/mtdblock20 bs=65536 count=1 conv=notrunc 2>/dev/null && $BB sync" \
		|| { rm -rf "$t"; stop "запись в mtdblock20 не прошла" "верните раздел командами отката ниже"; }
	title "Логотип: чтение назад и сверка"
	"${SSH[@]}" "$BB dd if=/dev/mtd/mtd20 bs=65536 count=1 2>/dev/null" > "$t/back.bin" \
		|| { rm -rf "$t"; stop "раздел не прочитался после записи" "верните раздел командами отката ниже"; }
	cmp -s "$t/new.img" "$t/back.bin" \
		|| { rm -rf "$t"; stop "прочитанный раздел не совпал с образом" "верните раздел командами отката ниже"; }
	"${SSH[@]}" "$BB rm -f /tmp/logo_new.img" || true
	echo "  совпало байт в байт, 65536 Б"
	rm -rf "$t"
}

# --- 7. Проверка как в docs/install.md, раздел «Проверка» ---
final_check() {
	local fail=0 code st brief want got
	title "Проверка"
	if [ "$PANEL" = 1 ]; then
		code=$("${CURL[@]}" -s -m 15 -o /dev/null -w '%{http_code}' "http://$ROUTER_HOST/" || true)
		if [ "$code" = 200 ]; then echo "  панель: http 200"; else echo "  панель: http ${code:-нет ответа}, ожидается 200"; fail=1; fi
		st=$("${SSH[@]}" "$BB sh /online/mod/mod-ctl.sh status" 2>&1 || true)
		case "$st" in
			*"работает"*"очередь отвечает"*) echo "  помощник: работает, очередь отвечает" ;;
			*) echo "  помощник: не отвечает. Вывод mod-ctl.sh status:"; sed 's/^/    /' <<<"$st"; fail=1 ;;
		esac
		brief=$("${SSH[@]}" "[ -f /online/mod/pkg/awg/svc.sh ] && $BB sh /online/mod/pkg/awg/svc.sh brief" 2>/dev/null || true)
		case "$brief" in
			*running=1*) echo "  VPN: работает, ${brief##*|}" ;;
			*) echo "  VPN: не запущен; это нормально, пока нет профиля или не включен запуск" ;;
		esac
	fi
	if [ "$MENUPART" = 1 ]; then
		want=$(awk '$1 == "FILE" && $3 == "/app/hijacks/lib/oled_hijack.so" {print $4}' "$MENU/MANIFEST")
		got=$("${SSH[@]}" "$BB md5sum /app/hijacks/lib/oled_hijack.so" | cut -d' ' -f1)
		if [ "$got" = "$want" ]; then echo "  меню: oled_hijack.so совпадает с MANIFEST"; else echo "  меню: oled_hijack.so $got, в MANIFEST $want"; fail=1; fi
	fi
	[ "$fail" = 0 ] || stop "проверка после установки не прошла" "docs/troubleshooting.md"
}

wait_router() {
	local i
	echo "  жду роутер, до 180 с"
	sleep "${E5785_REBOOT_PAUSE:-20}"
	for i in $(seq 1 32); do
		if ip route get "$ROUTER_HOST" 2>/dev/null | grep -q " dev $ROUTER_IFACE " && "${SSH[@]}" true 2>/dev/null; then
			echo "  роутер отвечает"
			return 0
		fi
		sleep "${E5785_REBOOT_STEP:-5}"
	done
	return 1
}

[ "$PANEL" = 1 ] && panel_part
[ "$MENUPART" = 1 ] && menu_part
[ "$LOGO" = 1 ] && logo_part

if [ "$DRY" = 1 ]; then
	title "Итог"
	echo "  --dry-run: на флеше ничего не изменилось. Во временной памяти роутера файлы проверки уже убраны."
	echo "  Для установки запустите ту же команду без --dry-run."
	exit 0
fi

final_check

if [ "$REBOOT" = 1 ]; then
	title "Перезагрузка"
	"${SSH[@]}" "$BB setsid $BB sh -c 'sleep 2; sync; $BB reboot -f' </dev/null >/dev/null 2>&1 &" \
		|| stop "команда перезагрузки не прошла" "перезагрузите роутер сам и пройдите проверку из README"
	wait_router || stop "роутер не вернулся за 180 с" "посмотрите экран; если сети USB нет, проверьте lsusb | grep 12d1"
	final_check
else
	title "Нужна перезагрузка"
	echo "  Меню и логотип заработают после перезагрузки роутера. Запустите с --reboot или выполните:"
	echo "  ssh root@$ROUTER_HOST '$BB setsid $BB sh -c \"sleep 2; sync; $BB reboot -f\" </dev/null >/dev/null 2>&1 &'"
	echo "  После нее пройдите проверку: docs/install.md, раздел «Проверка»."
fi

print_rollback
title "Готово"
