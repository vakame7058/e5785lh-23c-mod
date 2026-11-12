#!/bin/sh
# Все проверки игры на ПК и картинки для просмотра.
# Результат: ../preview/*.png, ../preview/orbit_autopilot.gif, журнал в out/run.log.
set -e
T=$(cd "$(dirname "$0")" && pwd)
OUT=$T/out
PRE=$T/../preview
mkdir -p "$OUT" "$PRE"
"$T/build.sh" > "$OUT/build.log" 2>&1
export ASAN_OPTIONS=detect_leaks=1:abort_on_error=1
export UBSAN_OPTIONS=print_stacktrace=1
{
echo "== крайние случаи (ASan+UBSan)"
"$OUT/orbit_sim_asan" edge x
echo "== 10000 кадров, 5 сидов (ASan+UBSan+LSan)"
for s in 1 7 123 4567 99991; do
    echo 100 > "$OUT/orbit_best"
    SIM_SEED=$s "$OUT/orbit_sim_asan" stress 10000 | head -1
    echo "   рекорд в файле: $(cat "$OUT/orbit_best")"
done
echo "== 200000 кадров (ASan+UBSan+LSan)"
SIM_SEED=31337 "$OUT/orbit_sim_asan" stress 200000
echo "== потоки таймера и кнопок (TSan)"
TSAN_OPTIONS=halt_on_error=1 "$OUT/orbit_sim_tsan" threads 8000
echo "== партии автопилотом"
"$OUT/orbit_sim" play 12 | tail -1
echo "== замер на ПК"
"$OUT/orbit_sim" bench 20000
} 2>&1 | tee "$OUT/run.log"
# кадры: рекорд 9000 в файле, чтобы «Конец» показал рекорд больше очков
rm -rf "$OUT/shots" && mkdir -p "$OUT/shots"
echo 9000 > "$OUT/orbit_best"
"$OUT/orbit_sim" shots "$OUT/shots" > "$OUT/shots.log"
python3 "$T/topng.py" png "$OUT/shots" "$PRE" 3
echo 1500 > "$OUT/orbit_best"
SIM_SEED=41 "$OUT/orbit_sim" gif "$OUT/gif.bin" > "$OUT/gif.log"
python3 "$T/topng.py" gif "$OUT/gif.bin" "$PRE/orbit_autopilot.gif" 2
rm -f "$OUT/gif.bin"
