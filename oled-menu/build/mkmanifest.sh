#!/bin/sh
# mkmanifest.sh КАТАЛОГ_НАБОРА - пересчитывает md5 и размеры в строках FILE файла MANIFEST по files/.
# Для файлов, которых в files/ нет (oled_cfg, пока не запущен mk_oled_cfg.sh), строка не меняется.
I=$1; M=$I/MANIFEST; T=$M.new
while IFS= read -r line; do
    case "$line" in
    FILE\ *)
        set -- $line
        rel=${3#/app/}; f=$I/files/$rel
        if [ -f "$f" ]; then
            sum=$(md5sum "$f" | cut -d' ' -f1); size=$(stat -c %s "$f")
            tail=${line#FILE $2 $3 $4 $5 $6 }
            printf 'FILE %s %s %s %s %s %s\n' "$2" "$3" "$sum" "$5" "$size" "$tail"
        else
            printf '%s\n' "$line"
        fi
        ;;
    *) printf '%s\n' "$line" ;;
    esac
done < "$M" > "$T"
mv "$T" "$M"
