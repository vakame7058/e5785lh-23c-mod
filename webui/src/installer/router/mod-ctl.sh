#!/system/bin/busyboxx sh
# Запуск и остановка помощника и пакетов веб-панели.
#
#   busyboxx sh /online/mod/mod-ctl.sh start|stop|restart|status|boot
#
# start   запустить помощник (/online/mod/helper/start.sh start: очередь qd и сторож wd) и включенные пакеты
# stop    остановить пакеты (svc.sh stop), помощник (start.sh stop), затем
#         добить оставшиеся процессы по PID-файлам (см. mod-lib.sh)
# boot    вызов из автозапуска: дождаться веб-сервера, помощник — start.sh boot,
#         затем включенные пакеты
# seed-save  сохранить запас случайности для следующей загрузки (см. ниже)
# status  помощник — пробным запросом через очередь (start.sh status), остальное — по PID-файлам;
#         PID-файлы завершившихся процессов убираются
# Сторож wd перезапускает qd, если очередь не отвечает две проверки подряд (раз в 30 с).
#
# Пакет — каталог /online/mod/pkg/<имя>/ со скриптом svc.sh start|stop;
# включен, если в каталоге есть файл enabled.
# Вывод скриптов помощника и пакетов — в /tmp/mod-ctl.log.
# Аварийный выключатель автозапуска: файл /online/mod/disabled.

. /online/mod/mod-lib.sh
mod_applets

LOG=/tmp/mod-ctl.log
# Журнал в ОЗУ: не даем ему расти больше 64 КиБ.
[ -f $LOG ] && [ "$(stat -c %s $LOG)" -gt 65536 ] && mv -f $LOG $LOG.old

log() { echo "[$(date +%H:%M:%S)] $*" >> $LOG; }

# Запустить скрипт с ограничением по времени. Ввод и вывод — не в терминал,
# чтобы фоновые процессы не держали сеанс ssh.
run() {
	_t=$1; shift
	log "запуск: $*"
	# busybox 1.21 на роутере: timeout -t СЕК; новые версии: timeout СЕК.
	if timeout -t 1 $BB true 2>/dev/null; then _to="-t $_t"; else _to=$_t; fi
	timeout $_to $BB sh "$@" </dev/null >> $LOG 2>&1
	_rc=$?
	log "код возврата $_rc: $*"
	return $_rc
}

