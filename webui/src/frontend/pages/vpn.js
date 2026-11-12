// VPN: AmneziaWG, WireGuard и OpenVPN мода (M.mod('vpn'), docs/API.md) и стоковые L2TP/PPTP/IPsec (только состояние,
// настройка — на стоковой странице vpnsettings.html). Стоковые вызовы как в offweb js/vpnsettings.js:
// api/vpn/feature-switch, l2tp_settings, pptp_settings, ipsec_settings.

const TYPES = [
  {
    id: 'wg',
    title: 'WireGuard',
    about: 'Быстрый современный VPN. Нужен файл настроек от вашего VPN-сервиса или своего сервера ' +
      '(разделы [Interface] и [Peer]).',
    file: '/online/vpn.conf',
    sample: '[Interface]\nPrivateKey = …\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = …\nEndpoint = vpn.example.com:51820\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25\n',
  },
  {
    id: 'ovpn',
    title: 'OpenVPN',
    about: 'Работает почти везде, но медленнее WireGuard на этом процессоре. Нужен файл .ovpn ' +
      'с сертификатами внутри (<ca>, <cert>, <key>).',
    file: '/online/mod/vpn/openvpn.conf',
    sample: 'client\ndev tun\nproto udp\nremote vpn.example.com 1194\n…\n<ca>\n…\n</ca>\n',
  },
];

const STOCK = [
  ['l2tp_settings', 'L2TP'],
  ['pptp_settings', 'PPTP'],
  ['ipsec_settings', 'IPsec'],
];

// Ответ действия: состояние в <wg>/<ovpn> (docs/API.md) или плоско
const pick = (r, type) => {
  if (!r || typeof r !== 'object') return {};
  const x = r[type] && typeof r[type] === 'object' ? r[type] : r;
  const o = {};
  ['configured', 'up', 'autostart', 'autostart_mod'].forEach((k) => { if (x[k] !== undefined) o[k] = x[k]; });
  return o;
};

const b64 = (s) => (M.crypto && M.crypto.b64utf8 ? M.crypto.b64utf8(s) : btoa(unescape(encodeURIComponent(s))));

