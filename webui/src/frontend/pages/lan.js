// Локальная сеть: адрес роутера, DHCP-сервер, постоянные адреса устройств.
// Вызовы как в стоке (offweb js/dhcp.js, Lua 23c app/html/api/dhcp/*): api/dhcp/settings (GET/POST),
// api/dhcp/static-addr-info (GET/POST; на роутере может быть выключено — ответ 100002).

const LEASES = [
  ['3600', '1 час'], ['7200', '2 часа'], ['21600', '6 часов'], ['43200', '12 часов'],
  ['86400', '1 сутки'], ['172800', '2 суток'], ['604800', '1 неделя'],
];
const MASKS = [['255.255.255.0', '255.255.255.0 (/24)'], ['255.255.0.0', '255.255.0.0 (/16)'],
  ['255.255.255.128', '255.255.255.128 (/25)'], ['255.255.254.0', '255.255.254.0 (/23)']];

const ip2n = (s) => {
  const m = String(s || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};
const subhead = (ui, text) => ui.subhead(text);
const isMac = (s) => /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(String(s || '').trim());
const normMac = (s) => String(s || '').trim().replace(/-/g, ':').toUpperCase();

M.page({
  id: 'lan',
  title: 'Локальная сеть',
  group: 'Сеть',
  icon: 'router',
  order: 220,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;
    let cur = null;

    const sameNet = (a, all) => {
      const ip = ip2n(all.ip);
      const mask = ip2n(all.mask);
      const x = ip2n(a);
      if (x === null) return 'Неверный адрес. Пример: 192.168.1.100.';
      if (ip !== null && mask !== null && ((x & mask) >>> 0) !== ((ip & mask) >>> 0)) return 'Адрес должен быть в сети роутера.';
      if (x === ip) return 'Совпадает с адресом роутера.';
      return '';
    };

    const lanForm = ui.form([
      { name: 'ip', label: 'Адрес роутера', required: true, placeholder: '192.168.1.1',
        validate: (v) => (ip2n(v) === null ? 'Неверный адрес. Пример: 192.168.1.1.' : '') },
      { name: 'mask', label: 'Маска подсети', type: 'select', options: MASKS },
      { name: 'dhcp', label: 'Раздавать адреса (DHCP)', type: 'toggle',
        hint: 'Без DHCP адреса устройствам нужно задавать вручную.' },
      { name: 'start', label: 'Первый адрес', show: (v) => v.dhcp, validate: (v, all) => (all.dhcp ? sameNet(v, all) : '') },
      { name: 'end', label: 'Последний адрес', show: (v) => v.dhcp,
        validate: (v, all) => {
          if (!all.dhcp) return '';
          const e = sameNet(v, all);
          if (e) return e;
          if (ip2n(v) < ip2n(all.start)) return 'Последний адрес меньше первого.';
          const ip = ip2n(all.ip);
          if (ip >= ip2n(all.start) && ip <= ip2n(v)) return 'Адрес роутера попадает в диапазон. Сдвиньте диапазон.';
          return '';
        } },
      { name: 'lease', label: 'Срок аренды адреса', type: 'select', options: LEASES, show: (v) => v.dhcp,
        hint: 'Через этот срок устройство заново просит адрес.' },
    ], async (v) => {
      const ipChanged = cur && v.ip !== cur.DhcpIPAddress;
      if (ipChanged) {
        const ok = await ui.confirm('Адрес роутера сменится на ' + v.ip + '. Устройства переподключатся, ' +
          'а этот интерфейс откроется по новому адресу: http://' + v.ip + '/. Продолжить?', { ok: 'Сменить адрес' });
        if (!ok) return false;
      }
      const body = Object.assign({}, cur, {
        DhcpIPAddress: v.ip,
        DhcpLanNetmask: v.mask,
        DhcpStatus: v.dhcp ? 1 : 0,
        DhcpStartIPAddress: v.dhcp ? v.start : cur.DhcpStartIPAddress,
        DhcpEndIPAddress: v.dhcp ? v.end : cur.DhcpEndIPAddress,
        DhcpLeaseTime: v.dhcp ? v.lease : cur.DhcpLeaseTime,
      });
      // только поля, которые читает обработчик (Lua dhcp/settings.lua)
      const keys = ['DhcpIPAddress', 'DhcpLanNetmask', 'DhcpStatus', 'DhcpStartIPAddress', 'DhcpEndIPAddress',
        'DhcpLeaseTime', 'DnsStatus', 'PrimaryDns', 'SecondaryDns'];
      const out = {};
      keys.forEach((k) => { if (body[k] !== undefined) out[k] = body[k]; });
      if (ipChanged) {
        // роутер может не успеть ответить: адрес меняется сразу
        ctx.api.post('api/dhcp/settings', out, { timeout: 45000 }).catch(() => {});
        newAddr.textContent = '';
        newAddr.appendChild(ui.notice(el('span', null, 'Адрес меняется. Через минуту откройте ',
          el('a', { href: 'http://' + v.ip + '/' }, 'http://' + v.ip + '/'),
          '. Если не открывается — переподключитесь к Wi-Fi роутера.'), 'warn'));
        return false;
      }
      await ctx.api.post('api/dhcp/settings', out, { timeout: 45000 });
      await load();
    }, { primary: true });
    const newAddr = el('div');
    const dnsKv = ui.kv([]);

    const load = async () => {
      cur = await ctx.api.get('api/dhcp/settings');
      const lease = String(cur.DhcpLeaseTime || '86400');
      if (!LEASES.some((x) => x[0] === lease)) {
        lanForm.setOptions('lease', LEASES.concat([[lease, M.fmt.duration(lease)]]), lease);
      }
      if (!MASKS.some((x) => x[0] === cur.DhcpLanNetmask) && cur.DhcpLanNetmask) {
        lanForm.setOptions('mask', MASKS.concat([[cur.DhcpLanNetmask, cur.DhcpLanNetmask]]), cur.DhcpLanNetmask);
      }
      lanForm.setAll({
        ip: cur.DhcpIPAddress,
        mask: cur.DhcpLanNetmask,
        dhcp: String(cur.DhcpStatus) === '1',
        start: cur.DhcpStartIPAddress,
        end: cur.DhcpEndIPAddress,
        lease,
      });
      dnsKv.update([
        ['DNS-сервер для устройств', String(cur.DnsStatus) === '0'
          ? [cur.PrimaryDns, cur.SecondaryDns].filter(Boolean).join(', ')
          : 'роутер (' + cur.DhcpIPAddress + ')'],
      ]);
    };

    // --- постоянные адреса (привязка IP к MAC) ---
    const staticBox = el('div', null, ui.spinner());
    let hosts = [];
    let staticOn = false;

    const saveHosts = async (list) => {
      const Host = list.map((h, i) => ({
        HostIndex: i + 1, HostHw: h.HostHw, HostIp: h.HostIp, HostEnabled: String(h.HostEnabled) === '0' ? 0 : 1,
      }));
      await ctx.api.post('api/dhcp/static-addr-info', { Hosts: { Host } });
      ui.toast('Сохранено', 'ok');
      await loadStatic();
    };

    const drawStatic = () => {
      ui.clear(staticBox);
      if (!staticOn) {
        staticBox.appendChild(ui.notice('На этом роутере постоянные адреса не настраиваются: функция выключена в прошивке.', 'info'));
        return;
      }
      staticBox.appendChild(ui.table([
        { key: 'HostHw', title: 'MAC-адрес', render: (h) => M.fmt.mac(h.HostHw) },
        { key: 'HostIp', title: 'IP-адрес' },
        { key: 'HostEnabled', title: 'Действует', render: (h) => (String(h.HostEnabled) === '0' ? 'нет' : 'да') },
        { key: 'x', title: '', render: (h, i) => ui.btn('', async () => {
          if (!(await ui.confirm('Удалить привязку ' + M.fmt.mac(h.HostHw) + ' → ' + h.HostIp + '?', { danger: true, ok: 'Удалить' }))) return;
          await saveHosts(hosts.filter((x, j) => j !== i));
        }, 'ghost', { icon: 'trash', title: 'Удалить' }) },
      ], hosts, { empty: 'Привязок нет.' }));
      const add = ui.form([
        { name: 'mac', label: 'MAC-адрес', placeholder: 'AA:BB:CC:DD:EE:FF', required: true,
          validate: (v) => (!isMac(v) ? 'Неверный MAC. Пример: AA:BB:CC:DD:EE:FF.'
            : hosts.some((h) => normMac(h.HostHw) === normMac(v)) ? 'Этот MAC уже есть в списке.' : '') },
        { name: 'ip', label: 'IP-адрес', placeholder: '192.168.1.50', required: true,
          validate: (v) => {
            if (ip2n(v) === null) return 'Неверный адрес.';
            if (cur && ip2n(v) === ip2n(cur.DhcpIPAddress)) return 'Это адрес роутера.';
            if (hosts.some((h) => h.HostIp === v)) return 'Этот адрес уже занят в списке.';
            return '';
          } },
      ], async (v) => {
        await saveHosts(hosts.concat([{ HostHw: normMac(v.mac), HostIp: v.ip, HostEnabled: 1 }]));
        return false;
      }, { submit: 'Добавить' });
      staticBox.appendChild(subhead(ui, 'Добавить привязку'));
      staticBox.appendChild(add);
    };

    const loadStatic = async () => {
      try {
        const d = await ctx.api.get('api/dhcp/static-addr-info');
        staticOn = true;
        hosts = M.arr(d && d.Hosts && d.Hosts.Host);
      } catch (e) {
        staticOn = false;
        if (e.code !== '100002') {
          ui.clear(staticBox);
          staticBox.appendChild(ui.notice('Не удалось получить привязки. ' + e.message, 'err'));
          return;
        }
      }
      drawStatic();
    };

    // --- имя роутера в сети: M.mod('lanname') (docs/API.md, модуль lanname) ---
    const nameBox = el('div', { class: 'stack' }, ui.spinner());
    // все три карточки небольшие — кладкой колонок, без карточек на всю ширину
    root.appendChild(newAddr);
    root.appendChild(ui.grid(
      ui.card({ title: 'Адрес роутера и DHCP', icon: 'router' },
        ui.notice('Ошибка в этих настройках может отрезать доступ к роутеру по Wi-Fi и USB. ' +
          'Тогда поможет сброс кнопкой на корпусе.', 'warn'),
        lanForm, dnsKv),
      ui.card({ title: 'Имя роутера в сети', icon: 'globe' }, nameBox),
      ui.card({ title: 'Постоянные адреса', sub: 'устройство всегда получает один и тот же IP' }, staticBox)));
    const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
    const checkHost = (v) => {
      if (!v) return 'Заполните поле.';
      if (!LABEL.test(v)) return 'Только латинские буквы a–z, цифры и дефис; не длиннее 63 символов; дефис не в начале и не в конце.';
      return '';
    };
    const checkDomain = (v) => {
      if (!v) return '';
      const parts = v.split('.');
      if (parts.some((x) => !LABEL.test(x))) return 'Части через точку: латинские буквы a–z, цифры и дефис.';
      if (parts[parts.length - 1] === 'local') {
        return 'Окончание .local не подходит: такие имена обслуживает mDNS, обычный DNS их не находит. Возьмите, например, lan или home.arpa.';
      }
      if (v.length > 200) return 'Слишком длинно.';
      return '';
    };
    // docs/API.md, lanname: device_name, domain_name, homeurl, lan_ip, dns_ip, dns_ok, web_status, web_ok, check_error
    const drawName = (d, rebootNeeded) => {
      const dev = String(d.device_name || '');
      const dom = String(d.domain_name || '');
      const full = (n, m) => (m ? n + '.' + m : n);
      const home = String(d.homeurl || full(dev, dom));
      const okText = (v, yes, no) => (v === undefined || v === '' ? '' : String(v) === '1' ? yes : no);
      ui.clear(nameBox);
      nameBox.appendChild(ui.kv([
        ['Адрес по имени', home ? el('a', { href: 'http://' + home + '/' }, 'http://' + home + '/') : '—'],
        ['Адрес по IP', 'http://' + (d.lan_ip || location.hostname) + '/'],
        d.check_error ? ['Проверка', 'не выполнена', String(d.check_error)] : null,
        !d.check_error ? ['DNS роутера', okText(d.dns_ok, 'знает имя', 'имя пока не знает' + (d.dns_ip ? ' (' + d.dns_ip + ')' : ''))] : null,
        !d.check_error ? ['Веб по имени', okText(d.web_ok, 'открывается', 'не пускает' + (d.web_status ? ' (код ' + d.web_status + ')' : ''))] : null,
      ].filter((r) => r && r[1] !== '')));
      if (rebootNeeded) nameBox.appendChild(ui.notice('Роутер просит перезагрузку, чтобы новое имя заработало везде.', 'warn'));
      const f = ui.form([
        { name: 'device_name', label: 'Имя роутера', value: dev, required: true, maxlength: 63, placeholder: 'router',
          validate: (v) => checkHost(v.toLowerCase()) },
        { name: 'domain_name', label: 'Домен', value: dom, maxlength: 200, placeholder: 'lan',
          hint: 'Можно оставить пустым. Окончание .local не подходит.', validate: (v) => checkDomain(v.toLowerCase()) },
      ], async (v) => {
        const n = v.device_name.toLowerCase();
        const m = v.domain_name.toLowerCase();
        if (n === dev && m === dom) return false;
        if (!(await ui.confirm('Сменить имя роутера на ' + full(n, m) + '?\n\nПосле смены интерфейс откроется и по адресу http://' + full(n, m) +
          '/. Устройства узнают новое имя, когда заново подключатся к сети. Адрес ' + (d.lan_ip || location.hostname) + ' продолжит работать.', { ok: 'Сменить' }))) return false;
        const r = await ctx.mod('lanname', 'set', { device_name: n, domain_name: m });
        drawName(r && typeof r === 'object' ? r : { device_name: n, domain_name: m }, r && String(r.reboot_needed) === '1');
      }, { submit: 'Сменить имя' });
      nameBox.appendChild(f);
    };
    const loadName = async () => {
      let d;
      try { d = await ctx.mod('lanname'); } catch (e) {
        ui.clear(nameBox);
        nameBox.appendChild(ui.notice('Смена имени недоступна: ' + e.message, 'warn'));
        if (cur && cur.homeurl) nameBox.appendChild(ui.kv([['Имя сейчас', cur.homeurl]]));
        return;
      }
      drawName(d, false);
    };

    try {
      await load();
    } catch (e) {
      lanForm.replaceWith(ui.notice('Не удалось получить настройки сети. ' + e.message, 'err'));
    }
    await loadName();
    await loadStatic();
  },
});
