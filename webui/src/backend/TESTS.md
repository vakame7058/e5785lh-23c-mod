# Проверка своих вызовов с входом

Все свои вызовы идут через `POST /api/vsim/config-vsim` (поле `module`), см. [docs/API.md](../../docs/API.md).
Без входа можно проверить только, что веб требует вход (`100003`), и работу помощника напрямую
(`/online/mod/test/lt.sh` от uid 1000), см. последний раздел. Ниже — проверка через веб-сервер после входа.

Перед любым обращением по SSH проверьте маршрут: `ip route get 192.168.1.1`. Он должен идти через интерфейс
роутера, иначе по этому адресу отвечает другое устройство.

## Подготовка

1. Помощник работает: `ssh … root@192.168.1.1 'busyboxx sh /online/mod/mod-ctl.sh status'` печатает
   `помощник: работает: N, очередь отвечает (сторож M)`.
2. Войти в панель в браузере, открыть консоль (F12, вкладка «Консоль»). Вызовы ниже — через `M.mod`
   панели: `M.mod('имя')` — show, `M.mod('имя', 'действие', {поля})` — действие.
   Ошибка приходит исключением `M.ApiError` с полями `code` и `message`.

Для удобства:

```js
t = async (...a) => { const s = Date.now(); try { const r = await M.mod(...a); console.log(Date.now() - s, 'мс', r); return r; } catch (e) { console.log(Date.now() - s, 'мс', 'ОШИБКА', e.code, e.message, e.data); } };
```

## 1. Основные вызовы

| № | вызов | ожидается |
|---|---|---|
| 1 | `t('helper')` | `running` 1, `modem_write` 0, `nv_write` 0 |
| 2 | `t('sysinfo')` | `cpu_pct` (0–100), `cpu_mhz`, `cpu_min_mhz` 100, `cpu_max_mhz` 666, `mem_avail_kb`, `mem_avail_est` 1, `mem_used_pct`, `bat_temp_c`; время до 300 мс (кроме первого вызова за 2 минуты — до 700 мс) |
| 3 | `t('lanname')` | `device_name` www, `domain_name` huaweimobilewifi.com, `homeurl`, `dns_ip` 192.168.1.1, `dns_ok` 1, `web_status` 200, `web_ok` 1 |
| 4 | `t('lanname', 'set', {device_name: 'modem', domain_name: 'my.local'})` | ошибка `9003` про `.local` и mDNS, имя не меняется |
| 5 | `t('lanname', 'set', {device_name: '-x', domain_name: 'lan'})` | ошибка `9003` про `device_name` |
| 6 | `t('lanname', 'set', {device_name: 'modem', domain_name: 'lan'})` | смена имени — делаете вы. Ответ: `homeurl` modem.lan, `reboot_needed`, поля проверки (см. раздел 2) |
| 7 | `t('speedtest', 'servers')` | `curl` 1, список `servers` (если файла списка нет — один `selectel`) |
| 8 | `t('speedtest', 'run', {server: 'auto'})`, затем `t('speedtest')` раз в 1 с | `status` running, растущий `samples` (`t`, `cpu_pct`, `kbps`), потом `ok`, `speed_kbps`, `candidates` (при нескольких серверах) |
| 9 | `t('speedtest', 'run', {url: 'https://speedtest.selectel.ru/10MB', timeout_s: 10})` | то же по HTTPS |
| 9а | `t('speedtest', 'run', {server: 'auto', timeout_s: 4})`, затем `t('speedtest')` раз в 1 с | `phase` идет `download`, `download_mt`, `upload`, `upload_mt`; в итоге `mt_kbps`, `up_mt_kbps`, пустые `mt_error` и `up_mt_error` или текст причины |
| 10 | `t('vpn')` | `<awg>`: `installed` (0, если пакет `awg` не поставлен), `configured`, `up`, `autostart`, `info`, `rx_bytes`, `tx_bytes`, `handshake_s` |
| 11 | `t('vpn', 'setconf', {type: 'awg', conf_b64: btoa('[Interface]\nPrivateKey = TEST\n')}, {encrypt: true})` | без пакета — `9006`; с пакетом — состояние `awg`, `configured` 1. Нет ответа или `100006` — значит, зашифрованное тело до Lua не доходит |
| 11а | `t('vpn', 'split', {on: 1})` без списка | `9004` «нет списка российских адресов: загрузите файл» |
| 11б | `t('vpn', 'split_direct', {op: 'add', addr: '203.0.113.0/24'})`, затем `{op: 'del', …}` | `<awg>`, в `split_direct` адрес появляется и исчезает; `addr: 'a.b'` — `9003` |
| 11в | `t('vpn', 'failover', {on: 1, primary: 'нет'})` | `9003`; несуществующее имя латиницей — `9004` «нет профиля: …» |
| 12 | `t('vpn', 'config', {type: 'awg'})` | `PrivateKey = (скрыт)` |
| 13 | `t('nosuch')` | ошибка `9009` «Неизвестный модуль» |

