#!/usr/bin/env python3
"""Локальный сервер для разработки SPA.

Раздает dist/ по тем же путям, что роутер: оболочка на «/» (и /js/mod/index.html, /html/mod.html),
/js/mod/app.js, /css/mod/app.css; в оболочку после <head> вставляет два <meta name="csrf_token">, как веб роутера,
и отвечает на API:
  мок (по умолчанию):  /api/<путь>      ← dev/mock/stock/<путь>.xml
                       /api/mod/<имя>   ← dev/mock/mod/<имя>.xml (GET),
                                          dev/mock/mod/<имя>.<action>.xml | <имя>.post.xml | OK (POST)
  прокси:              --proxy http://192.168.1.1 — /api/* и токены берутся с настоящего роутера.

Запуск:  python3 dev/server.py [--port 8097] [--proxy http://192.168.1.1] [--password admin] [--build]
В режиме мока вход принимает любой пароль. Пароль --password (по умолчанию admin) проверяется по-настоящему:
для него сервер считает SCRAM сам и отдает настоящую подпись (так проверяется код входа в браузере).
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import random
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
FRONT = os.path.dirname(HERE)
DIST = os.environ.get('MYWEBUI_DIST') or os.path.join(FRONT, 'dist')
STOCK = os.path.join(HERE, 'mock', 'stock')
MOD = os.path.join(HERE, 'mock', 'mod')

try:  # RSA для расшифровки тел ;enc (проверка шифрования в браузере). Без библиотеки — тела не читаются.
    from cryptography.hazmat.primitives.asymmetric import rsa, padding
    from cryptography.hazmat.primitives import hashes
    RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    _pn = RSA_KEY.public_key().public_numbers()
    RSA_N = format(_pn.n, 'x')
    RSA_E = '010001'
except Exception:  # noqa: BLE001
    RSA_KEY = None
    RSA_N = 'c1' * 256
    RSA_E = '010001'

TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
         '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml',
         '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'}

# без входа отвечают (как на роутере)
PUBLIC = {'user/state-login', 'global/module-switch', 'monitoring/status', 'net/current-plmn', 'time/timeout',
          'monitoring/converged-status', 'webserver/publickey', 'webserver/token', 'webserver/SesTokInfo',
          'device/basic_information', 'pin/status', 'monitoring/check-notifications', 'user/challenge_login',
          'user/authentication_login', 'user/logout', 'language/current-language'}


def xml_ok():
    return '<?xml version="1.0" encoding="UTF-8"?><response>OK</response>'


def xml_err(code, extra=''):
    return '<?xml version="1.0" encoding="UTF-8"?><error><code>%s</code><message></message>%s</error>' % (code, extra)


def xml_resp(d):
    body = ''.join('<%s>%s</%s>' % (k, v, k) for k, v in d.items())
    return '<?xml version="1.0" encoding="UTF-8"?><response>%s</response>' % body


class State:
    lock = threading.Lock()
    logged_in = False
    user = ''
    tokens = set()
    scram = {}          # firstnonce/servernonce/salt/iter
    overrides = {}      # путь → {поле: значение} из POST (мок «запоминает» сохраненное)
    started = time.time()
    log_posts = []


def new_token():
    t = secrets.token_urlsafe(24)[:32]
    State.tokens.add(t)
    return t


def scram_server(password, salt, iters, auth_msg):
    sp = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, iters, 32)
    ck = hmac.new(b'Client Key', sp, hashlib.sha256).digest()
    sk = hmac.new(b'Server Key', sp, hashlib.sha256).digest()
    stored = hashlib.sha256(ck).digest()
    csig = hmac.new(auth_msg.encode(), stored, hashlib.sha256).digest()
    proof = bytes(a ^ b for a, b in zip(ck, csig)).hex()
    ssig = hmac.new(auth_msg.encode(), sk, hashlib.sha256).hexdigest()
    pubsig = hmac.new(sk, bytes.fromhex(RSA_N), hashlib.sha256).hexdigest()
    return proof, ssig, pubsig


def rsa_decrypt_body(hexbody):
    if not RSA_KEY:
        return None
    k = 512
    out = ''
    for i in range(0, len(hexbody), k):
        chunk = bytes.fromhex(hexbody[i:i + k])
        out += RSA_KEY.decrypt(chunk, padding.OAEP(mgf=padding.MGF1(hashes.SHA1()), algorithm=hashes.SHA1(), label=None)).decode()
    return base64.b64decode(out).decode('utf-8')


def parse_request(body, deep=False):
    """Поля запроса. deep=True — все листья (первое вхождение имени), для вложенных Ssids/Ssid."""
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return {}
    if not deep:
        return {c.tag: (c.text or '') for c in root if len(c) == 0}
    out = {}
    for el in root.iter():
        if el is not root and len(el) == 0 and el.tag not in out:
            out[el.tag] = el.text or ''
    return out


def xml_unescape(t):
    return (t.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&apos;', "'")
            .replace('&#39;', "'").replace('&amp;', '&'))


def esc(t):
    return (t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
            .replace("'", '&apos;'))


def rsa_decrypt_fields(body):
    """;enp — поля зашифрованы по отдельности (hex, кратно 512)."""
    def dec(m):
        try:
            return '<%s>%s</%s>' % (m.group(1), rsa_decrypt_body(m.group(2)), m.group(1))
        except Exception as e:  # noqa: BLE001
            sys.stderr.write('  поле %s НЕ расшифровано: %s\n' % (m.group(1), e))
            return m.group(0)
    return re.sub(r'<(\w+)>([0-9a-f]{512,})</\1>', dec, body)


def read_mock(path):
    if not os.path.isfile(path):
        return None
    with open(path, encoding='utf-8') as f:
        return f.read()


def apply_overrides(rel, text):
    ov = State.overrides.get(rel)
    if not ov:
        return text
    for k, v in ov.items():
        if k in ('WifiWpapsk', 'MixWifiWpapsk'):  # сток не отдает пароль в GET
            continue
        text, n = re.subn(r'<%s>[^<]*</%s>' % (re.escape(k), re.escape(k)), '<%s>%s</%s>' % (k, v, k), text, count=1)
    return text


def jitter(rel, text):
    """Живые числа для страниц сигнала и сводки."""
    t = time.time() - State.started
    if rel == 'device/signal':
        rsrp = -95 + 8 * __import__('math').sin(t / 9) + random.uniform(-2, 2)
        sinr = 9 + 7 * __import__('math').sin(t / 7) + random.uniform(-1.5, 1.5)
        rsrq = -11 + 3 * __import__('math').sin(t / 11) + random.uniform(-1, 1)
        rssi = rsrp + 26
        text = re.sub(r'<rsrp>[^<]*</rsrp>', '<rsrp>%ddBm</rsrp>' % round(rsrp), text)
        text = re.sub(r'<sinr>[^<]*</sinr>', '<sinr>%ddB</sinr>' % round(sinr), text)
        text = re.sub(r'<rsrq>[^<]*</rsrq>', '<rsrq>%ddB</rsrq>' % round(rsrq), text)
        text = re.sub(r'<rssi>[^<]*</rssi>', '<rssi>%ddBm</rssi>' % round(rssi), text)
    elif rel == 'monitoring/traffic-statistics':
        dl = int(1.2e6 + 9e5 * abs(__import__('math').sin(t / 13)))
        ul = int(1.5e5 + 1e5 * abs(__import__('math').sin(t / 8)))
        text = re.sub(r'<CurrentDownloadRate>[^<]*<', '<CurrentDownloadRate>%d<' % dl, text)
        text = re.sub(r'<CurrentUploadRate>[^<]*<', '<CurrentUploadRate>%d<' % ul, text)
        text = re.sub(r'<CurrentConnectTime>[^<]*<', '<CurrentConnectTime>%d<' % (5321 + int(t)), text)
    return text


SERVERS = [  # мок списка серверов теста скорости (настоящий список — /online/mod/helper/speedtest-servers.txt, docs/API.md)
    ('selectel', 'Selectel', 'RU', 'http://speedtest.selectel.ru/10MB', 0, 95),
    ('example-https', 'Пример HTTPS', 'RU', 'https://speed.example.ru/10MB', 1, 80),
    ('example-kz', 'Пример', 'KZ', 'http://kz.example.kz/10MB', 0, 60),
]


def mock_speedtest(action, req):
    """Замер (docs/API.md, speedtest): при auto 2 с выбора сервера; прием 30 точек раз в 250 мс; при direction=both — отдача
    еще 30 точек (сервер example-kz отдачу не поддерживает и дает короткий прием из 2 точек); via=awg — через туннель
    (ЦП 40–70 %, via=awg0 и vpn_label активного профиля). Итог с cpu_avg/cpu_max, up_*; history — последние замеры."""
    now = time.time()
    if not hasattr(State, 'speed'):
        State.speed = {'start': 0, 'server': SERVERS[0][0], 'auto': False, 'url': SERVERS[0][3], 'via': '', 'both': False, 'label': ''}
        State.speed_hist = []
    st = State.speed
    if action == 'servers':
        body = ''.join('<server><id>%s</id><name>%s</name><country>%s</country><url>%s</url><size_bytes>10485760</size_bytes>'
                       '<range>1</range><https>%d</https><median_mbps>%d</median_mbps></server>' % x for x in SERVERS)
        return '<?xml version="1.0" encoding="UTF-8"?><response><curl>1</curl><servers>%s</servers></response>' % body
    if action == 'run':
        via = req.get('via', '')
        label = ''
        if via == 'awg':
            a = getattr(State, 'awg', None)
            prs = getattr(State, 'awg_profiles', [['awg2', '', '1', 'AWG2 · Дом', '2.0']])
            if a is not None and a.get('up') != '1':
                return xml_err(9006, '<message>Туннель AmneziaWG не поднят</message>')
            label = next((x[3] for x in prs if x[2] == '1'), '')
        sid = req.get('server') or ('' if req.get('url') else 'auto')
        srv = SERVERS[0][0] if sid in ('auto', '') else sid
        st.update(streams=int(req.get('streams') or 4), start=now, auto=sid == 'auto', server=srv, via=via, label=label, both=req.get('direction') == 'both', done=False,
                  url=req.get('url') or dict((x[0], x[3]) for x in SERVERS).get(srv, SERVERS[0][3]))
        return xml_resp({'status': 'running', 'server': sid or 'custom', 'url': st['url']})
    hist = '<history>%s</history>' % ''.join(State.speed_hist[:10])
    if not st['start']:
        return xml_resp({'status': 'none'}).replace('</response>', hist + '</response>')
    short = st['server'] == 'example-kz'
    up_ok = st['both'] and not short
    dur = 0.5 if short else 7.5
    t = now - st['start'] - (2 if st['auto'] else 0)
    name = dict((x[0], x[1]) for x in SERVERS).get(st['server'], '')
    lo, hi = (40, 70) if st['via'] else (80, 99)
    random.seed(int(st['start']))
    n_all = 2 if short else 30
    mk = lambda base: [(round((i + 1) * 0.25, 2), int(random.uniform(lo, hi)), int(base + base * 0.4 * min(1, (i + 1) / 12) + random.uniform(-800, 800)))
                       for i in range(n_all)]
    pts = mk(9000 if not st['via'] else 6000)
    ups = mk(3000 if not st['via'] else 2000)
    mt_down, mt_up = mk(15000 if not st['via'] else 8000), mk(5000 if not st['via'] else 3000)
    random.seed()
    ser = lambda tag, arr, n: '<%s>%s</%s>' % (tag, ''.join('<s><t>%s</t><cpu_pct>%d</cpu_pct><kbps>%d</kbps></s>' % p for p in arr[:n]), tag)
    base = {'server': st['server'], 'name': name, 'url': st['url']}
    base.update(via='awg', vpn_label=st['label']) if st['via'] else base.update(via='direct')
    if t < 0:
        return xml_resp({'status': 'running', 'phase': 'select'})
    # несколько потоков: прием, прием в потоках, отдача, отдача в потоках; время точек сквозное
    streams = st.get('streams', 1) if up_ok else 1
    move = lambda arr, k: [(round(x[0] + k * dur, 2), x[1], x[2]) for x in arr]
    four = [('download', pts), ('download_mt', move(mt_down, 1)), ('upload', move(ups, 2)), ('upload_mt', move(mt_up, 3))]
    ser4 = lambda tag, items, upto: '<%s>%s</%s>' % (tag, ''.join('<s><phase>%s</phase><t>%s</t><cpu_pct>%d</cpu_pct><kbps>%d</kbps></s>' % ((ph,) + p)
                                                                 for ph, arr in items for p in arr if p[0] <= upto), tag)
    if streams > 1 and t < 4 * dur:
        i = int(t // dur)
        ph, arr = four[i]
        n = min(n_all, int((t - i * dur) / 0.25))
        r = dict(base, status='running', phase=ph, streams=streams, elapsed_s=round(t - i * dur, 1))
        if n:
            r.update(cur_cpu_pct=arr[n - 1][1], cur_kbps=arr[n - 1][2])
        if i >= 2:
            r.update(up_server=st['server'], up_name=name)
        return xml_resp(r).replace('</response>', ser4('samples', four[:2], t) + ser4('up_samples', four[2:], t) + '</response>')
    if t < dur:
        n = min(n_all, int(t / 0.25))
        r = dict(base, status='running', phase='download', elapsed_s=pts[n - 1][0] if n else 0)
        if n:
            r.update(cur_cpu_pct=pts[n - 1][1], cur_kbps=pts[n - 1][2])
        return xml_resp(r).replace('</response>', ser('samples', pts, n) + '</response>')
    if up_ok and t < 2 * dur:
        if t - dur < 0.6:
            return xml_resp(dict(base, status='running', phase='select_up')).replace('</response>', ser('samples', pts, n_all) + '</response>')
        n = min(n_all, int((t - dur) / 0.25))
        r = dict(base, status='running', phase='upload', up_server=st['server'], up_name=name, elapsed_s=ups[n - 1][0] if n else 0)
        if n:
            r.update(cur_cpu_pct=ups[n - 1][1], cur_kbps=ups[n - 1][2])
        return xml_resp(r).replace('</response>', ser('samples', pts, n_all) + ser('up_samples', ups, n) + '</response>')
    cand = '<candidates><c><id>selectel</id><connect_ms>%d</connect_ms></c><c><id>example-kz</id><connect_ms>-</connect_ms></c></candidates>' % (109 if st['via'] else 35) if st['auto'] else ''
    res = dict(base, status='ok', ip='188.93.16.19', window_s=5.5, traffic_mb=25.4 if not short else 1.1, speed_kbps=int(sum(p[2] for p in pts) / len(pts)),
               bytes=10485760 if not short else 800000, seconds=7.5 if not short else 0.5, time=int(st['start'] + 10), output='')
    if not short:
        res.update(cpu_avg=round(sum(p[1] for p in pts) / len(pts)), cpu_max=max(p[1] for p in pts))
    if up_ok:
        res.update(up_status='ok', up_server=st['server'], up_name=name, up_mode='chunks', up_requests=8, up_connections=1, up_kbps=int(sum(p[2] for p in ups) / len(ups)), up_cpu_avg=round(sum(p[1] for p in ups) / len(ups)), up_cpu_max=max(p[1] for p in ups))
    elif st['both']:
        res.update(up_supported=0)
    if not st.get('done'):
        st['done'] = True
        State.speed_hist.insert(0, '<item><time>%d</time><via>%s</via><vpn_label>%s</vpn_label><server>%s</server><name>%s</name><speed_kbps>%d</speed_kbps><up_kbps>%s</up_kbps>%s</item>'
                                % (res['time'], res.get('via', ''), esc(res.get('vpn_label', '')), st['server'], name, res['speed_kbps'], res.get('up_kbps', ''),
                                   '<streams>%d</streams><mt_kbps>%d</mt_kbps><up_mt_kbps>%d</up_mt_kbps>' % (streams, sum(p[2] for p in mt_down) / n_all, sum(p[2] for p in mt_up) / n_all) if streams > 1 else ''))
    hist = '<history>%s</history>' % ''.join(State.speed_hist[:10])
    if streams > 1:
        res.update(streams=streams, mt_streams=streams, mt_kbps=int(sum(p[2] for p in mt_down) / n_all), mt_cpu_avg=round(sum(p[1] for p in mt_down) / n_all), mt_cpu_max=max(p[1] for p in mt_down),
                   up_mt_kbps=int(sum(p[2] for p in mt_up) / n_all), up_mt_cpu_avg=round(sum(p[1] for p in mt_up) / n_all), up_mt_cpu_max=max(p[1] for p in mt_up), mt_error='', up_mt_error='')
        return xml_resp(res).replace('</response>', cand + ser4('samples', four[:2], 1e9) + ser4('up_samples', four[2:], 1e9) + hist + '</response>')
    return xml_resp(res).replace('</response>', cand + ser('samples', pts, n_all) + (ser('up_samples', ups, n_all) if up_ok else '') + hist + '</response>')


DNS_PRESETS = [('auto', 'Авто: Cloudflare (DoT)'), ('cloudflare-dot', 'Cloudflare (DoT)'), ('cloudflare-doh', 'Cloudflare (DoH)'),
               ('quad9-dot', 'Quad9 (DoT)'), ('adguard-dot', 'AdGuard, с блокировкой рекламы (DoT)'),
               ('operator', 'DNS оператора (подменяет ответы)'), ('custom', 'Свой сервер')]


def mock_svc_dns(action, req):
    """svc: dns — живое состояние (как svc.sh пакета dns): выбор не запускает службу, custom требует адрес."""
    if not hasattr(State, 'dns'):
        State.dns = {'running': '0', 'enabled': '0', 'preset': 'auto', 'adblock': '0', 'custom': ''}
    d = State.dns
    if action == 'dns_preset':
        if req.get('id') not in [x[0] for x in DNS_PRESETS]:
            return xml_err(9003, '<message>Неверное значение: id</message>')
        if req['id'] == 'custom' and not d['custom']:
            return '<?xml version="1.0" encoding="UTF-8"?><error><code>9004</code><message>для пресета custom сначала задайте адрес: set-custom АДРЕС</message></error>'
        d['preset'] = req['id']
    elif action == 'dns_custom':
        a = req.get('addr', '')
        if not re.match(r'^(https://[A-Za-z0-9.-]+(/[A-Za-z0-9._-]+)*/dns-query|tls://[A-Za-z0-9.-]+|\d+\.\d+\.\d+\.\d+)$', a):
            return xml_err(9003, '<message>Неверное значение: addr</message>')
        d['custom'] = a
    elif action == 'dns_adblock':
        if req.get('on') not in ('0', '1'):
            return xml_err(9003, '<message>Неверное значение: on</message>')
        d['adblock'] = req['on']
    elif action == 'dns_enable':
        d.update(running='1', enabled='1', user_off='0')
    elif action == 'dns_disable':
        d.update(running='0', enabled='0', user_off='1')
    elif action == 'start':
        d['running'] = '1'
    elif action == 'stop':
        d['running'] = '0'
    elif action == 'enable':
        d['enabled'] = '1'
    elif action == 'disable':
        d['enabled'] = '0'
    label = dict(DNS_PRESETS)[d['preset']]
    shown = re.sub(r'^(https://[^/]+)/.+/dns-query$', '\\1/…/dns-query', d['custom'])
    presets = ''.join('<dns_preset><id>%s</id><label>%s</label><active>%d</active></dns_preset>' % (i, l, i == d['preset']) for i, l in DNS_PRESETS)
    state = ('<dns_upstream>preset</dns_upstream><dns_fallback>0</dns_fallback><user_off>%s</user_off>' % d.get('user_off', '0')) + ('<running>%s</running><enabled>%s</enabled><info>%s</info><preset>%s</preset><preset_label>%s</preset_label><adblock>%s</adblock><recommended>cloudflare-dot</recommended><custom_addr>%s</custom_addr><presets>%s</presets>'
             % (d['running'], d['enabled'], 'работает' if d['running'] == '1' else 'остановлена', d['preset'], label, d['adblock'], shown, presets))
    if action != 'show':
        return '<?xml version="1.0" encoding="UTF-8"?><response><name>dns</name><rc>0</rc>%s<output></output></response>' % state
    block = '<service><name>dns</name><desc>DNS: блокировка рекламы</desc>%s</service>' % state
    return re.sub(r'<service><name>dns</name>.*?</service>', lambda _: block, read_mock(os.path.join(MOD, 'svc.xml')), flags=re.S)


def mock_vpn(action, req):
    """VPN: wg и ovpn — из dev/mock/mod/vpn.xml, awg — живое состояние (start/stop/autostart/dns/setconf)."""
    base = read_mock(os.path.join(MOD, 'vpn.xml')) or '<response></response>'
    if not hasattr(State, 'awg'):
        m = re.search(r'<awg>(.*?)</awg>', base, re.S)
        State.awg = {k: v for k, v in re.findall(r'<(\w+)>([^<]*)</\1>', m.group(1))} if m else {}
    a = State.awg
    if not hasattr(State, 'awg_profiles'):  # профили: имя, сервер без ключей, активный
        State.awg_profiles = [['awg2', 'vpn1.example.net', '1', 'AWG2 · Дом', '2.0'], ['awg3_1', 'vpn2.example.net', '0', 'AWG3.1 · Работа', '3.1']]
    pr = State.awg_profiles
    if action == 'profile_use':
        if not any(x[0] == req.get('name') for x in pr):
            return xml_err(9006, '<message>Не найдено: %s</message>' % req.get('name'))
        for x in pr:
            x[2] = '1' if x[0] == req.get('name') else '0'
    elif action == 'profile_delete':
        if any(x[0] == req.get('name') and x[2] == '1' for x in pr):
            return xml_err(9002, '<message>Действие запрещено: активный профиль не удаляется</message>')
        State.awg_profiles = pr = [x for x in pr if x[0] != req.get('name')]
    elif action == 'setconf' and req.get('name'):
        if not re.match(r'^[a-z0-9_-]{1,32}$', req['name']):
            return xml_err(9003, '<message>Неверное значение: name</message>')
        if not any(x[0] == req['name'] for x in pr):
            pr.append([req['name'], 'new.example.net', '0', req.get('label', ''), '3.1'])
    elif action == 'profile_label':
        for x in pr:
            if x[0] == req.get('name'):
                x[3] = req.get('label', '')
    if action == 'start':
        a['up'] = '1'
    elif action == 'stop':
        a['up'] = '0'
    elif action == 'autostart':
        a['autostart'] = '1' if req.get('enable') == '1' else '0'
    elif action == 'dns':
        on = req.get('on') == '1'
        a.update(dns_mode='tunnel' if on else 'operator', dns_server='1.1.1.1' if on else '')
    elif action == 'setconf':
        a['configured'] = '1'
    for k, v in (('split', '1'), ('split_list', '0'), ('split_prefixes', '0'), ('split_date', ''), ('failover', '1'), ('primary', 'awg2'), ('failover_reason', 'ok')):
        a.setdefault(k, v)
    if not hasattr(State, 'split_ex'):
        State.split_ex = {'split_direct': [], 'split_vpn': []}
    fail = lambda text: '<?xml version="1.0" encoding="UTF-8"?><error><code>9004</code><message>%s</message></error>' % text
    if action == 'split':
        if req.get('on') == '1' and a['split_list'] != '1':
            return fail('нет списка российских адресов: загрузите файл')
        a['split'] = '1' if req.get('on') == '1' else '0'
    elif action == 'split_update':
        if len(req.get('list_b64', '')) > 360000:
            return xml_err(9003, '<message>Неверное значение: list_b64</message>')
        text = base64.b64decode(req.get('list_b64', '')).decode('utf-8', 'replace')
        lines = [x.strip() for x in text.splitlines() if x.strip() and not x.startswith('#')]
        bad = next((i + 1 for i, x in enumerate(lines) if not re.match(r'^\d+\.\d+\.\d+\.\d+/\d+$', x)), 0)
        if bad or not lines:
            return fail('строка %d: неверная подсеть' % bad if bad else 'в списке 0 префиксов, нужно от 1 до 20000')
        a.update(split_list='1', split_prefixes=str(len(lines)), split_date='2026-10-30')
    elif action in State.split_ex:
        items = State.split_ex[action]
        addr = req.get('addr', '')
        if req.get('op') not in ('add', 'del') or not re.match(r'^\d+\.\d+\.\d+\.\d+(/\d+)?$', addr):
            return xml_err(9003, '<message>Неверное значение: addr</message>')
        addr = addr if '/' in addr else addr + '/32'
        if req['op'] == 'add' and addr not in items:
            items.append(addr)
        elif req['op'] == 'del' and addr in items:
            items.remove(addr)
    elif action == 'failover':
        if req.get('on') == '1':
            if len(pr) < 2:
                return fail('нужно хотя бы два профиля')
            a.update(failover='1', primary=req.get('primary') or next((x[0] for x in pr if x[2] == '1'), ''), failover_reason='ok')
        else:
            a.update(failover='0', failover_reason='')
    up, on, has = a.get('up') == '1', a['split'] == '1', a['split_list'] == '1'
    a.update(split_active='1' if up and on and has else '0', split_reason='' if not on else 'no_list' if not has else 'tunnel_down' if not up else '',
             split_hint='DNS клиентов идет к оператору: заблокированные сайты не откроются. Включите пакет dns с пресетом auto.' if on and a.get('dns_mode') == 'operator' else '',
             split_direct=''.join('<addr>%s</addr>' % x for x in State.split_ex['split_direct']),
             split_vpn=''.join('<addr>%s</addr>' % x for x in State.split_ex['split_vpn']))
    if a['failover'] == '1':
        a['failover_reason'] = 'no_other_profile' if len(pr) < 2 else 'tunnel_down' if not up else 'ok' if a['failover_reason'] in ('tunnel_down', 'no_other_profile') else a['failover_reason']
    profiles = '<profiles>' + ''.join('<profile><name>%s</name><label>%s</label><proto>%s</proto><active>%s</active><endpoint_host>%s</endpoint_host></profile>'
                                      % (x[0], esc(x[3]), x[4], x[2], x[1]) for x in pr) + '</profiles>'
    act = next((x for x in pr if x[2] == '1'), None)
    profiles += '<active_profile>%s</active_profile><active_label>%s</active_label>' % ((act[0], esc(act[3])) if act else ('', ''))
    awg = '<awg>' + ''.join('<%s>%s</%s>' % (k, v, k) for k, v in a.items()) + profiles + '</awg>'
    if action == 'show':
        return re.sub(r'<awg>.*?</awg>', awg, base, flags=re.S)
    return '<?xml version="1.0" encoding="UTF-8"?><response>%s</response>' % awg


def mock_msisdn(action, req):
    """Номер SIM (docs/API.md, msisdn): начальное состояние из dev/mock/mod/msisdn.xml.
    query — 3 с pending, потом query_state=sms (номер придет в SMS, sms_reader=0 — разбирает страница);
    parse — номер из текста; set — сохраняет."""
    if not hasattr(State, 'msisdn'):
        State.msisdn = parse_request(read_mock(os.path.join(MOD, 'msisdn.xml')) or '<r/>')
        State.msisdn['q'] = 0
    m = State.msisdn
    if action == 'parse':
        try:
            text = base64.b64decode(req.get('text_b64', '')).decode('utf-8')
        except Exception:  # noqa: BLE001
            return xml_err(9003, '<message>Неверное значение: text_b64</message>')
        mm = re.search(r'(\+?\d[\d\s\-()]{8,18}\d)', text)
        d = re.sub(r'\D', '', mm.group(1)) if mm else ''
        if len(d) == 11 and d[0] in '78':
            d = '7' + d[1:]
        elif len(d) == 10:
            d = '7' + d
        return xml_resp({'number': '+' + d if 10 <= len(d) <= 15 else '', 'found': 1 if d else 0})
    if action == 'query':
        # время отправки позже всех SMS мока: новое SMS еще не пришло, старое SMS оператора не подходит
        m.update(query_state='pending', q=time.time(), ussd_sent_at=int(time.time()), ussd_sent_local='2026-10-29 17:10:00')
    elif action == 'set':
        m.update(number=req.get('number', ''), source=req.get('source', 'manual'), cache_iccid_match=1, auto_state='done', query_state='done')
    if m.get('query_state') == 'pending' and time.time() - m['q'] > 3:
        m.update(query_state='sms', last_result='sms')
    return xml_resp({k: v for k, v in m.items() if k != 'q'})


class H(BaseHTTPRequestHandler):
    server_version = 'mywebui-dev'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *a):
        if self.server.args.quiet:
            return
        sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % a))

    # --- ответы ---
    def send(self, code, body, ctype='text/xml; charset=utf-8', headers=None):
        data = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate')
        # как у роутера: data: URI запрещены
        self.send_header('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval'")
        self.send_header('X-Content-Type-Options', 'nosniff')
        for k, v in (headers or {}).items():
            if isinstance(v, list):
                for x in v:
                    self.send_header(k, x)
            else:
                self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n).decode('utf-8', 'replace') if n else ''

    # --- статика ---
    def static(self, path):
        # на роутере оболочка SPA стоит вместо /app/html/redirect.html и открывается на «/»; копия — /js/mod/index.html
        if path in ('/', '/index.html', '/js/mod/index.html'):
            path = '/html/mod.html'
        if path == '/html/index.html':
            self.send(200, '<!DOCTYPE html><meta charset="utf-8"><title>Сток</title><p>Стоковый интерфейс есть только на роутере: '
                           'http://192.168.1.1/html/index.html. <a href="/">Назад</a></p>', 'text/html; charset=utf-8')
            return
        fp = os.path.normpath(os.path.join(DIST, path.lstrip('/')))
        if not fp.startswith(DIST) or not os.path.isfile(fp):
            self.send(404, 'not found', 'text/plain; charset=utf-8')
            return
        with open(fp, 'rb') as f:
            data = f.read()
        ctype = TYPES.get(os.path.splitext(fp)[1], 'application/octet-stream')
        headers = {}
        if fp.endswith('mod.html'):
            html = data.decode('utf-8')
            if self.server.args.proxy:
                metas, cookies = self.proxy_tokens()
                headers['Set-Cookie'] = cookies
            else:
                metas = ''.join('<meta name="csrf_token" content="%s">' % new_token() for _ in range(2))
                metas += '<script>window.M_DEV_MOCK=1</script>'
            html = html.replace('<head>', '<head>\n' + metas, 1)
            data = html.encode('utf-8')
        self.send(200, data, ctype, headers)

    # --- прокси на роутер ---
    def proxy_tokens(self):
        base = self.server.args.proxy.rstrip('/')
        req = urllib.request.Request(base + '/html/index.html', headers={'Cookie': self.headers.get('Cookie', '')})
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                html = r.read().decode('utf-8', 'replace')
                cookies = [c.replace('HttpOnly;', 'HttpOnly') for c in r.headers.get_all('Set-Cookie') or []]
        except Exception as e:  # noqa: BLE001
            sys.stderr.write('proxy: %s\n' % e)
            return '', []
        metas = ''.join(re.findall(r'<meta name="csrf_token"[^>]*>', html))
        return metas, cookies

    def proxy(self, method):
        base = self.server.args.proxy.rstrip('/')
        body = self.body().encode('utf-8') if method == 'POST' else None
        hdr = {}
        for k in ('Cookie', 'Content-Type', '__RequestVerificationToken', '_ResponseSource', 'X-Requested-With'):
            if self.headers.get(k):
                hdr[k] = self.headers.get(k)
        hdr['Referer'] = base + '/html/index.html'
        req = urllib.request.Request(base + self.path, data=body, headers=hdr, method=method)
        try:
            r = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            r = e
        except Exception as e:  # noqa: BLE001
            self.send(502, 'router: %s' % e, 'text/plain; charset=utf-8')
            return
        data = r.read()
        out = {}
        for k, v in r.headers.items():
            lk = k.lower()
            if lk.startswith('__requestverificationtoken'):
                out[k] = v
        cookies = r.headers.get_all('Set-Cookie') or []
        if cookies:
            out['Set-Cookie'] = cookies
        self.send(r.status, data, r.headers.get('Content-Type', 'text/xml'), out)

    # --- мок ---
    def mock(self, method):
        path = self.path.split('?')[0]
        rel = path[len('/api/'):].strip('/')
        body = self.body() if method == 'POST' else ''
        headers = {}
        with State.lock:
            if method == 'POST':
                tok = self.headers.get('__RequestVerificationToken', '')
                if tok not in State.tokens:
                    self.send(200, xml_err(125001), headers={'__RequestVerificationToken': new_token()})
                    return
                State.tokens.discard(tok)
                if (self.headers.get('Content-Type') or '').split(';')[-1].strip() == 'enp':
                    body = rsa_decrypt_fields(body)
                    sys.stderr.write('  поля расшифрованы (%s): %s\n' % (rel, body[:300]))
                if (self.headers.get('Content-Type') or '').split(';')[-1].strip() == 'enc':
                    try:
                        dec = rsa_decrypt_body(body)
                        sys.stderr.write('  расшифровано (%s): %s\n' % (rel, dec))
                        body = dec or ''
                    except Exception as e:  # noqa: BLE001
                        sys.stderr.write('  НЕ расшифровано (%s): %s\n' % (rel, e))
                        self.send(200, xml_err(100005))
                        return
                State.log_posts.append((rel, body))
            if not State.logged_in and rel not in PUBLIC and not rel.startswith('mod/') and rel != 'vsim/config-vsim' and not self.server.args.open:
                self.send(200, xml_err(100003))
                return
            resp = self.mock_special(method, rel, body, headers)
            if resp is None:
                resp = self.mock_file(method, rel, body)
            if method == 'POST' and not headers:
                headers['__RequestVerificationToken'] = new_token()
        if self.server.args.delay:
            time.sleep(self.server.args.delay / 1000.0)
        self.send(200, resp, headers=headers)

    def mock_special(self, method, rel, body, headers):
        args = self.server.args
        if rel == 'webserver/token':
            return xml_resp({'token': secrets.token_hex(16) + new_token()})
        if rel == 'webserver/SesTokInfo':
            return xml_resp({'SesInfo': 'SessionID=mock', 'TokInfo': new_token()})
        if rel == 'webserver/publickey':
            return xml_resp({'encpubkeye': RSA_E, 'encpubkeyn': RSA_N})
        if rel == 'user/state-login':
            return xml_resp({'State': 0 if State.logged_in else -1, 'Username': State.user if State.logged_in else '',
                             'userlevel': 2 if State.logged_in else '', 'firstlogin': 1, 'rsapadingtype': 1,
                             'password_type': 4, 'extern_password_type': 1, 'history_login_flag': 0,
                             'wifipwdsamewithwebpwd': 0})
        if rel == 'user/challenge_login' and method == 'POST':
            req = parse_request(body)
            salt = secrets.token_bytes(32)
            sn = req.get('firstnonce', '') + secrets.token_hex(32)
            State.scram = {'first': req.get('firstnonce', ''), 'sn': sn, 'salt': salt, 'iter': 100,
                           'user': req.get('username', '')}
            return xml_resp({'salt': salt.hex(), 'iterations': 100, 'servernonce': sn, 'modeselected': 1, 'newType': 0})
        if rel == 'user/authentication_login' and method == 'POST':
            req = parse_request(body)
            s = State.scram
            if not s or req.get('finalnonce') != s.get('sn'):
                return xml_err(108006, '<count>1</count>')
            auth_msg = '%s,%s,%s' % (s['first'], s['sn'], s['sn'])
            proof, ssig, pubsig = scram_server(args.password, s['salt'], s['iter'], auth_msg)
            match = proof == req.get('clientproof')
            sys.stderr.write('  SCRAM: доказательство %s паролем «%s»\n' % ('СОВПАЛО с' if match else 'не совпало с', args.password))
            State.logged_in = True
            State.user = s.get('user') or 'admin'
            one, two = new_token(), new_token()
            many = '#'.join([one, two] + [new_token() for _ in range(30)])
            headers['__RequestVerificationTokenone'] = one
            headers['__RequestVerificationTokentwo'] = two
            headers['__RequestVerificationToken'] = many
            if match:
                return xml_resp({'serversignature': ssig, 'rsapubkeysignature': pubsig, 'rsan': RSA_N, 'rsae': RSA_E})
            return xml_resp({'serversignature': 'mock', 'rsapubkeysignature': 'mock', 'rsan': RSA_N, 'rsae': RSA_E})
        if rel == 'user/pwd' and method == 'POST':
            req = parse_request(body)
            try:
                ns = rsa_decrypt_body(req.get('nonce', ''))
            except Exception:  # noqa: BLE001
                return xml_err(100006)
            nonce, salt = ns[:64], ns[64:]
            it = 100
            sp = hashlib.pbkdf2_hmac('sha256', nonce.encode(), bytes.fromhex(salt), it, 32)
            key, iv, hk = sp[:16], sp[16:24] + b'\0' * 8, sp[24:32]
            pwd = State.overrides.get('wlan/multi-basic-settings', {}).get('WifiWpapsk', 'mockpass123')
            plain = ('<?xml version="1.0" encoding="UTF-8"?><response><Ssids><Ssid><Index>0</Index>'
                     '<WifiWpapsk>%s</WifiWpapsk><MixWifiWpapsk>%s</MixWifiWpapsk></Ssid></Ssids></response>'
                     % (esc(pwd), esc(pwd))).encode()
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            from cryptography.hazmat.primitives import padding as sympad
            pd = sympad.PKCS7(128).padder()
            data = pd.update(plain) + pd.finalize()
            e = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
            ct = (e.update(data) + e.finalize()).hex()
            return xml_resp({'pwd': ct, 'hash': hmac.new(hk, bytes.fromhex(ct), hashlib.sha256).hexdigest(), 'iter': it})
        if rel == 'user/logout' and method == 'POST':
            State.logged_in = False
            State.user = ''
            return xml_ok()
        return None

    def mock_file(self, method, rel, body):
        # свои вызовы на роутере идут одним POST на api/vsim/config-vsim с полем module
        if rel == 'vsim/config-vsim' and method == 'POST':
            req = parse_request(body)
            name, action = req.get('module', ''), req.get('action', 'show')
            if name == 'speedtest':
                return mock_speedtest(action, req)
            if name == 'msisdn':
                return mock_msisdn(action, req)
            if name == 'helper':   # флаги помощника: show и set {modem_write}/{nv_write}
                if not hasattr(State, 'helper'):
                    State.helper = parse_request(read_mock(os.path.join(MOD, 'helper.xml')) or '<r/>')
                for k in ('modem_write', 'nv_write'):
                    if action == 'set' and k in req:
                        if req[k] not in ('0', '1'):
                            return xml_err(9003, '<message>Неверное значение: %s</message>' % k)
                        State.helper[k] = req[k]
                return xml_resp(State.helper)
            if name == 'svc' and (action in ('show', 'dns_preset', 'dns_custom', 'dns_adblock', 'dns_enable', 'dns_disable') or req.get('name') == 'dns'):
                return mock_svc_dns(action, req)
            if name == 'vpn' and (action == 'show' or req.get('type') == 'awg' or action in ('split', 'split_update', 'split_direct', 'split_vpn', 'failover')):
                return mock_vpn(action, req)
            if name == 'sysinfo' and action == 'show':
                t = read_mock(os.path.join(MOD, 'sysinfo.xml'))
                if t is not None:  # живая загрузка ЦП для «Сводки» и шапки
                    cpu = 25 + 60 * abs(__import__('math').sin((time.time() - State.started) / 9))
                    t = re.sub(r'<cpu_pct>[^<]*</cpu_pct>', '', t).replace('<cpu_mhz>', '<cpu_pct>%d</cpu_pct><cpu_mhz>' % cpu, 1)
                    return t
            if action == 'show':
                return self.mock_file('GET', 'mod/' + name, body)
            return self.mock_file('POST', 'mod/' + name, body)
        if rel.startswith('mod/'):
            name = rel[4:]
            if method == 'GET':
                t = read_mock(os.path.join(MOD, name + '.xml'))
                if t is None:  # запасные моки каркаса (cell, wificountry) в dev/mock/stock/mod/
                    t = read_mock(os.path.join(STOCK, 'mod', name + '.xml'))
                return t if t is not None else xml_err(100002)
            action = parse_request(body).get('action', '')
            for cand in (name + '.' + action + '.xml', name + '.post.xml'):
                t = read_mock(os.path.join(MOD, cand))
                if t is not None:
                    return t
            return xml_ok()
        if method == 'GET':
            t = read_mock(os.path.join(STOCK, rel + '.xml'))
            if t is None:  # моки стока для страниц: dev/mock/mod/_stock
                t = read_mock(os.path.join(MOD, '_stock', rel + '.xml'))
            if t is None:
                return xml_err(100002)
            return jitter(rel, apply_overrides(rel, t))
        t = read_mock(os.path.join(STOCK, rel + '.post.xml'))
        if t is None:
            t = read_mock(os.path.join(MOD, '_stock', rel + '.post.xml'))
        if t is not None:
            return t
        req = parse_request(body, deep=True)
        if req:
            State.overrides.setdefault(rel, {}).update({k: v if k in ('WifiWpapsk', 'MixWifiWpapsk') else esc(xml_unescape(v))
                                                         for k, v in req.items()})
            if 'WifiWpapsk' in req:
                State.overrides[rel]['WifiWpapsk'] = xml_unescape(req['WifiWpapsk'])
        return xml_ok()

    # --- разводка ---
    def route(self, method):
        p = self.path.split('?')[0]
        if p.startswith('/config/'):  # стоковые файлы настроек веба (config/wifi/countryChannel.xml …)
            if self.server.args.proxy:
                self.proxy(method)
                return
            t = read_mock(os.path.join(STOCK, p.lstrip('/')))
            self.send(200 if t is not None else 404, t if t is not None else 'not found',
                      'text/xml; charset=utf-8' if t is not None else 'text/plain; charset=utf-8')
            return
        if p.startswith('/api/'):
            if self.server.args.proxy:
                self.proxy(method)
            else:
                self.mock(method)
            return
        if p == '/dev/state':
            self.send(200, json.dumps({'logged_in': State.logged_in, 'total': len(State.log_posts), 'posts': State.log_posts[-200:]},
                                      ensure_ascii=False), 'application/json; charset=utf-8')
            return
        self.static(p)

    def do_GET(self):
        self.route('GET')

    def do_HEAD(self):
        self.route('GET')

    def do_POST(self):
        self.route('POST')


def proxy_route_ok(url, dev):
    """Прокси только если адрес роутера идет через USB-интерфейс (иначе 192.168.1.1 может быть чужой сетью)."""
    host = re.sub(r'^\w+://', '', url).split('/')[0].split(':')[0]
    try:
        out = subprocess.run(['ip', 'route', 'get', host], capture_output=True, text=True, timeout=5).stdout
    except Exception as e:  # noqa: BLE001
        return False, 'ip route get: %s' % e
    m = re.search(r'\bdev (\S+)', out)
    got = m.group(1) if m else '?'
    return got == dev, 'маршрут до %s идет через %s, нужен %s' % (host, got, dev)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=8097)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--proxy', default='', help='адрес роутера, например http://192.168.1.1')
    ap.add_argument('--password', default='admin', help='пароль, для которого мок считает настоящий SCRAM')
    ap.add_argument('--open', action='store_true', help='мок: все отвечает без входа')
    ap.add_argument('--login', action='store_true', help='мок: сразу «вошли»')
    ap.add_argument('--delay', type=int, default=0, help='мок: задержка ответа, мс')
    ap.add_argument('--build', action='store_true', help='собрать перед запуском')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--pidfile', default='', help='записать сюда PID сервера (чтобы остановить его по PID, а не pkill -f)')
    ap.add_argument('--proxy-dev', default='wwx001e101f0000', help='интерфейс, через который должен идти адрес роутера')
    ap.add_argument('--proxy-any-route', action='store_true', help='не проверять маршрут до роутера')
    args = ap.parse_args()
    if args.proxy and not args.proxy_any_route:
        ok, why = proxy_route_ok(args.proxy, args.proxy_dev)
        if not ok:
            print('ВНИМАНИЕ: прокси выключен — %s. Работаю на моке.' % why, file=sys.stderr, flush=True)
            args.proxy = ''
    if args.build:
        subprocess.run([sys.executable, os.path.join(FRONT, 'build.py')], check=False)
    State.logged_in = args.login
    srv = ThreadingHTTPServer((args.host, args.port), H)
    if args.pidfile:
        with open(args.pidfile, 'w') as f:
            f.write(str(os.getpid()))
    srv.daemon_threads = True
    srv.args = args
    mode = 'прокси на ' + args.proxy if args.proxy else 'мок (dev/mock)'
    print('http://%s:%d/  — %s' % (args.host, args.port, mode), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
