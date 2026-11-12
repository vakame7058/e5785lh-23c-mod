#!/bin/sh
# check_so.sh <so> <router_lib_dir> [extra_lib_dir] : проверка совместимости с линкером Android 4.4
so="$1"; L="$2"; L2="$3"
echo "== $so"
echo "NEEDED: $(llvm-readelf -d "$so" | awk '/NEEDED/ {print $NF}' | tr '\n' ' ')"
for t in HASH GNU_HASH TEXTREL RUNPATH RPATH RELR ANDROID_REL ANDROID_RELA VERNEED VERSYM; do
  llvm-readelf -d "$so" | grep -q "($t)" && echo "  tag $t: есть" || echo "  tag $t: нет"
done
echo "note: $(llvm-readelf -n "$so" 2>/dev/null | grep -A1 NT_ANDROID_TYPE_IDENT | tail -1 | xargs)"
echo "версии символов: $(llvm-readelf -V "$so" | grep -c 'Name:') записей version_r"
miss=0
for s in $(llvm-nm -D --undefined-only "$so" | awk '{print $2}' | sed 's/@.*//'); do
  found=""
  for lib in "$L"/libc.so "$L"/libdl.so "$L"/libm.so ${L2:+$L2/*.so}; do
    [ -f "$lib" ] || continue
    llvm-nm -D --defined-only "$lib" 2>/dev/null | awk '{print $NF}' | grep -qx "$s" && { found=$(basename "$lib"); break; }
  done
  if [ -z "$found" ]; then echo "  НЕТ В БИБЛИОТЕКАХ РОУТЕРА: $s"; miss=$((miss+1)); fi
done
echo "импортов: $(llvm-nm -D --undefined-only "$so" | wc -l), не найдено: $miss"
