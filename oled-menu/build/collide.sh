#!/bin/sh
# collide.sh SO EXE КАТАЛОГ_БИБЛИОТЕК... : экспорт .so, совпадающий с символами EXE и всех его
# зависимостей (рекурсивно). Ожидаются только задуманные хуки. Библиотеки - копии /app/lib и /system/lib.
export LC_ALL=C
so=$1; exe=$2; shift 2; DIRS="$*"
libs=""; queue="$exe"
while [ -n "$queue" ]; do
  queue=$(echo $queue); f=${queue%% *}; [ "$queue" = "$f" ] && queue="" || queue=${queue#* }; [ -z "$f" ] && continue
  for n in $(llvm-readelf -d "$f" | awk '/NEEDED/ {gsub(/[\[\]]/,"",$NF); print $NF}'); do
    p=""; for d in $DIRS; do [ -f "$d/$n" ] && p=$d/$n && break; done
    [ -z "$p" ] && { echo "нет файла $n" >&2; continue; }
    case " $libs " in *" $p "*) ;; *) libs="$libs $p"; queue="$queue $p";; esac
  done
done
T=$(mktemp -d)
llvm-nm -D --defined-only "$so" | awk '{print $NF}' | sort -u > "$T/so"
for f in $exe $libs; do llvm-nm -D --defined-only "$f" 2>/dev/null | awk -v F="$(basename "$f")" '{print $NF" "F}'; done | sort -u > "$T/all"
join "$T/so" "$T/all" | grep -vE '^(__bss_start|_edata|_end|__end__|_bss_end__|__bss_start__|__bss_end__) '
rm -rf "$T"