Пункт 11 с `encrypt: true` проверяет расшифровку тела веб-сервером (в коде есть, на роутере не проверено).
Ключ в пункте 11 поддельный; если пакет AmneziaWG уже стоит, после проверки верните свой конфиг.

## 1а. Номер SIM (msisdn)

USSD в проверках не слать: кнопку «Узнать у оператора» (`query`) нажимает только пользователь.

| № | вызов | ожидается |
|---|---|---|
| 1 | `t('msisdn')` | `iccid` вашей SIM, `plmn` код оператора, `ussd_code` код из `ussd-msisdn.txt`, `ussd_verified` 0 или 1, `source` none (или ваш номер), `auto_state` `unverified` после загрузки, если код не подтвержден на сайте оператора |
| 2 | `t('msisdn', 'set', {number: '8 (999) 123-45-67'})` | `number` в виде +7XXXXXXXXXX, `source` manual, `cache_iccid_match` 1; на роутере `/online/mod/conf/msisdn` = `<ICCID> +7XXXXXXXXXX` (root:1000 0644) — подставьте свой номер |
| 3 | `t('msisdn', 'set', {number: '12345'})` | `9003` |
| 4 | `t('msisdn', 'parse', {text_b64: btoa('Vash nomer: 8 900 765-43-21')})` | `number` 11 цифр с +7, `found` 1 |
| 5 | (пользователь) `t('msisdn', 'query')`, затем `t('msisdn')` раз в 2 с | `query_state` pending, потом done и номер с `source` ussd, или `sms` (номер придет в SMS), или failed |
| 6 | `t('msisdn')` после ответа `sms` | `ussd_senders` из `ussd-msisdn.txt`, `ussd_sent_local` — время отправки, `last_result` sms, `sms_reader` 0, если `sms_webhook` не поставлен |
| 7 | при `sms_reader` 1: `t('msisdn', 'sms')` | `found` 1 и номер в кэше, если SMS от отправителя оператора пришло после `ussd_sent_local`; новый USSD не уходит |

Подмена смены SIM на роутере (не трогает настоящий кэш):

```sh
ssh … root@192.168.1.1 'cd /var/modhelper; T=/online/mod/test; echo "89000000000000000000 00000000000" > $T/msisdn;
  MSISDN_CACHE=$T/msisdn MSISDN_SRC=$T/msisdn.src $T/lt-root.sh msisdn.show; busyboxx rm -f $T/msisdn'
# ожидается: source none, cache_iccid_match 0
```

Автозапрос без отправки USSD: переменные `USSD_FAKE` (файл с «ответом оператора»; пустой — ошибка),
`USSD_TABLE`, `MSISDN_DELAYS`, `MSISDN_CACHE`, `MSISDN_SRC`, `MSISDN_STATE` у `lt-root.sh`.

## 2. После смены имени на modem.lan

| проверка | как | ожидается |
|---|---|---|
| поля проверки | `t('lanname')` | `dns_ok` 1 и `web_ok` 1 |
| DNS роутера | `ssh … 'busyboxx chpst -u 1000:1000 /online/mod/test/lt.sh lanname.resolve name=modem.lan'` | `dns_ip` 192.168.1.1 |
| браузер | открыть `http://modem.lan/` | панель, без ухода на `192.168.1.1/html/index.html?origin=…` |
| вход | войти по `http://modem.lan/` | вход проходит |
| DHCP | переподключить клиента к Wi-Fi | клиент получает домен `lan` |

Если `web_ok` 0 — веб не взял новое имя без перезапуска (по коду должен был взять: имя читается на каждый запрос).
Если `dns_ok` 0 — стоковый `/app/bin/dns` не получил новое имя: нужен перезапуск `dns` или перезагрузка роутера.

