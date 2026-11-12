# Авторы и лицензии

Кто что сделал и на каких условиях это входит в комплект. Тексты лицензий — в [LICENSES/](LICENSES/).

## Свои части комплекта

| что | лицензия |
|---|---|
| `tools/`, `boot/` (скрипты, PNG, `frames.bin`) | MIT, [`LICENSES/MIT.txt`](LICENSES/MIT.txt) |
| `docs/`, `README.md`, `README.en.md`, `CREDITS.md` | MIT |
| `webui/` | MIT, сторонние пакеты и их лицензии — [`webui/LICENSES.md`](webui/LICENSES.md) |
| `oled-menu/` | LGPL-3.0, [`LICENSES/LGPL-3.0.txt`](LICENSES/LGPL-3.0.txt), как исходный проект |
| `game/` | LGPL-3.0: собирается в ту же библиотеку |
| `kernel-module/` | GPL-2.0, [`LICENSES/GPL-2.0.txt`](LICENSES/GPL-2.0.txt), как модуль |

Правообладатель своих частей — E5785 mod contributors.

## Чужие проекты, вошедшие в комплект

| проект | автор | лицензия | что взято |
|---|---|---|---|
| [huawei_oled_hijack_ng](https://github.com/alexbers/huawei_oled_hijack_ng), коммит `0807e72` | alexbers | LGPL-3.0 | основа меню, скрипты; файлы в `oled-menu/src/` |
| [форк saqie1393](https://github.com/saqie1393/huawei_oled_hijack_ng) | saqie1393 | LGPL-3.0 | значки `oled_icons.h`, вывод RGB565 |
| [шрифты DejaVu](https://dejavu-fonts.github.io/) | Bitstream, DejaVu | Bitstream Vera, [`LICENSES/DejaVu-Bitstream-Vera.txt`](LICENSES/DejaVu-Bitstream-Vera.txt) | глифы в `oled_font_aa.h`, надписи в PNG |
| [balong-usbdload](https://github.com/forth32/balong-usbdload), коммит `4fa8b92d654c`, сборка в `tools/recovery/bin/` | forth32, ValdikSS (обход защиты) | GPL-3.0, `tools/recovery/bin/LICENSE.GPL-3.0`; внутри musl, MIT | загрузка в память через BootROM; загрузчики `usblsafe-*.bin` не входят |
| [amneziawg-linux-kernel-module](https://github.com/amnezia-vpn/amneziawg-linux-kernel-module), тег `v3.1.20260906` | Jason A. Donenfeld, AmneziaVPN | GPL-2.0 | основа `kernel-module/`, архив исходников рядом с патчами |

## Чужие проекты, на которые комплект опирается

В комплект не входят, берутся отдельно.

| проект | автор | лицензия | зачем |
|---|---|---|---|
| [balongflash](https://github.com/forth32/balongflash), `tools/recovery/bin/build.sh` собирает из исходников | forth32 | файла лицензии в репозитории нет; в тексте программы указано `GNU GPLv3` | разбор файла прошивки |
| [balong-nvtool](https://github.com/forth32/balong-nvtool) | forth32 | GPL-3.0 | запись NV; собран в мод bay v5 |
| мод bay v5 ([исходники сборки](https://github.com/Huawei-LTE-routers-mods/Huawei_E5785_fw_bake)) | bay3255 | см. репозиторий | база, на которую ставится все остальное |
| `modwebui_1.5a` | bay3255, правки e-dok | см. тему | веб-интерфейс и ресурсы экрана |
| [bionic Android 10](https://github.com/aosp-mirror/platform_bionic) | AOSP | Apache 2.0, BSD | заголовки и crt для сборки меню |
| дерево ядра `E5885Ls-93a_open_src` | Huawei, выложено ValdikSS | GPL-2.0 | заголовки для сборки `kernel-module/` |

## Идеи и разбор

| кто | что |
|---|---|
| [ValdikSS, huawei_oled_hijack](https://github.com/ValdikSS/huawei_oled_hijack) | сам подход: перехват вызовов программы экрана; обход защиты BootROM в `balong-usbdload` |
| [depau-forks/huawei_oled_hijack_ng](https://github.com/depau-forks/huawei_oled_hijack_ng) | рамка выбранного пункта меню |
| участники темы 907081 на 4PDA | составы прошивок, порядок установки, форматы, опыт по 23c |

## Прошивки Huawei

Прошивки, `oled.orig`, `cms`, `fastboot`, `usblsafe`, `modem_fw`, `WebApp` принадлежат Huawei и в комплект не входят. Инструкции говорят, где их взять и какие скрипты правят вашу копию.
