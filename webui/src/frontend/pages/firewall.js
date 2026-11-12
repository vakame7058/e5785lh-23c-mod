// Безопасность: брандмауэр, проброс портов, DMZ, UPnP, тип NAT.
// Вызовы как в стоке (offweb js/firewallswitch.js, virtualserver.js, dmzsettings.js, upnp.js, nat.js;
// Lua 23c app/html/api/security/*): api/security/firewall-switch, virtual-servers, dmz, upnp, nat;
// api/ntwk/lan_upnp_portmapping (список правил UPnP, может быть выключен — 100002); api/dhcp/settings (сеть).
// Редкое (фильтры IP, приложения, SIP ALG, маршруты) — ссылкой на стоковые страницы.

const PROTO = [['0', 'TCP и UDP'], ['6', 'TCP'], ['17', 'UDP']];
const PROTO_NAME = { 0: 'TCP и UDP', 6: 'TCP', 17: 'UDP' };
const MAX_RULES = 16;          // сток: VIRTUAL_SERVER_NUM

const RARE = [
  ['lanipfilter.html', 'Фильтр IP-адресов', 'запрет или разрешение доступа в интернет по адресам и портам'],
  ['specialapplication.html', 'Особые приложения', 'открытие портов по исходящему соединению'],
  ['sipalgsettings.html', 'SIP ALG', 'помощь IP-телефонии через NAT'],
  ['staticroute.html', 'Статические маршруты', 'маршруты к другим сетям'],
];

