# Готовые программы для компьютера

Linux x86-64, статическая сборка, ставить ничего не нужно. Для восстановления: [docs/recovery.md](../../../docs/recovery.md).

| файл | что это | версия и исходники | лицензия |
|---|---|---|---|
| `balong-usbdload` | загрузка в память через BootROM | [forth32/balong-usbdload](https://github.com/forth32/balong-usbdload), коммит `4fa8b92d654c`, без изменений, собран `build.sh` | GPL-3.0, `LICENSE.GPL-3.0`; внутри musl, `COPYRIGHT.musl` |
| `balong_flash` | разбор файла прошивки на разделы | [forth32/balongflash](https://github.com/forth32/balongflash), коммит `bf43faa4b5f6`; в комплект не входит, собирается `build.sh` | файла лицензии в репозитории нет, в тексте программы указано `GNU GPLv3` |

Проверка файла: `sha256sum -c SHA256SUMS`. Сборка повторяется побайтно на той же версии компилятора.

Сборка обеих программ:

```bash
tools/recovery/bin/build.sh КАТАЛОГ
```

Загрузчики `usblsafe-*.bin` и `usbloader-*.bin` в комплект не входят и в программы не встроены. `usblsafe-e5785.bin` лежит в репозитории [forth32/balong-usbdload](https://github.com/forth32/balong-usbdload).

Загрузка этой сборкой на роутере не запускалась: на нем работала сборка из тех же исходников с динамической библиотекой.
