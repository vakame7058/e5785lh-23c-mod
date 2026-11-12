#!/system/bin/busyboxx sh
# Готовит files/hijacks/oled_cfg из файлов экрана вашего веб-интерфейса.
# Запуск на роутере из каталога набора, до install.sh: busyboxx sh mk_oled_cfg.sh [КАТАЛОГ]
# КАТАЛОГ по умолчанию: /app/webroot/WebApp/common/config/oled
# Что меняется:
#   menue.xml        у пункта 13 стрелка вместо переключателя (тип 0, элемент 2);
#   res/lang_russian.xml, res/lang_english.xml  подпись пункта 13: Расширенные, Advanced.
# Результат сверяется с MANIFEST. install.sh проверяет те же md5.

BB=${HIJ_B:-/system/bin/busyboxx}
[ -x "$BB" ] || BB=busybox
SRC=${1:-/app/webroot/WebApp/common/config/oled}
HERE=$(cd "$($BB dirname "$0")" && pwd)
OUT="$HERE/files/hijacks/oled_cfg"

die() { echo "mk_oled_cfg: ОШИБКА: $*" >&2; exit 1; }
for f in menue.xml res/lang_russian.xml res/lang_english.xml; do
    [ -f "$SRC/$f" ] || die "нет $SRC/$f"
done
$BB mkdir -p "$OUT/res" || die "не создать $OUT"

$BB sed -e '442s|<type>2</type>|<type>0</type>|' -e '452s|<id>3</id>|<id>2</id>|' \
    "$SRC/menue.xml" > "$OUT/menue.xml" || die "menue.xml"
$BB sed -e 's|>Быст. загр.<|>Расширенные<|' \
    "$SRC/res/lang_russian.xml" > "$OUT/res/lang_russian.xml" || die "lang_russian.xml"
$BB sed -e 's|>Fast boot<|>Advanced<|' \
    "$SRC/res/lang_english.xml" > "$OUT/res/lang_english.xml" || die "lang_english.xml"

bad=0
for rel in menue.xml res/lang_russian.xml res/lang_english.xml; do
    want=$($BB awk -v p="/app/hijacks/oled_cfg/$rel" '$1 == "FILE" && $3 == p {print $4}' "$HERE/MANIFEST")
    got=$($BB md5sum "$OUT/$rel" | $BB cut -d' ' -f1)
    if [ "$want" = "$got" ]; then
        echo "mk_oled_cfg: $rel готов"
    else
        echo "mk_oled_cfg: $rel: md5 $got, в MANIFEST $want" >&2
        bad=1
    fi
done
[ "$bad" = 0 ] || die "ваш веб-интерфейс отличается от 21.100.52.00.03 и modwebui_1.5a; install.sh такой набор не примет"
