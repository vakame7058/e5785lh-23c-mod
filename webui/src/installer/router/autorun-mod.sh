#!/system/bin/sh
# Автозапуск веб-панели: помощник и включенные пакеты.
# Ставится в /system/etc/autorun.d/mod.sh. Его вызывает /system/etc/autorun.sh
# при загрузке, до запуска веб-сервера, и ждет завершения. Поэтому скрипт
# только запускает /online/mod/mod-ctl.sh boot в фоне и сразу выходит:
# ошибка или зависание помощника загрузку не задерживают.
# Выключить автозапуск: создать файл /online/mod/disabled.
[ -f /online/mod/disabled ] && exit 0
[ -f /online/mod/mod-ctl.sh ] || exit 0
[ -x /system/bin/busyboxx ] || exit 0
/system/bin/busyboxx setsid /system/bin/busyboxx sh /online/mod/mod-ctl.sh boot </dev/null >/dev/null 2>&1 &
exit 0
