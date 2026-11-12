# Инструменты

Скрипты для компьютера, кроме строк с пометкой «роутер». Как ими пользоваться — в инструкциях из [docs/](../docs/). Нужен Python 3; для картинок Pillow, для чтения флеша `pyusb`.

| файл | что делает | инструкция |
|---|---|---|
| `recovery/bin/balong-usbdload` | готовая сборка для Linux x86-64, [описание](recovery/bin/README.md) | [recovery](../docs/recovery.md) |
| `recovery/bin/build.sh` | сборка `balong-usbdload` и `balong_flash` из исходников forth32 | [recovery](../docs/recovery.md) |
| `recovery/patch_usblsafe_ptable23c.py` | правит `usblsafe-e5785.bin` под таблицу разделов 23c, 4 байта, со сверкой sha256 | [recovery](../docs/recovery.md) |
| `recovery/mkm3boot.py` | образ раздела `m3boot`: 4 копии M3Boot и таблицы | [recovery](../docs/recovery.md) |
| `recovery/mkyaffs_hw.py` | архив cpio в образ YAFFS2 2048+16 Б и обратная сверка | [recovery](../docs/recovery.md) |
| `recovery/flash_fw.sh` | запись цепочки и YAFFS2 через fastboot | [recovery](../docs/recovery.md) |
| `recovery/fbcli.py` | клиент fastboot на `pyusb`, для `oem`-команд с данными | [recovery](../docs/recovery.md) |
| `recovery/dump_pages.py` | чтение страниц флеша через `oem nanddump` | [recovery](../docs/recovery.md) |
| `recovery/verify_flash.py` | сверка дампа с образом байт в байт, пропускает плохие блоки | [recovery](../docs/recovery.md) |
| `nv/nvlib.py` | разбор `nv.bin` и `Nvdload_R11.bin` | [nv-fix](../docs/nv-fix.md) |
| `nv/nvfix_gen.py` | правка NV из секций `cat0` и `product_id=33` официального пакета | [nv-fix](../docs/nv-fix.md) |
| `nv/nv50018_req.bin` | запрос к `/dev/nv` (индекс 93, NV 50018), 46 Б; роутер | [nv-fix](../docs/nv-fix.md) |
| `nv/nvsys_check.py` | сверка `nvsys` с `nv.bin` перед перезагрузкой | [nv-fix](../docs/nv-fix.md) |
| `logo/mklogo.py` | образ раздела `logo` со своей картинкой, просмотр образа | [boot-logo](../docs/boot-logo.md) |
| `bridge/e5785_proxy.py` | мост `127.0.0.1` на роутер по IPv6 через USB | см. ниже |
| `bridge/e5785_webproxy.py` | мост к веб-интерфейсу через `ssh -L`: подменяет `Host`, `Origin`, `Referer` | см. ниже |

## Мосты

Мосты нужны редко. Обычно роутер отвечает на `192.168.1.1` по USB и Wi-Fi.

`e5785_proxy.py` — если IPv4 по USB не работает. Он находит адрес роутера запросом `ping ff02::1` и пробрасывает порт:

```bash
python3 tools/bridge/e5785_proxy.py 8080 80    # веб: http://127.0.0.1:8080
python3 tools/bridge/e5785_proxy.py 2222 22    # SSH: ssh -p 2222 root@127.0.0.1
```

Интерфейс ищется сам (`wwx*`), другой задается переменной `E5785_IFACE`.

`e5785_webproxy.py` — если веб-интерфейс открывается через проброс `ssh -L`. Веб-сервер роутера принимает только `Host` `192.168.1.1` или имя роутера:

```bash
ssh -L 8081:192.168.1.1:80 ХОСТ_С_ДОСТУПОМ
python3 tools/bridge/e5785_webproxy.py 8090 8081   # открыть http://127.0.0.1:8090/
```
