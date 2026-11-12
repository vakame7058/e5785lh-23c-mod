# заглушка svc.sh: состояние в файлах рядом
S=$(dirname $0)
[ -f $S/active ] || echo awg2 > $S/active
[ -f $S/running ] || echo 1 > $S/running
[ -f $S/split ] || echo 0 > $S/split
case "$1" in
 list) A=$(cat $S/active); for p in "awg2|AWG2 · Дом|2.0" "awg3_1|AWG3.1 · Работа очень длинная подпись профиля|3.1" "bad:id|x|y"; do id=${p%%|*}; [ "$id" = "$A" ] && echo "$p|1" || echo "$p|0"; done ;;
 brief) A=$(cat $S/active); echo "running=$(cat $S/running)|profile=$A|label=$( [ $A = awg2 ] && echo 'AWG2 · Дом' || echo 'AWG3.1 · Работа')|handshake=8|engine=kernel|split=$(cat $S/split)" ;;
 split-status) echo "split_list=1" ;;
 split) case "$2" in on) echo 1 > $S/split ;; off) echo 0 > $S/split ;; *) exit 2 ;; esac ;;
 use) [ "$2" = nope ] && { echo "нет такого профиля" >&2; exit 1; }; echo "$2" > $S/active ;;
 start) echo 1 > $S/running ;;
 stop) echo 0 > $S/running ;;
 *) exit 2 ;;
esac
