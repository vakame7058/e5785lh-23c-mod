# Пакеты панели: как получить бинарники

Пакеты `awg`, `dns`, `tpws` и `zapret2` ставятся на роутер из этого каталога. Скрипты и настройки лежат здесь,
бинарники `get-bins.sh` кладет из `prebuilt/`. Для того, кто ставит панель. Как настроить пакет — `README.md` в его каталоге,
лицензии и источники — [LICENSES.md](../../LICENSES.md).

## Получить бинарники

На компьютере, из корня комплекта:

```bash
src/pkg/get-bins.sh                   # все пакеты
src/pkg/get-bins.sh --only=awg,dns    # только эти
src/pkg/get-bins.sh --fetch            # smartdns, curl, tpws, nfqws2 скачать у авторов
```

| файл на выходе | откуда берется |
|---|---|
| `awg/bin/amneziawg-go` | `prebuilt/amneziawg-go/` |
| `awg/bin/awg` | `prebuilt/amneziawg-tools/` |
| `dns/bin/dnsmasq` | `prebuilt/dnsmasq/` |
| `dns/bin/smartdns` | `prebuilt/smartdns/` |
| `dns/bin/curl` | `prebuilt/curl/` |
| `tpws/bin/tpws` | `prebuilt/tpws/` |
| `zapret2/bin/nfqws2`, `zapret2/lua/` | `prebuilt/zapret2/` |
| `awg/amneziawg.ko` | необязательный файл: только с ключом `--module`, см. [awg/README.md](awg/README.md) |

Скрипт сверяет каждый файл по sha256 и останавливается при расхождении. Сеть не нужна. Нужен `sha256sum`.

Скачивание нужно при обновлении версий или если файла нет в `prebuilt/`. Для него нужны `curl`, `tar`, `xz`, архивы лежат в `src/pkg/.dl/`.
Если на компьютере есть `strip` для ARM (`arm-linux-gnueabi-strip` или `llvm-strip`), скрипт уменьшает скачанный smartdns с 4,1 до 3,2 МиБ.
Без него smartdns работает так же.

## Собрать самому

`build/build.sh` собирает `amneziawg-go`, `awg` и `dnsmasq` из исходников: скачивает их у авторов и сверяет sha256.

```bash
build/build.sh                 # все три, результат в build/out/
src/pkg/get-bins.sh --built    # взять их вместо prebuilt/
```

Нужны `docker` (образ `golang:1.25.12`) для `amneziawg-go`, `make` и тулчейн `bol-van/musl-cross` для остальных.
Тулчейн скрипт скачивает сам. Если его архив изменился, скрипт предупреждает: sha256 результата может отличаться от `prebuilt/`.

## Размер на роутере

| пакет | размер, МиБ |
|---|---|
| `awg` | 3,3, с модулем ядра 3,6 |
| `dns` | 9,4 |
| `tpws` | 0,1 |
| `zapret2` | 0,5 |

При замене уже стоящего пакета на `/online` нужно вдвое больше места: установщик хранит копию старых файлов для отката.
Если места не хватает, ставьте пакеты по одному: `src/installer/install.sh --only=pkg --pkg-only=ИМЯ`.