do_start() {
	_how=${1:-start}
	mkdir -p $RUN && chown 0:0 $RUN && chmod 755 $RUN
	if [ -f $MOD/helper/start.sh ]; then
		if run 30 $MOD/helper/start.sh "$_how"; then say "  помощник: запущен"; else say "  помощник: ошибка запуска, см. $LOG"; fi
	else
		say "  помощник: нет $MOD/helper/start.sh"
	fi
	for d in $MOD/pkg/*; do
		[ -f "$d/svc.sh" ] || continue
		n=$(basename "$d")
		if [ ! -f "$d/enabled" ] && ! $BB grep -qx "$n" $RUN/was_running 2>/dev/null; then
			say "  пакет $n: не запущен (автозапуск выключен)"
			continue
		fi
		if run 30 "$d/svc.sh" start; then say "  пакет $n: запущен"; else say "  пакет $n: ошибка запуска, см. $LOG"; fi
	done
	rm -f $RUN/was_running
}

do_stop() {
	# какие пакеты работали: после установки do_start поднимет их снова, даже без автозапуска
	mkdir -p $RUN
	: > $RUN/was_running
	for d in $MOD/pkg/*; do
		[ -f "$d/svc.sh" ] || continue
		$BB sh "$d/svc.sh" status 2>/dev/null | $BB grep -q '^running=1' && basename "$d" >> $RUN/was_running
		run 20 "$d/svc.sh" stop || say "  пакет $(basename "$d"): ошибка остановки, см. $LOG"
	done
	if [ -f $MOD/helper/start.sh ]; then
		run 20 $MOD/helper/start.sh stop || say "  помощник: ошибка остановки, см. $LOG"
	fi
	mod_kill_pidfiles
}

do_status() {
	if [ -f $MOD/helper/start.sh ]; then
		# start.sh status: пробный запрос через очередь, а не только PID
		_st=$($BB sh $MOD/helper/start.sh status 2>&1)
		say "  помощник: $_st"
	fi
	found=0
	for pf in $PIDGLOBS; do
		[ -f "$pf" ] || continue
		pid=$(head -n 1 "$pf")
		case "$pid" in ''|*[!0-9]*) pid=0 ;; esac
		if [ "$pid" != 0 ] && [ -d "/proc/$pid" ]; then
			found=1
			say "  $(basename "$pf" .pid): работает, PID $pid"
		else
			# процесс завершился, файл остался: убираем, чтобы не путал
			rm -f "$pf"
			say "  $(basename "$pf" .pid): не работает, устаревший PID-файл убран"
		fi
	done
	[ $found = 1 ] || say "  процессов с PID-файлами нет"
	[ -f $MOD/disabled ] && say "  автозапуск выключен файлом $MOD/disabled"
	return 0
}

# OpenSSL на ядре 3.10 перед первым TLS ждет готовности /dev/random: после загрузки это 2-3 минуты,
# и все это время DoT не работает. Запас случайности с прошлой работы подмешивается в /dev/urandom,
# затем /dev/random заменяется на /dev/urandom. Запаса нет: все как раньше, случайность не ослабляем.
SEED=$MOD/conf/random-seed

seed_load() {
	[ -s $SEED ] || { log "случайность: запаса нет, /dev/random не меняю"; return 1; }
	$BB dd if=$SEED of=/dev/urandom bs=512 count=1 2>/dev/null || { log "случайность: запас не прочитан"; return 1; }
	if ! grep -q ' /dev/random ' /proc/mounts; then
		mount -o bind /dev/urandom /dev/random || { log "случайность: /dev/random не заменен"; return 1; }
	fi
	log "случайность: запас подмешан, /dev/random = /dev/urandom"
}

# Запись на флеш: при загрузке и один раз через 12 минут работы. Сбой загрузке не мешает.
seed_save() {
	[ -f $MOD/mod-ctl.sh ] || return 0
	mkdir -p $MOD/conf
	if (umask 077; $BB dd if=/dev/urandom of=$SEED.tmp bs=512 count=1 2>/dev/null) &&
		chmod 600 $SEED.tmp && mv -f $SEED.tmp $SEED; then
		log "случайность: запас сохранен"
	else
		rm -f $SEED.tmp
		log "случайность: запас не сохранен"
	fi
}

do_boot() {
	[ -f $MOD/disabled ] && { log "автозапуск выключен файлом $MOD/disabled"; exit 0; }
	# PID-файл на время ожидания: откат или stop остановят и этот процесс.
	mkdir -p $RUN && echo $$ > $RUN/mod-ctl-boot.pid
	seed_load && seed_save
	if [ ! -e $RUN/seed-later ]; then
		: > $RUN/seed-later
		( sleep 720; seed_save ) </dev/null >/dev/null 2>&1 &
	fi
	log "загрузка: жду веб-сервер"
	i=0
	while [ $i -lt 180 ] && ! pidof web >/dev/null 2>&1; do sleep 2; i=$((i + 2)); done
	sleep 10
	log "загрузка: запуск (ждал веб-сервер $i с)"
	do_start boot >> $LOG 2>&1
	rm -f $RUN/mod-ctl-boot.pid
}

case "$1" in
start) do_start ;;
stop) do_stop ;;
restart) do_stop; do_start ;;
status) do_status ;;
boot) do_boot ;;
seed-save) seed_save ;;
*) echo "Использование: busyboxx sh $MOD/mod-ctl.sh start|stop|restart|status|boot|seed-save" >&2; exit 2 ;;
esac
