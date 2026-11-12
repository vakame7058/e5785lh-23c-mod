// Wi-Fi: включение, основная сеть (имя, пароль, защита), радио (канал, ширина), гостевая сеть, страна
const { el } = M.ui;

const SEC = { 'WPA2-PSK': 'WPA2', 'WPA/WPA2-PSK': 'WPA и WPA2', 'WPA-PSK': 'WPA', OPEN: 'Без пароля' };
const WIDTH = [['20', '20 МГц'], ['40', '40 МГц'], ['0', 'Авто']];
const MODES = [['b/g/n', '802.11b/g/n'], ['b/g', '802.11b/g'], ['n', '802.11n'], ['b', '802.11b'], ['g', '802.11g']];
const OFFTIME = [['600', '10 мин'], ['1800', '30 мин'], ['3600', '1 ч'], ['7200', '2 ч'], ['14400', '4 ч']];
// Названия стран из стокового lang_ru_ru (wlan_country_xx); список кодов — config/wifi/countryChannel.xml роутера
const CNAMES = {"ae":"ОАЭ","al":"Албания","am":"Армения","ar":"Аргентина","at":"Австрия","au":"Австралия","az":"Азербайджан","be":"Бельгия","bg":"Болгария","bh":"Бахрейн","bn":"Бруней","bo":"Боливия","br":"Бразилия","by":"Беларусь","bz":"Белиз","ca":"Канада","ch":"Швейцария","cl":"Чили","cn":"Китай","co":"Колумбия","cr":"Коста-Рика","cy":"Кипр","cz":"Чехия","de":"Германия","dk":"Дания","dz":"Алжир","ec":"Эквадор","ee":"Эстония","eg":"Египет","es":"Испания","fi":"Финляндия","fr":"Франция","gb":"Великобритания","ge":"Грузия","gh":"Гана","gr":"Греция","gt":"Гватемала","hk":"Гонконг, Китай","hn":"Гондурас","hr":"Хорватия","hu":"Венгрия","id":"Индонезия","ie":"Ирландия","il":"Израиль","is":"Исландия","it":"Италия","jo":"Иордания","jp":"Япония","kr":"Республика Корея","kw":"Кувейт","kz":"Казахстан","la":"Лаос","lb":"Ливан","li":"Лихтенштейн","lt":"Литва","lu":"Люксембург","lv":"Латвия","ma":"Марокко","mc":"Монако","mk":"Македония","mo":"Макао, Китай","mx":"Мексика","my":"Малайзия","nl":"Нидерланды","no":"Норвегия","nz":"Новая Зеландия","om":"Оман","pa":"Панама","pe":"Перу","ph":"Филиппины","pk":"Пакистан","pl":"Польша","pr":"Пуэрто-Рико","pt":"Португалия","qa":"Катар","ro":"Румыния","ru":"Россия","sa":"Саудовская Аравия","se":"Швеция","sg":"Сингапур","si":"Словения","sk":"Словакия","sv":"Сальвадор","th":"Таиланд","tn":"Тунис","tr":"Турция","tt":"Тринидад и Тобаго","tw":"Тайвань, Китай","ua":"Украина","us":"США","uy":"Уругвай","uz":"Узбекистан","ve":"Венесуэла","vn":"Вьетнам","ye":"Йемен","za":"ЮАР","zw":"Зимбабве"};

const secModes = (ssid) => {
  const list = String(ssid.wifisupportsecmodelist || '').split(';').map((x) => x.split(':')[0]).filter(Boolean);
  const modes = list.length ? list : ['WPA2-PSK', 'WPA/WPA2-PSK', 'OPEN'];
  if (ssid.WifiAuthmode && modes.indexOf(ssid.WifiAuthmode) < 0) modes.push(ssid.WifiAuthmode);
  return modes.map((m) => [m, SEC[m] || m]);
};
const pskOk = (v) => (v.length >= 8 && v.length <= 63) || /^[0-9a-fA-F]{64}$/.test(v);
const asciiOk = (v) => /^[\x20-\x7e]*$/.test(v);

// Поля, которые нельзя слать обратно как прочитаны (пароли пустые в GET): сток удаляет неизмененные
const SECRET = ['WifiWpapsk', 'MixWifiWpapsk', 'WifiWepKey1', 'WifiWepKey2', 'WifiWepKey3', 'WifiWepKey4', 'WifiRadiusKey',
  'WifiWep128Key1', 'WifiWep128Key2', 'WifiWep128Key3', 'WifiWep128Key4'];
