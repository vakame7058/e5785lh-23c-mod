# Лицензии и источники

Что входит в комплект, под какими лицензиями и откуда взято. Для тех, кто распространяет комплект или проверяет его состав.


## Компоненты

| компонент | версия | лицензия | текст лицензии | бинарник в комплекте |
|---|---|---|---|---|
| Код панели (`src/frontend`, `src/backend`, `src/installer`, скрипты в `src/pkg`, `build/`) | — | MIT | `LICENSE` | нет бинарников |
| Шрифт Geist, Geist Mono | 1.7.2 | OFL-1.1 | `src/frontend/fonts/OFL.txt` | подрезанные `.woff2` в `src/frontend/fonts/` |
| `amneziawg-go` | `v3.1.20260828` | MIT | `prebuilt/amneziawg-go/LICENSE` | да, `prebuilt/amneziawg-go/` |
| Go и `golang.org/x/crypto`, `x/net`, `x/sys` внутри `amneziawg-go` | 1.25.12; v0.42.0, v0.44.0, v0.36.0 | BSD-3-Clause | `prebuilt/amneziawg-go/LICENSE.golang` | внутри `amneziawg-go` |
| `amneziawg-tools` (`awg`) | `v3.1.20260812` | GPL-2.0 | `prebuilt/amneziawg-tools/COPYING` | да, `prebuilt/amneziawg-tools/` |
| `amneziawg.ko` (модуль ядра, вариант NEON) | `v3.1.20260906` с патчем для ядра 3.10 | GPL-2.0 | `kernel-module/` общего комплекта | нет: файл, исходники, патчи и сборка лежат в `kernel-module/` |
| `dnsmasq` | 2.93 | GPL-2.0 или GPL-3.0 | `prebuilt/dnsmasq/COPYING` | да, `prebuilt/dnsmasq/` |
| musl внутри статических `awg` и `dnsmasq` | из тулчейна | MIT | `prebuilt/COPYRIGHT.musl` | внутри них |
| `smartdns` | Release48.4 | GPL-3.0 | `prebuilt/smartdns/LICENSE` | да, `prebuilt/smartdns/` |
| `curl` (сборка `static-curl`) | 8.23.0-1 | curl и лицензии библиотек внутри, например OpenSSL (Apache-2.0) | `prebuilt/curl/COPYING`, `prebuilt/curl/LICENSE.static-curl` | да, `prebuilt/curl/` |
| `tpws` (zapret) | v72.13 | MIT | `prebuilt/tpws/LICENSE.txt` | да, `prebuilt/tpws/` |
| `nfqws2` и Lua-файлы (zapret2) | v1.0.6 | MIT; внутри библиотеки netfilter под GPL-2.0 и LGPL-2.1 | `prebuilt/zapret2/LICENSE.txt` | да, `prebuilt/zapret2/` |
| `cacert.pem` (сертификаты Mozilla) | дата в начале файла | MPL-2.0 | [mozilla.org/MPL/2.0](https://www.mozilla.org/MPL/2.0/) | файл в `src/pkg/dns/` |

- Исходники сторонних программ в комплект не входят: ссылки у авторов — в разделе «Исходники».
- Команды сборки — `build/build.sh`, он собирает те же файлы байт в байт.
- `smartdns`, `curl`, `tpws`, `nfqws2` в `prebuilt/` — файлы из релизов авторов без изменений; у `smartdns` только убраны отладочные символы (`strip`).
- В `src/frontend/fonts/` лежит подрезанный Geist: латиница, кириллица, знаки. В лицензии шрифта нет зарезервированного имени.

Файлов Huawei и мода bay в комплекте нет.

## Исходники

| программа | версия | тег | файл исходников | лицензия |
|---|---|---|---|---|
| `amneziawg-go` | `v3.1.20260828` | <https://github.com/amnezia-vpn/amneziawg-go/tree/v3.1.20260828> | <https://github.com/amnezia-vpn/amneziawg-go/archive/refs/tags/v3.1.20260828.tar.gz> | MIT |
| `amneziawg-tools` | `v3.1.20260812` | <https://github.com/amnezia-vpn/amneziawg-tools/tree/v3.1.20260812> | <https://github.com/amnezia-vpn/amneziawg-tools/archive/refs/tags/v3.1.20260812.tar.gz> | GPL-2.0 |
| `dnsmasq` | 2.93 | <https://thekelleys.org.uk/gitweb/?p=dnsmasq.git;a=shortlog;h=refs/tags/v2.93> | <https://thekelleys.org.uk/dnsmasq/dnsmasq-2.93.tar.xz> | GPL-2.0 или GPL-3.0 |
| `smartdns` | Release48.4 | <https://github.com/pymumu/smartdns/tree/Release48.4> | <https://github.com/pymumu/smartdns/archive/refs/tags/Release48.4.tar.gz> | GPL-3.0 |
| `curl` | 8.23.0 | <https://github.com/curl/curl/tree/curl-8_23_0> | <https://curl.se/download/curl-8.23.0.tar.xz> | curl |
| сборка `static-curl` | 8.23.0-1 | <https://github.com/stunnel/static-curl/tree/8.23.0-1> | <https://github.com/stunnel/static-curl/archive/refs/tags/8.23.0-1.tar.gz> | MIT |
| `tpws` (zapret) | v72.13 | <https://github.com/bol-van/zapret/tree/v72.13> | <https://github.com/bol-van/zapret/releases/download/v72.13/zapret-v72.13.tar.gz> | MIT |
| `nfqws2` (zapret2) | v1.0.6 | <https://github.com/bol-van/zapret2/tree/v1.0.6> | <https://github.com/bol-van/zapret2/releases/download/v1.0.6/zapret2-v1.0.6.tar.gz> | MIT |

## Данные RIPE NCC

Данные RIPE NCC комплект не распространяет. В нем есть только генератор `split-gen.py` (MIT) и [инструкция](src/pkg/awg/tools/README.md): список российских адресов каждый собирает сам из файла статистики <https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest> и загружает кнопкой из панели.

[Заявление RIPE NCC о правах](https://www.ripe.net/about-us/legal/copyright-statement/) разрешает частное, некоммерческое и исследовательское использование в неизмененном виде с указанием источника, остальное — с письменного разрешения RIPE NCC. Без списка раздельный режим не действует, это обычный полный VPN.

## Источники и sha256

| файл | откуда | sha256 |
|---|---|---|
| `amneziawg-go-v3.1.20260828.tar.gz` | <https://github.com/amnezia-vpn/amneziawg-go/archive/refs/tags/v3.1.20260828.tar.gz> | `24c656cfb80ff6855702710eaf2e3729fa710bf6bfdbbbdfba01984ccd17de95` |
| `prebuilt/amneziawg-go/amneziawg-go` | сборка `build/build.sh` | `0a5b18764769e4e1bd7328a390ba4a12a560dac87f15afbf5328b2f16c6a9492` |
| `amneziawg-tools-v3.1.20260812.tar.gz` | <https://github.com/amnezia-vpn/amneziawg-tools/archive/refs/tags/v3.1.20260812.tar.gz> | `dbd8ce0748d835d18f30bb76720246b7bfc80bd09cd17c379b1c59f683a18493` |
| `prebuilt/amneziawg-tools/awg` | сборка `build/build.sh` | `36be7da619361c20ae319d6ec9bd1732975f87c2e8bb51deb8f575c5dddaca61` |
| `awg-kmod-v3.1.20260906.tar.gz` (исходники модуля) | `kernel-module/src/` общего комплекта; основа: <https://github.com/amnezia-vpn/amneziawg-linux-kernel-module> | `e32fa46f1b6f9e319c5261f0b0765c3a9261e40cb7c4616fd73500da961a2932` |
| `awg-3.1.20260906-3.10-balong-neon.patch` | `kernel-module/patches/` общего комплекта | `0ad53ccaacbdf45677e348fbb0d7fb707fca2a212692b02533460fb939cc137c` |
| `amneziawg.ko` (вариант `neon`, md5 `6650d98a006f25c1edf326693b81125a`) | `kernel-module/prebuilt/neon/` общего комплекта | `f2b6991c0aa2895cd6b5e4c234cbf8732cff922ab8082ff999aad1101fc6afff` |
| `dnsmasq-2.93.tar.xz` | <https://thekelleys.org.uk/dnsmasq/dnsmasq-2.93.tar.xz>, подпись <https://thekelleys.org.uk/dnsmasq/dnsmasq-2.93.tar.xz.asc> | `0c00d4e5c97c8306e5fb932b348b34269c9c29a0e7df0e8e82958b407092bc19` |
| `prebuilt/dnsmasq/dnsmasq` | сборка `build/build.sh` | `e5b27c7f40532d09e4ce069ddf3584e4ec0b9391f124f93cc4c8fbdf0642c1ff` |
| `smartdns-arm` | <https://github.com/pymumu/smartdns/releases/download/Release48.4/smartdns-arm>, исходники <https://github.com/pymumu/smartdns/archive/refs/tags/Release48.4.tar.gz> | `1abf76864b7976387f7b2345a9f4acf229707f755a21b430c1756296a91ef7e3` |
| `prebuilt/smartdns/smartdns` | `smartdns-arm` после `strip` | `c1675c98e9b34e8327eda6561c27559727c52bd92fe5669639a10ac56ebb931b` |
| `Release48.4.tar.gz` (исходники `smartdns`) | ссылка в разделе «Исходники» | `b07abba99e921f262ba47588e12f5b36dd849f79c0145542440eb6b7eed80553` |
| `curl-8.23.0.tar.xz` | ссылка в разделе «Исходники» | `8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5` |
| `8.23.0-1.tar.gz` (исходники `static-curl`) | ссылка в разделе «Исходники» | `811f4bcee86e5ca31f42fc5e2057810cf229ceea16b8c06889adb519d311fe2a` |
| `curl-linux-armv7-musl-8.23.0-1.tar.xz` | <https://github.com/stunnel/static-curl/releases/download/8.23.0-1/curl-linux-armv7-musl-8.23.0-1.tar.xz> | `10245cccca6e81b654ec7454c0397ab26e4a31910440548625a3802ce0971b3b` |
| `curl` в этом архиве | см. строку выше | `990b46936967f134ac933724ae10266068a2adb5623a7d527620ee9bcd68405f` |
| `zapret-v72.13.tar.gz` | <https://github.com/bol-van/zapret/releases/download/v72.13/zapret-v72.13.tar.gz> | `25c74e6c5f48963fa244c2955e76694a07c39447245a0457e2efdc74b3317e68` |
| `tpws` в этом архиве | `binaries/linux-arm/tpws` | `412032484525f7fef8ea7d69e7eefc2c972098aee8879a5f93c70dcfb75b1438` |
| `zapret2-v1.0.6.tar.gz` | <https://github.com/bol-van/zapret2/releases/download/v1.0.6/zapret2-v1.0.6.tar.gz> | `eb412aebc82cdef1f09b6aa9df45c8ff60fb88683b6663e6c4a9275d87ea2db4` |
| `nfqws2` в этом архиве | `binaries/linux-arm/nfqws2` | `32dc4a573830a334d4cec48194814e9eb6a1ad312cb4f630beefcdc157128c8b` |
| `geist-1.7.2.tgz` | <https://registry.npmjs.org/geist/-/geist-1.7.2.tgz>, подрезка `src/frontend/dev/fonts.py` | `88cbfaca51646078f3172802643691bb8fe2df15ca4c455b1b101e49b7d469a6` |
| `armv6-unknown-linux-musleabi.tar.xz` (тулчейн, в комплект не входит) | <https://github.com/bol-van/musl-cross/releases/download/latest/armv6-unknown-linux-musleabi.tar.xz> | `2a92a8d71ed22ad0a984d5a1377a30bbbe0aaaf7492a1861d9417f1476243ecf` |
