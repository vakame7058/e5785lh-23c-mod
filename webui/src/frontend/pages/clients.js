// Клиенты Wi-Fi и запрет по MAC (стоковый фильтр MAC: api/wlan/multi-macfilter-settings)
const { el } = M.ui;

// WifiMacFilterStatus: 0 — выключен, 1 — пускать только из списка, 2 — не пускать из списка
const FMODE = [['0', 'Выключен'], ['2', 'Запрещать устройства из списка'], ['1', 'Пускать только устройства из списка']];
const MAX = 10;
const normMac = (m) => String(m || '').trim().toUpperCase().replace(/-/g, ':');
const macOk = (m) => /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(m);

M.page({
  id: 'clients', title: 'Клиенты', group: 'Сеть', icon: 'clients', order: 30,
  async render(box, ctx) {
    const ui = ctx.ui;
    const api = ctx.api;
    let filt = null;       // массив Ssid из multi-macfilter-settings
    let filtErr = null;
    let hosts = [];

    const list = () => {
      const s = filt && filt[0];
      if (!s) return [];
      const r = [];
      for (let i = 0; i < MAX; i++) {
        const mac = normMac(s['WifiMacFilterMac' + i]);
        if (mac) r.push({ mac, name: s['wifihostname' + i] || '' });
      }
      return r;
    };
    const mode = () => (filt && filt[0] ? String(filt[0].WifiMacFilterStatus) : '0');

    // запись: одинаковый список во все сети, как у стока
    const saveFilter = async (status, entries) => {
      const ss = (filt && filt.length ? filt : [{ Index: '0' }]).map((s) => {
        const o = { Index: s.Index, WifiMacFilterStatus: status };
        for (let i = 0; i < MAX; i++) {
          const e = status === '0' ? null : entries[i];
          o['WifiMacFilterMac' + i] = e ? e.mac : '';
          o['wifihostname' + i] = e ? e.name : '';
        }
        return o;
      });
      await api.post('api/wlan/multi-macfilter-settings', { Ssids: { Ssid: ss } });
      await loadFilter();
    };
    const loadFilter = async () => {
      try {
        const r = await api.get('api/wlan/multi-macfilter-settings');
        filt = M.arr(r.Ssids && r.Ssids.Ssid);
        filtErr = null;
      } catch (e) { filt = null; filtErr = e; }
      renderFilter();
      renderHosts();
    };

    const ban = async (h) => {
      const mac = normMac(h.MacAddress);
      const cur = list();
      if (cur.some((e) => e.mac === mac)) return;
      if (cur.length >= MAX) throw new Error('В списке уже ' + MAX + ' устройств — это предел роутера.');
      const name = h.HostName || mac;
      if (!(await ui.confirm('Запретить устройству «' + name + '» (' + mac + ') подключаться к Wi-Fi?\n\nОно отключится сразу. Если это ваше устройство, вы потеряете доступ к роутеру по Wi-Fi.',
        { title: 'Запрет по MAC', ok: 'Запретить', danger: true }))) return;
      await saveFilter('2', cur.concat([{ mac, name: h.HostName || '' }]));
      ui.toast('Устройство запрещено', 'ok');
    };
    const unban = async (e) => {
      const m = mode();
      const what = m === '1' ? 'Убрать «' + (e.name || e.mac) + '» из списка разрешенных? Устройство больше не сможет подключиться.'
        : 'Разрешить устройству «' + (e.name || e.mac) + '» подключаться?';
      if (!(await ui.confirm(what, { ok: m === '1' ? 'Убрать' : 'Разрешить', danger: m === '1' }))) return;
      const rest = list().filter((x) => x.mac !== e.mac);
      await saveFilter(rest.length || m === '1' ? m : '0', rest);
      ui.toast('Список обновлен', 'ok');
    };

    // --- подключенные ---
    const hostsBox = el('div');
    const hostsCard = ui.card({ title: 'Подключены к Wi-Fi', icon: 'wifi', actions: [ui.btn('', () => poll.now(), 'ghost', { icon: 'refresh', title: 'Обновить', class: 'btn-sm' })] }, hostsBox);
    function renderHosts() {
      const banned = list().map((e) => e.mac);
      const m = mode();
      ui.clear(hostsBox).appendChild(ui.table([
        { key: 'HostName', title: 'Устройство', render: (h) => el('div', { class: 'host' }, el('b', null, h.HostName || 'Без имени'), el('small', { class: 'mono muted' }, normMac(h.MacAddress))) },
        { key: 'IpAddress', title: 'IP', render: (h) => el('span', { class: 'mono' }, String(h.IpAddress || '').split(';')[0]) },
        { key: 'AssociatedTime', title: 'Подключено', render: (h) => M.fmt.duration(h.AssociatedTime) },
        { key: '_', title: '', cls: 'r', render: (h) => (banned.indexOf(normMac(h.MacAddress)) >= 0 && m === '2' ? ui.badge('запрещено', 'err')
          : m === '1' ? '' : ui.btn('Запретить', () => ban(h), '', { icon: 'block', class: 'btn-sm' })) },
      ], hosts, { empty: 'Сейчас к Wi-Fi никто не подключен' }));
    }

    // --- фильтр ---
    const filtBox = el('div', { class: 'stack' });
    const filtCard = ui.card({ title: 'Фильтр по MAC', icon: 'shield' }, filtBox);
    function renderFilter() {
      ui.clear(filtBox);
      if (filtErr) { filtBox.appendChild(ui.notice('Фильтр недоступен: ' + filtErr.message, 'warn')); return; }
      const m = mode();
      const entries = list();
      const sel = el('select', { class: 'inp', id: 'mf-mode' }, FMODE.map((x) => el('option', { value: x[0] }, x[1])));
      sel.value = m;
      sel.addEventListener('change', async () => {
        const nv = sel.value;
        let text = '';
        if (nv === '0') text = 'Выключить фильтр? Список устройств очистится: так требует роутер.';
        else if (nv === '1') text = 'Пускать только устройства из списка? Остальные отключатся сразу. Добавьте в список свое устройство, иначе потеряете доступ по Wi-Fi.';
        else text = 'Запрещать устройства из списка? Устройства из списка отключатся.';
        if (nv === '1' && !entries.length) { ui.toast('Список пуст: сначала добавьте разрешенные устройства.', 'warn'); sel.value = m; return; }
        if (!(await ui.confirm(text, { ok: 'Применить', danger: nv !== '2' }))) { sel.value = m; return; }
        try { await saveFilter(nv, entries); ui.toast('Фильтр изменен', 'ok'); } catch (e) { sel.value = m; ui.toast(e.message, 'err'); }
      });
      filtBox.appendChild(el('div', { class: 'f-row' }, el('label', { class: 'f-l', for: 'mf-mode' }, 'Режим'), sel));
      if (m === '1') filtBox.appendChild(ui.notice('Включен список разрешенных: подключиться могут только устройства из списка. Кнопка «Запретить» в этом режиме не показывается.', 'info'));
      filtBox.appendChild(ui.table([
        { key: 'name', title: 'Устройство', render: (e) => el('div', { class: 'host' }, el('b', null, e.name || 'Без имени'), el('small', { class: 'mono muted' }, e.mac)) },
        { key: '_', title: '', cls: 'r', render: (e) => ui.btn(m === '1' ? 'Убрать' : 'Разрешить', () => unban(e), '', { icon: m === '1' ? 'trash' : 'check', class: 'btn-sm' }) },
      ], entries, { empty: m === '0' ? 'Фильтр выключен, список пуст' : 'Список пуст' }));
      if (entries.length < MAX && m !== '0') {
        const f = ui.form([
          { name: 'mac', label: 'MAC-адрес', placeholder: 'AA:BB:CC:DD:EE:FF', required: true, validate: (v) => (macOk(normMac(v)) ? '' : 'Формат: AA:BB:CC:DD:EE:FF.') },
          { name: 'name', label: 'Имя', maxlength: 32 },
        ], async (v) => {
          const mac = normMac(v.mac);
          if (entries.some((e) => e.mac === mac)) throw new Error('Этот MAC уже в списке.');
          await saveFilter(m, entries.concat([{ mac, name: v.name }]));
        }, { submit: 'Добавить', done: 'Добавлено' });
        filtBox.appendChild(el('details', { class: 'more' }, el('summary', null, 'Добавить вручную'), f));
      }
      filtBox.appendChild(el('small', { class: 'hint' }, 'В списке до ' + MAX + ' устройств. Фильтр действует только на Wi-Fi.'));
    }

    // список устройств — большая колонка, фильтр — малая рядом
    box.appendChild(ui.stacks21(hostsCard, filtCard));
    const poll = ui.poll(async () => {
      const r = await api.get('api/wlan/host-list');
      hosts = M.arr(r.Hosts && r.Hosts.Host);
      renderHosts();
    }, 10000, { onError: (e) => { ui.clear(hostsBox).appendChild(ui.notice('Список не получен: ' + e.message, 'err')); } });
    await loadFilter();
  },
});