const clean = (s) => { const o = Object.assign({}, s); SECRET.forEach((k) => delete o[k]); return o; };

M.page({
  id: 'wifi', title: 'Wi-Fi', group: 'Сеть', icon: 'wifi', order: 20,
  async render(box, ctx) {
    const ui = ctx.ui;
    const api = ctx.api;
    const [sw, basic, radio, feat, bset, cch] = await Promise.all([
      api.get('api/wlan/status-switch-settings').catch(() => null),
      api.get('api/wlan/multi-basic-settings'),
      api.get('api/wlan/multi-security-settings').catch(() => null),
      api.get('api/wlan/wifi-feature-switch').catch(() => ({})),
      api.get('api/wlan/basic-settings').catch(() => null),
      api.get('config/wifi/countryChannel.xml').catch(() => null),
    ]);
    const country = String((bset && bset.WifiCountry) || (radio && radio.WifiCountry) || '').toUpperCase();
    // каналы 2,4 ГГц по стране: «1-13» → 1…13
    const chRange = (() => {
      // в файле веба — наибольший канал («13»), в /app/config — диапазон («1-11»)
      const v = String((cch && cch[country.toLowerCase()]) || '13');
      const r = v.match(/(\d+)\s*-\s*(\d+)/);
      if (r) return [+r[1], +r[2]];
      const n = M.int(v, 13);
      return [1, n >= 1 && n <= 14 ? n : 13];
    })();
    let ssids = M.arr(basic.Ssids && basic.Ssids.Ssid);
    const main = () => ssids.find((s) => s.wifiisguestnetwork !== '1') || ssids[0];
    const guest = () => ssids.find((s) => s.wifiisguestnetwork === '1');
    const restartNote = 'Wi-Fi перезапустится: устройства отключатся и подключатся снова, если имя и пароль не менялись.';

    // сохранение списка сетей: сток шлет все сети сразу, пароли — только измененные и шифрованными
    const saveSsids = async (patch) => {
      const list = ssids.map((s) => {
        const p = patch[s.Index];
        const o = clean(s);
        if (p) Object.assign(o, p);
        return o;
      });
      const enp = Object.keys(patch).some((k) => patch[k].WifiWpapsk !== undefined) ? ['WifiWpapsk', 'MixWifiWpapsk'] : null;
      await api.post('api/wlan/multi-basic-settings', { Ssids: { Ssid: list }, WifiRestart: 1 }, enp ? { enp, timeout: 60000 } : { timeout: 60000 });
      const r = await api.get('api/wlan/multi-basic-settings');
      ssids = M.arr(r.Ssids && r.Ssids.Ssid);
    };

    // --- включение ---
    const radios = sw ? M.arr(sw.radios && sw.radios.radio) : [];
    const onCard = ui.card({ title: 'Wi-Fi', icon: 'wifi' },
      radios.length ? ui.toggle('Wi-Fi включен', radios.every((r) => r.wifienable === '1'), async (v) => {
        if (!v && !(await ui.confirm('Выключить Wi-Fi? Если вы подключены по Wi-Fi, интерфейс станет недоступен. Включить обратно можно кнопкой на роутере или по USB.',
          { ok: 'Выключить', danger: true }))) return false;
        await api.post('api/wlan/status-switch-settings', { radios: { radio: radios.map((r) => ({ ID: r.ID, index: r.index, wifienable: v ? 1 : 0 })) } });
        radios.forEach((r) => { r.wifienable = v ? '1' : '0'; });
      }) : ui.notice('Не удалось прочитать состояние Wi-Fi.', 'warn'),
      ui.kv([
        ['Диапазон', feat.wifi5g_enabled === '1' ? '2,4 и 5 ГГц' : '2,4 ГГц'],
        ['Клиентов сейчас', (M.state.status && M.state.status.CurrentWifiUser) || '—'],
      ]),
      feat.wifi5g_enabled === '1' ? null : el('small', { class: 'hint' }, 'Выбор 5 ГГц выключен в настройках прошивки (wifi5g_enabled = 0).'));

    // --- основная сеть ---
    const netForm = (s, isGuest) => {
      let pwShown = false;
      const f = ui.form([
        isGuest ? { name: 'WifiEnable', label: 'Гостевая сеть включена', type: 'toggle', value: s.WifiEnable === '1' } : null,
        { name: 'WifiSsid', label: 'Имя сети', value: s.WifiSsid, required: true, maxlength: 32,
          validate: (v) => (new TextEncoder().encode(v).length > 32 ? 'Не длиннее 32 байт.' : '') },
        { name: 'WifiAuthmode', label: 'Защита', type: 'select', options: secModes(s), value: s.WifiAuthmode },
        { name: 'pw', label: 'Пароль', type: 'password', value: '', placeholder: 'не менять', maxlength: 64,
          hint: '8–63 символа латиницей. Пусто — пароль не меняется.',
          show: (v) => v.WifiAuthmode !== 'OPEN',
          validate: (v) => (v && (!asciiOk(v) || !pskOk(v)) ? 'Нужно 8–63 символа латиницей, цифр или знаков.' : '') },
        { name: 'WifiBroadcast', label: 'Скрыть имя сети', type: 'toggle', value: s.WifiBroadcast === '1', hint: 'Устройствам придется вводить имя вручную' },
        { name: 'WifiIsolate', label: 'Изоляция устройств', type: 'toggle', value: s.WifiIsolate === '1', hint: 'Устройства в сети не видят друг друга' },
        s.WifiMaxAssoc !== undefined ? { name: 'WifiMaxAssoc', label: 'Устройств не больше', type: 'number', min: 1, max: M.int(feat.wifi_chip_maxassoc, 32), value: s.WifiMaxAssoc } : null,
      ].filter(Boolean), async (v) => {
        const p = {
          WifiSsid: v.WifiSsid, WifiAuthmode: v.WifiAuthmode, WifiBroadcast: v.WifiBroadcast ? 1 : 0, WifiIsolate: v.WifiIsolate ? 1 : 0,
        };
        if (isGuest) p.WifiEnable = v.WifiEnable ? 1 : 0;
        if (v.WifiMaxAssoc !== undefined) p.WifiMaxAssoc = v.WifiMaxAssoc;
        if (v.WifiAuthmode === 'OPEN') p.WifiBasicencryptionmodes = 'NONE';
        else {
          p.WifiWpaencryptionmodes = s.WifiWpaencryptionmodes || 'AES';
          if (v.pw) { p.WifiWpapsk = v.pw; p.MixWifiWpapsk = v.pw; }
          if (s.WifiAuthmode === 'OPEN' && !v.pw) throw new Error('Для защиты WPA задайте пароль.');
        }
        const warn = v.WifiAuthmode === 'OPEN' ? '\n\nСеть будет без пароля: подключиться сможет любой рядом.' : '';
        if (!(await ui.confirm(restartNote + warn, { title: 'Сохранить сеть «' + v.WifiSsid + '»?', ok: 'Сохранить', danger: v.WifiAuthmode === 'OPEN' }))) return false;
        await saveSsids({ [s.Index]: p });
        f.set('pw', '');
      }, {
        primary: !isGuest,
        actions: [ui.btn('Показать пароль', async (ev, b) => {
          if (pwShown) { f.field('pw').type = 'password'; pwShown = false; b.lastChild.textContent = 'Показать пароль'; return; }
          const sec = await api.secrets('wlan');
          const list = M.arr(sec.Ssids && sec.Ssids.Ssid);
          const mine = list.find((x) => x.Index === s.Index) || list[ssids.indexOf(s)] || {};
          f.set('pw', mine.WifiWpapsk || '');
          f.field('pw').type = 'text';
          pwShown = true;
          b.lastChild.textContent = 'Скрыть пароль';
        }, 'ghost', { icon: 'eye' })],
      });
      return f;
    };
    const m = main();
    const mainCard = ui.card({ title: 'Основная сеть', icon: 'wifi', sub: m && m.WifiMac ? 'MAC ' + m.WifiMac : '' },
      m ? netForm(m, false) : ui.notice('Сеть не найдена.', 'err'));

    // --- радио ---
    let radioCard;
    if (radio) {
      const f = ui.form([
        { name: 'WifiChannel', label: 'Канал', type: 'select', value: radio.WifiChannel,
          options: [['0', 'Авто']].concat(Array.from({ length: chRange[1] - chRange[0] + 1 }, (x, i) => {
            const c = chRange[0] + i;
            return [String(c), c + ' (' + (2407 + c * 5) + ' МГц)'];
          })), hint: 'Каналы ' + chRange[0] + '–' + chRange[1] + ' разрешены для страны ' + (country || '—') },
        { name: 'wifibandwidth', label: 'Ширина канала', type: 'select', options: WIDTH, value: radio.wifibandwidth,
          hint: '40 МГц быстрее, 20 МГц устойчивее, если рядом много сетей' },
        { name: 'WifiMode', label: 'Стандарт', type: 'select', options: MODES.some((x) => x[0] === radio.WifiMode) ? MODES : MODES.concat([[radio.WifiMode, radio.WifiMode]]), value: radio.WifiMode },
        { name: 'Wifioffenable', label: 'Выключать без клиентов', type: 'toggle', value: radio.Wifioffenable === '1', hint: 'Экономит батарею' },
        { name: 'Wifiofftime', label: 'Через', type: 'select', value: radio.Wifiofftime,
          options: OFFTIME.some((x) => x[0] === radio.Wifiofftime) ? OFFTIME : OFFTIME.concat([[radio.Wifiofftime, M.fmt.duration(radio.Wifiofftime)]]),
          show: (v) => v.Wifioffenable },
      ], async (v) => {
        if (!(await ui.confirm(restartNote, { title: 'Сохранить настройки радио?', ok: 'Сохранить' }))) return false;
        const body = Object.assign({}, radio, {
          WifiChannel: v.WifiChannel, wifibandwidth: v.wifibandwidth, WifiMode: v.WifiMode,
          Wifioffenable: v.Wifioffenable ? 1 : 0, Wifiofftime: v.Wifiofftime, WifiRestart: 1,
        });
        delete body.WifiCountry;
        await api.post('api/wlan/multi-security-settings', body, { timeout: 60000 });
        Object.assign(radio, body);
      });
      radioCard = ui.card({ title: 'Радио', icon: 'antenna', sub: '2,4 ГГц' }, f);
    } else {
      radioCard = ui.card({ title: 'Радио', icon: 'antenna' }, ui.notice('Настройки радио недоступны.', 'warn'));
    }

    // --- гостевая сеть ---
    const g = guest();
    const guestCard = ui.card({ title: 'Гостевая сеть', icon: 'clients' },
      feat.guestwifi_enable === '1' && g ? netForm(g, true)
        : ui.notice('Гостевая сеть выключена в настройках прошивки (guestwifi_enable = 0).', 'info'));

    // --- страна: стоковый POST api/wlan/basic-settings (WifiCountry); список — config/wifi/countryChannel.xml ---
    let countryCard;
    if (bset) {
      const skip = String((cch && cch.unsupport_wifi_country_list) || '').split(',');
      const codes = cch ? Object.keys(cch).filter((k) => /^[a-z]{2}$/.test(k) && skip.indexOf(k) < 0) : Object.keys(CNAMES);
      const opts = codes.map((k) => [k.toUpperCase(), (CNAMES[k] || k.toUpperCase()) + ' (' + k.toUpperCase() + ')'])
        .sort((a, b) => a[1].localeCompare(b[1], 'ru'));
      if (country && !opts.some((o) => o[0] === country)) opts.unshift([country, country]);
      countryCard = ui.card({ title: 'Страна Wi-Fi', icon: 'globe' },
        el('p', { class: 'muted' }, 'От страны зависят разрешенные каналы и мощность передатчика.'),
        ui.form([{ name: 'country', label: 'Страна', type: 'select', options: opts, value: country }], async (v) => {
          if (v.country === country) return false;
          if (!(await ui.confirm('Сменить страну Wi-Fi на ' + v.country + '? ' + restartNote, { ok: 'Сменить' }))) return false;
          // basic-settings без WifiEnable роутер отвергает (Lua: «нельзя выключить все сети»): шлем все поля как прочитаны
          const body = Object.assign({}, bset, { WifiCountry: v.country, WifiRestart: 1 });
          await api.post('api/wlan/basic-settings', body, { timeout: 60000 });
          ctx.go('wifi');
        }, { submit: 'Сменить' }));
    } else {
      countryCard = ui.card({ title: 'Страна Wi-Fi', icon: 'globe' }, ui.notice('Страна недоступна: api/wlan/basic-settings не ответил.', 'warn'));
    }

    box.appendChild(el('div', { class: 'cols' }, onCard, mainCard, radioCard, countryCard, guestCard));
  },
});