M.page({
  id: 'vpn',
  title: 'VPN',
  group: 'Безопасность',
  icon: 'key',
  order: 320,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;
    const cards = {};
    const lastOut = {};   // вывод последнего запуска, показывается под карточкой
    let state = null;

    const stateBadge = (s) => (String(s.up) === '1' ? ui.badge('работает', 'ok')
      : String(s.configured) === '1' ? ui.badge('выключен', 'muted') : ui.badge('не настроен', 'warn'));

    const editor = (t, box) => {
      ui.clear(box);
      const ta = el('textarea', { rows: 12, spellcheck: 'false', class: 'inp', style: { width: '100%', boxSizing: 'border-box', fontFamily: 'var(--mono)' },
        'aria-label': 'Настройки ' + t.title, placeholder: t.sample });
      const loading = ui.spinner('Читаю настройки…');
      box.appendChild(loading);
      (async () => {
        try {
          const d = await ctx.mod('vpn', 'config', { type: t.id });
          ta.value = String((d && d.content) || '');
        } catch (e) {
          if (e.code !== '9006') ui.toast('Не удалось прочитать настройки. ' + e.message, 'err');
        }
        loading.remove();
      })();
      box.appendChild(ui.notice('В файле настроек есть закрытый ключ. Не показывайте его посторонним и не публикуйте снимки экрана.', 'warn'));
      box.appendChild(ta);
      box.appendChild(el('small', { class: 'hint' }, 'Файл на роутере: ' + t.file));
      box.appendChild(ui.row(
        ui.btn('Сохранить', async () => {
          const text = ta.value.replace(/\r\n/g, '\n');
          if (!text.trim()) throw new Error('Файл настроек пустой.');
          if (t.id === 'wg' && !/\[Interface\]/i.test(text)) throw new Error('В настройках WireGuard нет раздела [Interface].');
          if (t.id === 'wg' && !/\[Peer\]/i.test(text)) throw new Error('В настройках WireGuard нет раздела [Peer].');
          if (t.id === 'ovpn' && !/^\s*remote\s+/m.test(text)) throw new Error('В настройках OpenVPN нет строки remote.');
          await ctx.mod('vpn', 'save', { type: t.id, content_b64: b64(text) }, { encrypt: true });
          ui.toast('Настройки сохранены. Перезапустите VPN, чтобы они подействовали.', 'ok');
          ui.clear(box);
          await load();
        }, 'primary'),
        ui.btn('Отмена', () => { ui.clear(box); drawType(t); })));
      ta.focus();
    };

    const drawType = (t) => {
      const s = (state && state[t.id]) || {};
      const body = cards[t.id].body;
      const edit = cards[t.id].edit;   // окно правки живет между перерисовками
      ui.clear(body);
      cards[t.id].badge.replaceWith(cards[t.id].badge = stateBadge(s));
      const up = String(s.up) === '1';
      const configured = String(s.configured) === '1';
      body.appendChild(el('p', { class: 'muted' }, t.about));
      // вкл/выкл — переключателем в заголовке (крутилка на время запуска, откат при ошибке)
      const sw = ui.headSwitch(up, async (v) => {
        if (v && !configured) throw new Error('Сначала вставьте настройки.');
        lastOut[t.id] = '';
        const r = await ctx.mod('vpn', v ? 'start' : 'stop', { type: t.id });
        state[t.id] = Object.assign({}, s, pick(r, t.id));
        if (v && String(state[t.id].up) !== '1') {
          if (r && r.output) lastOut[t.id] = String(r.output).trim();
          drawType(t);
          throw new Error('VPN не поднялся. Проверьте настройки и доступ в интернет.');
        }
        ui.toast(v ? 'VPN включен' : 'VPN выключен', 'ok');
        drawType(t);
      }, { label: 'Включить ' + t.title, title: up ? 'Выключить' : 'Включить', disabled: !configured && !up });
      if (up) body.appendChild(el('small', { class: 'hint' }, 'Весь трафик устройств идет через VPN.'));
      body.appendChild(ui.toggle('Включать при загрузке роутера', String(s.autostart) === '1', async (v) => {
        const r = await ctx.mod('vpn', 'autostart', { type: t.id, enable: v ? 1 : 0 });
        state[t.id] = Object.assign({}, s, pick(r, t.id));
        drawType(t);
      }, { disabled: !configured }));
      if (String(s.autostart_mod) === '1') {
        body.appendChild(el('small', { class: 'hint' }, 'Еще включен автозапуск из меню на экране роутера. Выключается там же.'));
      }
      if (lastOut[t.id]) body.appendChild(ui.pre(lastOut[t.id]));
      cards[t.id].card.setActions([cards[t.id].badge, edit.firstChild ? null
        : ui.btn(configured ? 'Изменить настройки' : 'Вставить настройки', () => { editor(t, edit); cards[t.id].card.setActions([cards[t.id].badge, sw]); }, 'ghost', { icon: 'edit' }), sw]);
      body.appendChild(edit);
    };

    // --- AmneziaWG: первым. Конфиг только записывается (setconf), назад не читается: ключ в интерфейсе не виден ---
    const awgBadgeBox = el('span', null, ui.badge('…', 'muted'));
    const awgState = el('div', null, ui.spinner());
    const awgCtl = el('div', { class: 'stack' });
    const awgEdit = el('div', { class: 'stack' });
    const dnsWarn = ui.dnsWarn(ctx);
    const awgProf = el('div', { class: 'stack' });
    const splitState = el('div', { class: 'stack' });
    const failBox = el('div', { class: 'stack' });
    const splitFile = el('input', { type: 'file', accept: '.txt,text/plain', hidden: true });
    const awgSpeedBox = el('div', { class: 'stack' });
    // широкая карточка: состояние и переключатели слева, профили справа; замер и правка конфига — под ними на всю ширину
    const awgCard = ui.card({ title: 'AmneziaWG', icon: 'shield', actions: awgBadgeBox },
      el('p', { class: 'muted' }, 'WireGuard с маскировкой трафика от блокировок. Нужен файл .conf от сервера AmneziaWG. ' +
        'Управление роутером по USB и Wi-Fi в туннель не уходит: интерфейс роутера доступен и при включенном VPN.'),
      dnsWarn.el,
      ui.split([awgState, awgCtl], awgProf),
      splitFile,
      ui.split(splitState, failBox),
      awgSpeedBox, awgEdit);
    root.appendChild(awgCard);
    // AmneziaWG — главный блок, сверху на всю ширину; WireGuard, OpenVPN и VPN прошивки — ниже кладкой
    const small = ui.grid();
    root.appendChild(small);
    // docs/API.md, vpn: <awg> installed, configured, up, autostart, info, rx_bytes, tx_bytes, handshake_s
    const awgGet = (r) => {
      const x = (r && r.awg && typeof r.awg === 'object') ? r.awg : {};
      return {
        installed: String(x.installed) === '1',
        configured: String(x.configured) === '1',
        up: String(x.up) === '1',
        autostart: String(x.autostart) === '1',
        handshake: String(x.handshake_s || ''),
        rx: String(x.rx_bytes || ''),
        tx: String(x.tx_bytes || ''),
        info: String(x.info || ''),
        engine: String(x.engine || ''),
        engineFallback: String(x.engine_fallback) === '1',
        // раздельный VPN и переключение при обрыве (docs/API.md, vpn): поля есть только у пакета, который это умеет
        hasSplit: x.split_list !== undefined,
        split: String(x.split) === '1',
        splitActive: String(x.split_active) === '1',
        splitList: String(x.split_list) === '1',
        splitPrefixes: M.int(x.split_prefixes, 0),
        splitDate: String(x.split_date || ''),
        splitReason: String(x.split_reason || ''),
        splitHint: String(x.split_hint || ''),
        splitDirect: M.arr(x.split_direct && x.split_direct.addr).map(String).filter(Boolean),
        splitVpn: M.arr(x.split_vpn && x.split_vpn.addr).map(String).filter(Boolean),
        hasFailover: x.failover !== undefined,
        failover: String(x.failover) === '1',
        failoverReason: String(x.failover_reason || ''),
        primary: String(x.primary || ''),
        dnsMode: String(x.dns_mode || ''),
        dnsServer: String(x.dns_server || ''),
        // профили (docs/API.md, vpn): <profiles><profile><name/><label/><active/><endpoint_host/></profile></profiles>;
        // элемента нет — пакет профилей не знает: показывается один текущий конфиг
        hasProfiles: x.profiles !== undefined,
        activeProfile: String(x.active_profile || ''),
        activeLabel: String(x.active_label || ''),
        profiles: M.arr(x.profiles && x.profiles.profile).filter((p) => p && typeof p === 'object' && p.name)
          .map((p) => ({ name: String(p.name), label: String(p.label || ''), server: String(p.endpoint_host || ''), proto: String(p.proto || ''),
            active: String(p.active) === '1' || String(p.name) === String(x.active_profile || '') })),
        present: Object.keys(x).length > 0,
      };
    };
    const NOPKG = 'Клиент AmneziaWG еще не установлен на роутере. Его ставит установщик мода (пакет awg).';
    const AWG_ERR = { 9003: 'Имя профиля не подходит: только латинские строчные буквы, цифры, «_» и «-», до 32 символов.' };
    const awgCall = async (action, args) => {
      const o = { errors: AWG_ERR };
      if (action === 'setconf') o.encrypt = true;
      try { return await ctx.mod('vpn', action, Object.assign({ type: 'awg' }, args || {}), o); } catch (e) {
        if (e.code === '9006') throw new Error(NOPKG);
        throw e;
      }
    };
    // техническое имя профиля из подписи: «AWG3.1 · Дом» → awg3_1_dom (a-z, 0-9, _, -; до 32 символов)
    const TR = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', '\u0451': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k',
      'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch',
      'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya' };
    const slug = (label) => {
      let n = String(label || '').toLowerCase().split('').map((c) => (TR[c] !== undefined ? TR[c] : c)).join('');
      n = n.replace(/[.\s\u00b7,/\\]+/g, '_').replace(/[^a-z0-9_-]/g, '').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
      return n.slice(0, 32).replace(/[_-]+$/, '') || 'profile';
    };
    const uniqueName = (base, taken) => {
      if (taken.indexOf(base) < 0) return base;
      for (let i = 2; i < 100; i++) {
        const n = base.slice(0, 32 - String(i).length - 1) + '_' + i;
        if (taken.indexOf(n) < 0) return n;
      }
      return base;
    };
    const profTitle = (p) => p.label || p.name;
    let awg = null;
    const AWG_ENGINE = { kernel: 'модуль ядра', go: 'программа' };
    // info из svc.sh status: убрать то, что уже есть в соседних строках (профиль, DNS, рукопожатие, движок) и в значке состояния;
    // незнакомые части остаются
    const awgInfoShort = (info) => String(info || '')
      .replace(/профиль «[^»]*»,?\s*/, '')
      .replace(/,?\s*DNS клиентов:[^,]*(,\s*(мимо туннеля|его серверы через туннель))?/, '')
      .split(/[,;]\s+/).map((x) => x.trim())
      .filter((x) => x && !/^(остановлен|рукопожатия|движок|память)(\s|$)/.test(x))
      .join(', ');
    const drawAwg = () => {
      const a = awg;
      ui.clear(awgBadgeBox).appendChild(!a.present || !a.installed ? ui.badge('не установлен', 'muted') : a.up ? ui.badge('работает', 'ok')
        : a.configured ? ui.badge('выключен', 'muted') : ui.badge('не настроен', 'warn'));
      if (!a.present || !a.installed) {
        ui.clear(awgState).appendChild(ui.notice(NOPKG, 'info'));
        ui.clear(awgCtl);
        ui.clear(awgProf);
        ui.clear(splitState);
        ui.clear(failBox);
        awgCard.setActions([awgBadgeBox]);
        return;
      }
      const hs = M.int(a.handshake, -1);
      ui.clear(awgState).appendChild(ui.kv([
        ['Ключ', a.configured ? 'задан' : 'нет'],
        a.activeLabel || a.activeProfile ? ['Профиль', a.activeLabel || a.activeProfile] : null,
        // engine: kernel или go, пусто — строки нет; engine_fallback=1 — движок auto, модуль не загрузился, работает go
        AWG_ENGINE[a.engine] ? ['Движок', AWG_ENGINE[a.engine],
          a.engineFallback ? 'Модуль ядра не загрузился, работает запасной путь.' : undefined] : null,
        a.up ? ['Последнее рукопожатие', hs > 0 ? M.fmt.duration(hs) + ' назад' : hs === 0 ? 'только что' : 'не было'] : null,
        a.up || a.rx ? ['Принято / передано', M.fmt.bytes(a.rx) + ' / ' + M.fmt.bytes(a.tx)] : null,
        awgInfoShort(a.info) ? ['Сведения', awgInfoShort(a.info)] : null,
        a.dnsMode ? ['DNS устройств', a.dnsMode === 'tunnel' ? 'через туннель' + (a.dnsServer ? ': ' + a.dnsServer : '')
          : a.dnsMode === 'dnspkg' ? 'через DNS-пакет роутера' : 'оператора — возможна утечка и подмена адресов'] : null,
      ]));
      ui.clear(awgCtl);
      const awgSw = ui.headSwitch(a.up, async (v) => {
        if (v && !a.configured) throw new Error('Сначала добавьте профиль или вставьте конфиг.');
        const r = await awgCall(v ? 'start' : 'stop');
        if (r && r.awg) awg = Object.assign(awgGet(r), { present: true });
        else await loadAwg();
        if (v && !awg.up) { drawAwg(); throw new Error('AmneziaWG не поднялся. Проверьте конфиг и доступ в интернет.'); }
        ui.toast(v ? 'AmneziaWG включен' : 'AmneziaWG выключен', 'ok');
        drawAwg();
      }, { label: 'Включить AmneziaWG', title: a.up ? 'Выключить' : 'Включить', disabled: !a.configured && !a.up });
      awgCtl.appendChild(ui.toggle('Включать при загрузке роутера', a.autostart, async (v) => {
        const r = await awgCall('autostart', { enable: v ? 1 : 0 });
        if (r && r.awg) awg = Object.assign(awgGet(r), { present: true });
        else awg.autostart = v;
        drawAwg();
      }, { disabled: !a.configured }));
      {
        awgCtl.appendChild(ui.toggle('DNS устройств через туннель', a.dnsMode === 'tunnel', async (v) => {
          const r = await awgCall('dns', { on: v ? 1 : 0 });
          if (r && r.awg) awg = Object.assign(awgGet(r), { present: true });
          else await loadAwg();
          ui.toast(v ? 'Адреса сайтов узнаются через туннель' : 'Адреса сайтов узнаются у оператора', 'ok');
          drawAwg();
        }, { hint: 'Иначе запросы адресов сайтов идут к оператору мимо туннеля: он видит, какие сайты открываются, и может подменить ответ.' }));
      }
      ui.clear(awgProf);
      if (a.hasProfiles) {
        awgProf.appendChild(ui.subhead('Профили'));
        awgProf.appendChild(ui.table([
          { key: 'label', title: 'Профиль', render: (p) => el('div', { class: 'host' },
            el('span', null, profTitle(p), p.active ? ' ' : '', p.active ? ui.badge('активный', 'ok') : ''),
            el('small', null, [p.label ? p.name : '', p.proto ? (p.proto === 'wireguard' ? 'WireGuard' : 'AWG ' + p.proto) : ''].filter(Boolean).join(' · '))) },
          { key: 'server', title: 'Сервер', render: (p) => el('span', { class: 'mono' }, p.server || '—') },
          { key: '_', title: '', render: (p) => el('div', { class: 'row row-end' },
            p.active ? null : ui.btn('Выбрать', () => useProfile(p), '', { class: 'btn-sm' }),
            ui.btn('', () => renameProfile(p), 'ghost', { icon: 'edit', title: 'Переименовать', class: 'btn-sm' }),
            p.active ? null : ui.btn('Удалить', () => delProfile(p), 'danger', { class: 'btn-sm' })) },
        ], a.profiles, { empty: 'Профилей пока нет: добавьте конфиг.' }));
      }
      drawSplit(a);
      drawFailover(a);
      dnsWarn.update({ vpnUp: a.up, dnsTunnel: a.up && a.dnsMode === 'tunnel' });
      // действия карточки — в заголовке справа: добавить профиль (или вставить конфиг), проверить скорость
      awgCard.setActions([awgBadgeBox,
        awgEdit.firstChild ? null : ui.btn(a.hasProfiles ? 'Добавить профиль' : a.configured ? 'Заменить конфиг' : 'Вставить конфиг', () => awgEditor(), 'ghost', { icon: a.hasProfiles ? 'plus' : 'edit' }),
        a.up ? ui.btn('Скорость через туннель', () => awgSpeed(), 'ghost', { icon: 'arrowdown', title: 'Проверить скорость через туннель' }) : null,
        awgSw]);
    };
    // --- раздельный VPN и переключение при обрыве: отказ пакета (9004) — его текст как есть ---
    const extraCall = async (action, args) => {
      let r;
      try { r = await ctx.mod('vpn', action, args || {}); } catch (e) {
        if (e.code === '9006') throw new Error(NOPKG);
        if (e.code === '9004') throw new Error((e.data && e.data.message) || e.message);
        throw e;
      }
      return r;
    };
    const applyAwg = async (r) => {
      if (r && r.awg) awg = Object.assign(awgGet(r), { present: true }); else await loadAwg();
      drawAwg();
    };
    const prefixWord = (n) => {
      const t = n % 100; const u = n % 10;
      return n + (t > 10 && t < 20 ? ' подсетей' : u === 1 ? ' подсеть' : u >= 2 && u <= 4 ? ' подсети' : ' подсетей');
    };
    splitFile.addEventListener('change', () => {
      const f = splitFile.files && splitFile.files[0];
      if (!f) return;
      splitFile.value = '';
      if (f.size > 270 * 1024) { ui.toast('Файл больше 270 КБ: роутер примет список только меньшего размера.', 'err'); return; }
      const rd = new FileReader();
      rd.onerror = () => ui.toast('Не удалось прочитать файл.', 'err');
      rd.onload = async () => {
        try {
          const r = await extraCall('split_update', { list_b64: b64(String(rd.result || '')) });
          ui.toast('Список обновлен', 'ok');
          await applyAwg(r);
        } catch (e) { ui.toast(e.message, 'err'); }
      };
      rd.readAsText(f);
    });
    // свои исключения: адрес или подсеть IPv4, те же правила, что norm_prefix в svc.sh пакета
    const exError = (v) => {
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(v);
      if (!m) return 'Нужен адрес или подсеть IPv4, например 203.0.113.0/24. Домены не поддерживаются.';
      const o = m.slice(1, 5).map(Number);
      const len = m[5] === undefined ? 32 : Number(m[5]);
      if (o.some((x) => x > 255) || len < 8 || len > 32) return 'Нужен адрес или подсеть IPv4, длина подсети от 8 до 32.';
      const ip = o[0] * 16777216 + o[1] * 65536 + o[2] * 256 + o[3];
      if (ip % Math.pow(2, 32 - len) !== 0) return 'В адресе подсети есть лишние биты: для /' + len + ' укажите начало подсети.';
      return '';
    };
    const exSummary = el('span');
    const exKind = (title, action) => {
      const listBox = el('div', { class: 'stack' });
      const draw = (items) => {
        ui.clear(listBox);
        if (!items.length) listBox.appendChild(el('small', { class: 'hint' }, 'Пусто.'));
        items.forEach((addr) => listBox.appendChild(el('div', { class: 'ex-row' }, el('span', { class: 'mono' }, addr),
          ui.btn('', async () => { await applyAwg(await extraCall(action, { op: 'del', addr })); }, 'ghost', { icon: 'trash', title: 'Убрать ' + addr, class: 'btn-sm' }))));
      };
      const input = el('input', { class: 'inp inp-inline', placeholder: '203.0.113.0/24', autocomplete: 'off', 'aria-label': title + ': адрес или подсеть' });
      const err = el('small', { class: 'f-err', hidden: true });
      const addBtn = ui.btn('Добавить', async () => {
        const addr = input.value.trim();
        const bad = exError(addr);
        err.textContent = bad;
        err.hidden = !bad;
        if (bad) return;
        const r = await extraCall(action, { op: 'add', addr });
        input.value = '';
        await applyAwg(r);
      }, '', { class: 'btn-sm' });
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addBtn.click(); } });
      return { draw, el: el('div', { class: 'stack' }, el('div', { class: 'act-row-l' }, title), listBox, el('div', { class: 'row' }, input, addBtn), err) };
    };
    const exDirect = exKind('Всегда напрямую', 'split_direct');
    const exVpn = exKind('Всегда через VPN', 'split_vpn');
    // живет вне перерисовки по опросу: раскрытие и введенный адрес не сбрасываются
    const exDetails = el('details', { class: 'more' }, el('summary', null, exSummary),
      el('div', { class: 'stack' }, el('small', { class: 'hint' }, 'Адрес или подсеть IPv4. Домены не поддерживаются: маршрут выбирается только по адресу.'), exDirect.el, exVpn.el));
    const drawSplit = (a) => {
      ui.clear(splitState);
      if (!a.hasSplit) return;
      let state = '';
      if (!a.splitList) state = a.split ? 'Весь трафик через VPN: список российских адресов не загружен.' : 'Для этого режима нужен список российских адресов.';
      else if (a.split) {
        // при остановленном туннеле split_active не показатель
        if (!a.up || a.splitReason === 'tunnel_down') state = 'Сработает, когда туннель поднят.';
        else if (a.splitReason === 'no_full_tunnel') state = 'Не действует: VPN не на весь трафик.';
        else if (a.splitActive) state = 'Действует: российские адреса идут напрямую.';
      }
      splitState.appendChild(ui.toggle('Российские сайты напрямую', a.split, async (v) => {
        const r = await extraCall('split', { on: v ? 1 : 0 });
        ui.toast(v ? 'Российские сайты пойдут напрямую' : 'Весь трафик идет через туннель', 'ok');
        await applyAwg(r);
      }, { disabled: !a.splitList && !a.split, hint: state || 'Быстрее и меньше проблем с банками: остальное идет через туннель.' }));
      splitState.appendChild(a.splitList
        ? ui.actionRow('Список российских адресов', [a.splitDate ? 'от ' + a.splitDate : '', prefixWord(a.splitPrefixes)].filter(Boolean).join(', '),
          ui.btn('Обновить файл', () => splitFile.click(), '', { icon: 'upload' }))
        : ui.actionRow('Список российских адресов не загружен', 'Соберите файл на компьютере: скачайте данные RIPE и запустите tools/split-gen.py (шаги — в README пакета awg, раздел «Раздельный VPN»), затем загрузите его сюда.',
          ui.btn('Загрузить файл', () => splitFile.click(), '', { icon: 'upload' })));
      splitState.appendChild(el('small', { class: 'hint' }, 'Маршрут выбирается по адресу: сайт на зарубежном CDN пойдет через туннель, сайт на российском адресе — напрямую, и блокировка оператора для него остается.'));
      const servicesLink = el('a', { href: '#/services' }, '«Службы»');
      // громкое предупреждение о DNS одно — сверху карточки (M.ui.dnsWarn), здесь совет обычной подсказкой
      splitState.appendChild(a.split && a.splitHint
        ? el('small', { class: 'hint' }, a.splitHint + ' Открыть ', servicesLink, '.')
        : el('small', { class: 'hint' }, 'С этим режимом включите службу DNS на сервере «Авто» (', servicesLink, '), иначе зарубежные сайты с подмененным адресом не откроются и через туннель.'));
      exDirect.draw(a.splitDirect);
      exVpn.draw(a.splitVpn);
      const cnt = a.splitDirect.length + a.splitVpn.length;
      exSummary.textContent = 'Исключения' + (cnt ? ': ' + cnt : '');
      splitState.appendChild(exDetails);
    };
    const FO_REASON = {
      ok: 'Основной профиль работает',
      on_backup: 'Работает запасной профиль',
      switched: 'Только что переключился на другой профиль',
      returned_primary: 'Вернулся на основной профиль',
      primary_still_down: 'Основной профиль все еще не отвечает, работает запасной',
      operator_down: 'Нет связи у оператора, профили не перебираются',
      pause: 'Пауза после переключения',
      no_other_profile: 'Нужен второй профиль',
      tunnel_down: 'Туннель выключен',
      no_full_tunnel: 'VPN не на весь трафик, профили не переключаются',
    };
    const drawFailover = (a) => {
      // опрос раз в 15 с не закрывает открытый выбор профиля
      if (failBox.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
      ui.clear(failBox);
      if (!a.hasFailover) return;
      const profs = a.profiles || [];
      const enough = profs.length >= 2;
      const current = a.primary || a.activeProfile || (profs[0] && profs[0].name) || '';
      const pf = ui.form([{ name: 'primary', label: 'Основной профиль', type: 'select', value: current,
        options: profs.map((p) => [p.name, profTitle(p)]) }], null, { submit: false });
      const sel = pf.field('primary');
      sel.disabled = !enough;
      failBox.appendChild(ui.toggle('Переключать профиль при обрыве', a.failover, async (v) => {
        const r = await extraCall('failover', v ? { on: 1, primary: sel.value } : { on: 0 });
        ui.toast(v ? 'Переключение при обрыве включено' : 'Переключение при обрыве выключено', 'ok');
        await applyAwg(r);
      }, { disabled: !enough && !a.failover, hint: enough || (a.failover && a.failoverReason) ? '' : 'Нужен второй профиль.' }));
      failBox.appendChild(pf);
      sel.addEventListener('change', async () => {
        if (!a.failover) return;
        try {
          const r = await extraCall('failover', { on: 1, primary: sel.value });
          sel.blur();
          await applyAwg(r);
        } catch (e) { sel.value = current; ui.toast(e.message, 'err'); }
      });
      if (a.failover && a.failoverReason) failBox.appendChild(ui.kv([['Почему этот профиль', FO_REASON[a.failoverReason] || a.failoverReason]]));
      failBox.appendChild(el('small', { class: 'hint' }, 'Если 3 мин нет связи с сервером, роутер переходит на следующий профиль, затем выдерживает паузу 5 мин. ' +
        'Раз в 30 мин он пробует основной профиль: на это время связь через VPN коротко прерывается.'));
    };
    const useProfile = async (p) => {
      if (awg.up && !(await ui.confirm('Переключиться на профиль «' + profTitle(p) + '»? Туннель переподключится, связь через VPN на несколько секунд пропадет.', { ok: 'Переключить' }))) return;
      const r = await awgCall('profile_use', { name: p.name });
      if (r && r.awg) awg = Object.assign(awgGet(r), { present: true }); else await loadAwg();
      ui.toast('Активный профиль: ' + profTitle(p), 'ok');
      drawAwg();
    };
    const renameProfile = (p) => {
      const f = ui.form([{ name: 'label', label: 'Название профиля', value: profTitle(p), required: true, maxlength: 64 }], null, { submit: false });
      ui.modal('Название профиля', f, [
        { label: 'Отмена', value: false },
        { label: 'Сохранить', kind: 'primary', onClick: async () => {
          const label = f.values().label;
          if (!label) { f.error('Введите название.'); return false; }
          const r = await awgCall('profile_label', { name: p.name, label });
          if (r && r.awg) awg = Object.assign(awgGet(r), { present: true }); else await loadAwg();
          drawAwg();
          return true;
        } },
      ]);
    };
    const delProfile = async (p) => {
      if (!(await ui.confirm('Удалить профиль «' + profTitle(p) + '» вместе с его ключом? Восстановить можно только заново из файла .conf.', { ok: 'Удалить', danger: true }))) return;
      const r = await awgCall('profile_delete', { name: p.name });
      if (r && r.awg) awg = Object.assign(awgGet(r), { present: true }); else await loadAwg();
      ui.toast('Профиль удален', 'ok');
      drawAwg();
    };
    const awgEditor = () => {
      ui.clear(awgEdit);
      const withNames = !!(awg && awg.hasProfiles);
      const nameIn = el('input', { class: 'inp inp-inline', id: 'awg-name', placeholder: 'AWG3.1 · Дом', maxlength: 64, autocomplete: 'off' });
      const nameHint = el('small', { class: 'hint' });
      const techName = () => uniqueName(slug(nameIn.value), (awg.profiles || []).map((x) => x.name));
      const updHint = () => { nameHint.textContent = nameIn.value.trim() ? 'Имя на роутере: ' + techName() : 'Как вам удобно, до 64 символов.'; };
      nameIn.addEventListener('input', updHint);
      updHint();
      const ta = el('textarea', { rows: 12, spellcheck: 'false', autocomplete: 'off', class: 'inp mono', 'aria-label': 'Конфиг AmneziaWG',
        placeholder: '[Interface]\nPrivateKey = …\nAddress = 10.0.0.2/32\nJc = 4\nJmin = 40\nJmax = 70\nS1 = 0\nS2 = 0\nH1 = …\n\n[Peer]\nPublicKey = …\nEndpoint = vpn.example.com:51820\nAllowedIPs = 0.0.0.0/0\n' });
      const file = el('input', { type: 'file', accept: '.conf,text/plain', hidden: true });
      file.addEventListener('change', () => {
        const f = file.files && file.files[0];
        if (!f) return;
        if (f.size > 64 * 1024) { ui.toast('Файл больше 64 КБ: это не конфиг AmneziaWG.', 'err'); return; }
        const rd = new FileReader();
        rd.onload = () => { ta.value = String(rd.result || ''); file.value = ''; };
        rd.onerror = () => ui.toast('Не удалось прочитать файл.', 'err');
        rd.readAsText(f);
      });
      const close = () => { ta.value = ''; ui.clear(awgEdit); drawAwg(); };
      awgEdit.appendChild(ui.notice('В конфиге есть закрытый ключ. После сохранения он остается только на роутере: интерфейс его больше не показывает.', 'warn'));
      if (withNames) {
        awgEdit.appendChild(el('div', { class: 'f-row f-wide' }, el('label', { class: 'f-l', for: 'awg-name' }, 'Название профиля'), nameIn, nameHint));
      }
      awgEdit.appendChild(ta);
      awgEdit.appendChild(file);
      awgEdit.appendChild(ui.row(
        ui.btn('Сохранить', async () => {
          const text = ta.value.replace(/\r\n/g, '\n');
          if (!text.trim()) throw new Error('Конфиг пустой.');
          if (!/\[Interface\]/i.test(text) || !/^\s*PrivateKey\s*=/mi.test(text)) throw new Error('В конфиге нет раздела [Interface] с PrivateKey.');
          if (!/\[Peer\]/i.test(text) || !/^\s*Endpoint\s*=/mi.test(text)) throw new Error('В конфиге нет раздела [Peer] с Endpoint.');
          const label = nameIn.value.trim();
          if (withNames && !label) { nameIn.focus(); throw new Error('Введите название профиля.'); }
          // тело с ключом шифруется RSA целиком (docs/API.md, «Шифрование тела»)
          await awgCall('setconf', withNames ? { name: techName(), label, conf_b64: b64(text) } : { conf_b64: b64(text) });
          ui.toast('Конфиг сохранен, ключ задан. Включите AmneziaWG, чтобы он подействовал.', 'ok');
          close();
          await loadAwg();
        }, 'primary'),
        ui.btn('Загрузить файл .conf', () => file.click(), '', { icon: 'upload' }),
        ui.btn('Отмена', close, 'ghost')));
      drawAwg();
      ta.focus();
    };
    // замер скорости через туннель: тот же замер, что на «Тесте скорости», с via=awg (живой график приема и ЦП, вывод)
    let awgPanel = null;
    const awgSpeed = async () => {
      if (awgPanel && awgPanel.busy()) return;
      awgPanel = ui.speedPanel(ctx, { busyText: 'Замер уже идет (возможно, на странице «Тест скорости»). Дождитесь результата.',
        tunnel: true });
      ui.clear(awgSpeedBox);
      awgSpeedBox.appendChild(el('div', { class: 'sub-h' }, 'Скорость через туннель'));
      awgSpeedBox.appendChild(awgPanel.el);
      drawAwg();
      try {   // названия серверов для строки «Выбор сервера»
        const sv = await ctx.mod('speedtest', 'servers');
        awgPanel.setServers(M.arr(sv && sv.servers && sv.servers.server).filter((x) => x && x.id).map((x) => ({ id: String(x.id), name: x.name || x.id })));
      } catch (e) { /* без названий — покажутся id */ }
      await awgPanel.run({ server: 'auto', via: 'awg', direction: 'both', timeout_s: 15, streams: 1 }, 15, 20);
    };
    const loadAwg = async () => {
      try {
        awg = awgGet(await ctx.mod('vpn'));
      } catch (e) {
        ui.clear(awgState).appendChild(ui.notice(e.code === '9001' ? 'Помощник мода на роутере не отвечает: VPN недоступен.'
          : 'Не удалось получить состояние AmneziaWG. ' + e.message, 'err'));
        return;
      }
      drawAwg();
    };
    loadAwg();
    // рукопожатие и счетчики — раз в 15 с (веб роутера однопоточный, чаще не нужно)
    ui.poll(async () => { if (awg && awg.up && !awgEdit.firstChild && !(awgPanel && awgPanel.busy())) await loadAwg(); }, 15000);

    TYPES.forEach((t) => {
      const badge = ui.badge('…', 'muted');
      const body = el('div', null, ui.spinner());
      const card = ui.card({ title: t.title, icon: 'key', actions: [badge] }, body);
      cards[t.id] = { body, badge, card, edit: el('div') };
      small.appendChild(card);
    });

    const load = async () => {
      try {
        state = await ctx.mod('vpn');
        TYPES.forEach(drawType);
      } catch (e) {
        TYPES.forEach((t) => {
          ui.clear(cards[t.id].body);
          cards[t.id].body.appendChild(ui.notice(e.code === '9001'
            ? 'Помощник мода на роутере не отвечает: VPN недоступен.'
            : 'Не удалось получить состояние VPN. ' + e.message, 'err'));
        });
      }
    };

    // --- стоковые VPN ---
    const stockBody = el('div', null, ui.spinner());
    small.appendChild(ui.card({ title: 'VPN прошивки', sub: 'L2TP, PPTP, IPsec' }, stockBody));
    const loadStock = async () => {
      try {
        await ctx.api.get('api/vpn/feature-switch');
      } catch (e) {
        ui.clear(stockBody);
        stockBody.appendChild(ui.notice('В этой прошивке VPN-клиента нет.', 'info'));
        return;
      }
      const rows = [];
      for (const s of STOCK) {
        try {
          const d = await ctx.api.get('api/vpn/' + s[0]);
          rows.push([s[1], String(d && d.enable) === '1' ? 'включен' : 'выключен']);
        } catch (e) {
          rows.push([s[1], e.code === '100002' ? 'нет в прошивке' : 'неизвестно']);
        }
      }
      ui.clear(stockBody);
      stockBody.appendChild(ui.kv(rows));
      stockBody.appendChild(el('p', { class: 'hint' }, 'Эти подключения настраиваются в стоковом интерфейсе. ' +
        'Не включайте их вместе с WireGuard или OpenVPN.'));
      stockBody.appendChild(el('a', { href: '/html/vpnsettings.html', target: '_blank', rel: 'noopener', class: 'btn' }, 'Открыть настройки VPN прошивки'));
    };

    await Promise.all([load(), loadStock()]);
  },
});
