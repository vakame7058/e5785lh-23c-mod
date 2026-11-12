# Меню экрана

Основа — `huawei_oled_hijack_ng`, коммит `0807e72`, лицензия LGPL-3.0. Что умеет, установка и откат — в [docs/oled-menu.md](../docs/oled-menu.md).

| путь | что это |
|---|---|
| `src/` | полное дерево исходников |
| `patches/r10_vs_upstream_0807e72.patch` | патч к исходному проекту: `patch -p1`, дает `src/` побайтно |
| `hijlua/` | `luarun` для скриптов: `hijlua.c` и обертка |
| `build/` | `prepare_sysroot.sh`, `build_r10.sh`, `build_hijlua.sh`, проверки ELF `check_so.sh`, `collide.sh`, `mkmanifest.sh` |
| `tools/` | генераторы шрифта, значков, углов рамки; ширина строки |
| `install/` | готовый набор: `install.sh`, `rollback.sh`, `mk_oled_cfg.sh`, `check_sms.sh`, `MANIFEST`, `files/` |
| `test/` | проверки на компьютере: `run_pc.sh`, стенд пункта DNS `dns/run.sh`, заглушки `svc.sh`, песочница установки `sandbox.sh` |

Собранные `.so` и программы в `install/files/` собраны из `src/` и `hijlua/`, воспроизводятся побайтно.

`test/sandbox.sh КАТАЛОГ_НАБОРА КАТАЛОГ` копирует `install.sh` и `rollback.sh` с путями внутри песочницы, чтобы проверить их на компьютере на копии `/app`. Нужны `busybox` и копия каталога `hijacks` с роутера.