## 3. Сторож помощника

```sh
ssh … root@192.168.1.1 'kill $(busyboxx cat /var/modhelper/qd.pid)'
```

В течение 30–65 с `t('helper')` отвечает `9001` «Помощник не запущен или не отвечает» — в панели должен быть
этот текст, а не «Нет прав». Потом сторож перезапускает очередь, и `t('helper')` снова отвечает.
Журнал: `t('logs', 'get', {id: 'helper', lines: 10})` — строки `wd очередь не ответила (1)`, `(2)`, `qd перезапущен`.

## 4. Остальное

| вызов | ожидается |
|---|---|
| `t('signal')` | `<stock>…`, `hcsq_mode`, `rsrp_dbm`, `band`, `earfcn_dl`, `output`; около 4 с |
| `t('cell')` | `enabled`, `pci`, `cur_pci`, `cur_earfcn` (только чтение NV 53810) |
| `t('ttl')`, `t('spe')` | `enabled`, `active`; `disabled` |
| `t('ttl', 'set', {enable: 1})` | то же, что `t('ttl')` (если уже 1 — повтор безопасен) |
| `t('scripts')` | список `/online/scripts` |
| `t('scripts', 'save', {name: 'test_t.sh', content_b64: btoa('#!/system/bin/busyboxx sh\necho "hi $1 <&>"\n')})` | `name` |
| `t('scripts', 'run', {name: 'test_t.sh', args: 'abc'})` | `rc` 0, `output` `hi abc <&>` |
| `t('scripts', 'run', {name: 'test_t.sh', args: 'a&b'})` | `9003` |
| `t('scripts', 'run', {name: 'test_t.sh', bg: 1})`, затем `t('scripts', 'result', {job: N})` | `job`, затем `running` 0, `rc` 0 |
| `t('scripts', 'delete', {name: 'test_t.sh'})` | `name` |
| `t('at')` | `mode` read, `blacklist` |
| `t('at', 'send', {cmd: 'AT^SYSCFGEX?'})` | `output` с `^SYSCFGEX:` |
| `t('at', 'send', {cmd: 'AT+CFUN=0'})` | `9008` |
| `t('at', 'send', {cmd: 'AT^NVWR=1,2'})` | `9002` |
| `t('wificountry')` | `country`, `autocountry` |
| `t('svc')` | пакеты с `running`, `enabled`, `info` |
| `t('logs')`; `t('logs', 'get', {id: 'helper', lines: 20})` | список; хвост журнала помощника |
| `t('radio')` | `mode`, `lte_mask`, `lte_bands` |
| `t('radio', 'set', {bands: '1,3,7'})` | `9008` (пока нет `/online/mod/helper/modem_write`) |
| `t('battery')` | `nobattery` |
| `t('battery', 'set', {nobattery: 0})` | `9008` (пока нет `/online/mod/helper/nv_write`) |

Пока идет `t('signal')` или `scripts run` без `bg`, стоковый веб в соседней вкладке не отвечает — так и должно быть
(веб-сервер однопоточный). Если ответ дольше 30 с — записать, какой вызов.

## Без входа и через SSH

```sh
curl -s http://192.168.1.1/api/vsim/config-vsim             # <error><code>100003</code>…
ssh … root@192.168.1.1 'busyboxx chpst -u 1000:1000 /online/mod/test/lt.sh helper.show'
ssh … root@192.168.1.1 'busyboxx sh /online/mod/helper/start.sh status'
```

`lt.sh` зовет помощника тем же путем, что Lua, `lt-root.sh` зовет обработчик помощника напрямую от root.
Их нет в установке: скопируйте `src/backend/tools/` в `/online/mod/test/` на роутере вручную, после проверки удалите.

## Бинарники без сети

`get-bins.sh` не должен обращаться к сети: заглушка `curl` останавливает скрипт, если ее вызовут.

```sh
mkdir -p /tmp/stub; printf '#!/bin/sh\nexit 99\n' > /tmp/stub/curl; chmod +x /tmp/stub/curl
PATH=/tmp/stub:$PATH src/pkg/get-bins.sh                # без ошибок
src/installer/install.sh --only=pkg --save=/tmp/pkg.tar  # 4 пакета в файле
```
