# Логотип и анимация

Как записать и заменить — в [docs/boot-logo.md](../docs/boot-logo.md).

| путь | что это |
|---|---|
| `logo/logo3_A.png` | логотип «Подготовка...» |
| `logo/logo3_variants.png`, `home_A.png` | варианты логотипа, макет главного экрана |
| `anim/poehali4_00.png` … `poehali4_65.png` | 66 кадров анимации «Поехали!» |
| `anim/durations`, `anim/frames.bin` | длительности и кадры для экрана, те же, что в наборе меню |
| `anim/poehali4.gif` | просмотр анимации |
| `gen/` | генераторы кадров и логотипа |

Запуск генераторов в отдельном каталоге дает те же файлы побайтно:

```bash
mkdir /tmp/anim && cp boot/gen/*.py /tmp/anim && cd /tmp/anim
python3 anim4.py
mkdir out && python3 mkbootanim.py out "$(tr '\n' ',' < poehali4_durations | sed 's/,$//')" poehali4_??.png
```