const ip2n = (s) => {
  const m = String(s || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};
const subhead = (ui, text) => ui.subhead(text);
const stack = (ui, ...kids) => ui.el('div', { class: 'stack' }, kids);
const port = (v) => /^\d{1,5}$/.test(String(v)) && Number(v) >= 1 && Number(v) <= 65535;
const range = (a, b) => (String(a) === String(b) || !b ? String(a) : a + '–' + b);

// Кусок страницы, который не загрузился, не ломает остальные
const section = (ui, title, loader) => {
  const body = ui.el('div', null, ui.spinner());
  const c = ui.card(title, body);
  c.reload = async () => {
    try {
      const nodes = await loader();
      ui.clear(body);
      ui.add(body, [nodes]);
    } catch (e) {
      ui.clear(body);
      body.appendChild(e && e.code === '100002'
        ? ui.notice('На этом роутере функция недоступна.', 'info')
        : ui.notice('Не удалось загрузить. ' + ((e && e.message) || ''), 'err'));
    }
  };
  return c;
};

M.page({
  id: 'firewall',
  title: 'Брандмауэр',
  group: 'Безопасность',
  icon: 'shield',
  order: 310,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;
    let lan = null;
    try { lan = await ctx.api.get('api/dhcp/settings'); } catch (e) { lan = null; }

    const inLan = (v) => {
      const x = ip2n(v);
      if (x === null) return 'Неверный адрес. Пример: 192.168.1.100.';
      if (lan) {
        const ip = ip2n(lan.DhcpIPAddress);
        const mask = ip2n(lan.DhcpLanNetmask);
        if (ip !== null && mask !== null && ((x & mask) >>> 0) !== ((ip & mask) >>> 0)) return 'Адрес должен быть в локальной сети роутера.';
        if (x === ip) return 'Это адрес самого роутера.';
      }
      return '';
    };

    // --- брандмауэр ---
    const fw = section(ui, { title: 'Брандмауэр', icon: 'shield' }, async () => {
      const d = await ctx.api.get('api/security/firewall-switch');
      const st = {
        FirewallMainSwitch: d.FirewallMainSwitch,
        FirewallIPFilterSwitch: d.FirewallIPFilterSwitch,
        FirewallWanPortPingSwitch: d.FirewallWanPortPingSwitch,
        firewallmacfilterswitch: d.firewallmacfilterswitch,
        firewallurlfilterswitch: d.firewallurlfilterswitch,
      };
      const save = async (patch) => {
        await ctx.api.post('api/security/firewall-switch', Object.assign({}, st, patch));
        Object.assign(st, patch);
        ui.toast('Сохранено', 'ok');
        fw.reload();
      };
      const main = String(st.FirewallMainSwitch) === '1';
      return stack(ui,
        ui.toggle('Брандмауэр включен', main, async (v) => {
          if (!v && !(await ui.confirm('Выключить брандмауэр? Роутер перестанет отсекать входящие соединения ' +
            'из сети оператора, а фильтры ниже перестанут действовать.', { danger: true, ok: 'Выключить' }))) return false;
          await save({ FirewallMainSwitch: v ? 1 : 0 });
        }, { hint: 'Отсекает входящие соединения из интернета и включает фильтры ниже.' }),
        ui.toggle('Отвечать на ping из интернета', String(st.FirewallWanPortPingSwitch) === '1',
          (v) => save({ FirewallWanPortPingSwitch: v ? 1 : 0 }),
          { disabled: !main, hint: 'Обычно не нужно: так роутер меньше заметен снаружи.' }),
        ui.toggle('Фильтр IP-адресов', String(st.FirewallIPFilterSwitch) === '1',
          (v) => save({ FirewallIPFilterSwitch: v ? 1 : 0 }),
          { disabled: !main, hint: 'Правила фильтра — на стоковой странице, ссылка внизу.' }));
    });

    // --- проброс портов ---
    const vs = section(ui, { title: 'Проброс портов', icon: 'link' }, async () => {
      const d = await ctx.api.get('api/security/virtual-servers');
      let list = M.arr(d && d.Servers && d.Servers.Server);
      const ex = d && d.virtualserverexcludeports && d.virtualserverexcludeports.excludeport;
      const busy = ex ? [ex.virtual_server_special_ports, ex.virtual_server_special_portintervals].filter(Boolean).join(', ') : '';

      const save = async (next) => {
        await ctx.api.post('api/security/virtual-servers', {
          Servers: {
            Server: next.map((s) => ({
              VirtualServerIPName: s.VirtualServerIPName,
              VirtualServerStatus: s.VirtualServerStatus,
              VirtualServerRemoteIP: s.VirtualServerRemoteIP || '',
              VirtualServerWanPort: s.VirtualServerWanPort,
              VirtualServerWanEndPort: s.VirtualServerWanEndPort,
              VirtualServerLanPort: s.VirtualServerLanPort,
              VirtualServerLanEndPort: s.VirtualServerLanEndPort,
              VirtualServerIPAddress: s.VirtualServerIPAddress,
              VirtualServerProtocol: s.VirtualServerProtocol,
            })),
          },
        });
        ui.toast('Сохранено', 'ok');
        vs.reload();
      };

      const tbl = ui.table([
        { key: 'VirtualServerIPName', title: 'Название' },
        { key: 'wan', title: 'Порт снаружи', render: (s) => range(s.VirtualServerWanPort, s.VirtualServerWanEndPort) },
        { key: 'lan', title: 'Устройство и порт', render: (s) => s.VirtualServerIPAddress + ':' + range(s.VirtualServerLanPort, s.VirtualServerLanEndPort) },
        { key: 'p', title: 'Протокол', render: (s) => PROTO_NAME[M.int(s.VirtualServerProtocol)] || s.VirtualServerProtocol },
        { key: 'on', title: 'Включено', render: (s, i) => {
          const sw = ui.switchInput(String(s.VirtualServerStatus) === '1', async (ev) => {
            const next = list.map((x, j) => (j === i ? Object.assign({}, x, { VirtualServerStatus: ev.target.checked ? 1 : 0 }) : x));
            try { await save(next); } catch (e) { ev.target.checked = !ev.target.checked; ui.toast(e.message, 'err'); }
          });
          sw.firstChild.setAttribute('aria-label', 'Включить правило ' + s.VirtualServerIPName);
          return sw;
        } },
        { key: 'x', title: '', render: (s, i) => ui.btn('', async () => {
          if (!(await ui.confirm('Удалить правило «' + s.VirtualServerIPName + '»?', { danger: true, ok: 'Удалить' }))) return;
          await save(list.filter((x, j) => j !== i));
        }, 'ghost', { icon: 'trash', title: 'Удалить правило' }) },
      ], list, { empty: 'Правил нет.' });

      const add = ui.form([
        { name: 'name', label: 'Название', required: true, maxlength: 31, placeholder: 'Камера',
          validate: (v) => (list.some((s) => s.VirtualServerIPName === v) ? 'Такое название уже есть.' : '') },
        { name: 'wan', label: 'Порт снаружи', required: true, placeholder: '8080 или 8000-8010',
          validate: (v) => {
            const p = String(v).split('-');
            if (!p.every(port) || p.length > 2) return 'Порт 1–65535 или диапазон «от-до».';
            if (p[1] && Number(p[1]) < Number(p[0])) return 'Конец диапазона меньше начала.';
            return '';
          } },
        { name: 'ip', label: 'Адрес устройства', required: true, placeholder: '192.168.1.100', validate: inLan },
        { name: 'lan', label: 'Порт устройства', placeholder: 'как снаружи',
          hint: 'Пусто — тот же порт, что снаружи.',
          validate: (v, all) => {
            if (!v) return '';
            const p = String(v).split('-');
            if (!p.every(port) || p.length > 2) return 'Порт 1–65535 или диапазон «от-до».';
            const w = String(all.wan).split('-');
            const wl = (Number(w[1] || w[0]) - Number(w[0]));
            const ll = (Number(p[1] || p[0]) - Number(p[0]));
            if (wl !== ll) return 'Диапазоны снаружи и у устройства должны быть одной длины.';
            return '';
          } },
        { name: 'proto', label: 'Протокол', type: 'select', options: PROTO, value: '0' },
      ], async (v) => {
        if (list.length >= MAX_RULES) throw new Error('Не больше ' + MAX_RULES + ' правил.');
        const w = v.wan.split('-');
        const l = (v.lan || v.wan).split('-');
        await save(list.concat([{
          VirtualServerIPName: v.name, VirtualServerStatus: 1, VirtualServerRemoteIP: '',
          VirtualServerWanPort: w[0], VirtualServerWanEndPort: w[1] || w[0],
          VirtualServerLanPort: l[0], VirtualServerLanEndPort: l[1] || l[0],
          VirtualServerIPAddress: v.ip, VirtualServerProtocol: v.proto,
        }]));
        return false;
      }, { submit: 'Добавить правило', primary: true });

      return [
        el('p', { class: 'hint' }, 'Открывает порт роутера для устройства в вашей сети. ' +
          'Работает, только если оператор дает внешний адрес: за NAT оператора (адреса 10.x, 100.64–100.127.x) снаружи порт не виден.'),
        // широкая карточка: таблица слева, форма нового правила справа
        ui.split([
          tbl,
          busy ? el('p', { class: 'hint' }, 'Заняты роутером, нельзя пробросить: ' + busy + '.') : null,
        ], [
          list.length < MAX_RULES ? subhead(ui, 'Новое правило') : ui.notice('Достигнут предел: ' + MAX_RULES + ' правил.', 'info'),
          list.length < MAX_RULES ? add : null,
        ], { big: true }),
      ];
    });

    // --- DMZ: переключатель применяется сразу (как везде на странице), адрес — кнопкой «Сохранить адрес» ---
    const dmz = section(ui, 'DMZ', async () => {
      const d = await ctx.api.get('api/security/dmz');
      let on = String(d.DmzStatus) === '1';
      let ip = String(d.DmzIPAddress || '');
      const f = ui.form([
        { name: 'ip', label: 'Адрес устройства', value: ip, placeholder: '192.168.1.100', validate: (v) => (v ? inLan(v) : '') },
      ], async (v) => {
        if (!v.ip) throw new Error('Укажите адрес устройства.');
        if (on && !(await ui.confirm('Все входящие соединения из интернета пойдут на ' + v.ip +
          '. Это устройство окажется без защиты брандмауэра. Продолжить?', { danger: true, ok: 'Сохранить' }))) return false;
        await ctx.api.post('api/security/dmz', { DmzStatus: on ? 1 : 0, DmzIPAddress: v.ip });
        ip = v.ip;
      }, { submit: 'Сохранить адрес' });
      const t = ui.toggle('DMZ включена', on, async (v) => {
        const want = f.values().ip || ip;
        if (v && (!want || inLan(want))) { ui.toast('Сначала укажите адрес устройства в своей сети.', 'warn'); f.field('ip').focus(); return false; }
        if (v && !(await ui.confirm('Все входящие соединения из интернета пойдут на ' + want +
          '. Это устройство окажется без защиты брандмауэра. Включить?', { danger: true, ok: 'Включить' }))) return false;
        await ctx.api.post('api/security/dmz', { DmzStatus: v ? 1 : 0, DmzIPAddress: want });
        on = v;
        ip = want;
        ui.toast(v ? 'DMZ включена' : 'DMZ выключена', 'ok');
      }, { hint: 'Все порты, которые не заняты пробросом, направляются на одно устройство.' });
      return [t, f];
    });

    // --- UPnP ---
    const upnp = section(ui, 'UPnP', async () => {
      const d = await ctx.api.get('api/security/upnp');
      const on = String(d.UpnpStatus) === '1';
      const out = [
        ui.toggle('UPnP включен', on, async (v) => {
          await ctx.api.post('api/security/upnp', { UpnpStatus: v ? 1 : 0 });
          ui.toast('Сохранено', 'ok');
          upnp.reload();
        }, { hint: 'Программы в сети сами открывают нужные порты (игры, торренты). Удобно, но менее безопасно.' }),
      ];
      if (on) {
        try {
          const m = await ctx.api.get('api/ntwk/lan_upnp_portmapping');
          const list = M.arr(m && m.upnpportmappings && (m.upnpportmappings.upnpportmapping || m.upnpportmappings));
          out.push(subhead(ui, 'Открытые программами порты'));
          out.push(ui.table([
            { key: 'portmappingdesc', title: 'Программа' },
            { key: 'externalport', title: 'Порт снаружи' },
            { key: 'internalclient', title: 'Устройство' },
            { key: 'protocol', title: 'Протокол' },
          ], list.filter((x) => typeof x === 'object'), { empty: 'Сейчас программы ничего не открыли.' }));
        } catch (e) { /* список правил выключен в прошивке */ }
      }
      return out;
    });

    // --- NAT: выбор применяется сразу ---
    const nat = section(ui, 'Тип NAT', async () => {
      const d = await ctx.api.get('api/security/nat');
      let cur = String(M.int(d.NATType, 1));
      const sel = el('select', { class: 'inp', id: 'nat-type', 'aria-label': 'Тип NAT' },
        el('option', { value: '1' }, 'Конусный (cone)'), el('option', { value: '0' }, 'Симметричный (symmetric)'));
      sel.value = cur;
      sel.addEventListener('change', async () => {
        sel.disabled = true;
        try {
          await ctx.api.post('api/security/nat', { NATType: sel.value });
          cur = sel.value;
          ui.toast('Тип NAT сохранен', 'ok');
        } catch (e) { sel.value = cur; ui.toast(e.message, 'err'); } finally { sel.disabled = false; }
      });
      return [sel, el('small', { class: 'hint' }, 'Конусный лучше для игр и звонков, симметричный строже. Если не знаете — оставьте конусный. Применяется сразу.')];
    });

    const links = ui.card('Редкие настройки',
      el('p', { class: 'hint' }, 'Эти настройки открываются в стоковом интерфейсе роутера, в новой вкладке. ' +
        'Там может понадобиться войти еще раз.'),
      el('ul', { class: 'link-list' }, RARE.map((r) => el('li', null,
        el('a', { href: '/html/' + r[0], target: '_blank', rel: 'noopener' }, r[1]),
        el('small', { class: 'hint' }, r[2])))));

    // широкая карточка с таблицей — сверху на всю ширину, мелкие настройки — ниже кладкой
    root.appendChild(vs);
    root.appendChild(ui.grid(fw, upnp, dmz, nat, links));
    await Promise.all([fw.reload(), vs.reload(), dmz.reload(), upnp.reload(), nat.reload()]);
  },
});
