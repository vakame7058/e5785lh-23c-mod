// Сводка: сеть, скорость, трафик, батарея, клиенты, мобильные данные
const { el } = M.ui;

const CONN = { 900: ['Подключается', 'warn'], 901: ['Подключено', 'ok'], 902: ['Отключено', 'muted'], 903: ['Отключается', 'warn'] };
const SIM = { 255: 'Нет SIM-карты', 256: 'SIM-карта не читается', 260: 'Нужен PIN-код', 261: 'Нужен PUK-код' };

M.page({
  id: 'home', title: 'Сводка', icon: 'home', order: 1,
  async render(box, ctx) {
    const ui = ctx.ui;
    const info = await Promise.all([
      ctx.api.get('api/device/basic_information').catch(() => ({})),
      ctx.api.get('api/dialup/mobile-dataswitch').catch(() => null),
      ctx.api.get('api/device/information').catch(() => ({})),
      ctx.api.get('api/dhcp/settings').catch(() => ({})),
    ]);
    const basic = info[0];
    const dataSw = info[1];
    const dev = info[2];
    const lan = info[3];

    // --- сеть ---
    const opName = el('div', { class: 'hero-op' }, '—');
    const opSub = el('div', { class: 'hero-sub' });
    const bars = el('div', { class: 'hero-bars' });
    const connBadge = el('span');
    const simNote = el('div');
    const netKv = ui.kv([]);
    const dataToggle = dataSw ? ui.toggle('Мобильные данные', dataSw.dataswitch === '1', async (v) => {
      if (!v && !(await ui.confirm('Выключить мобильные данные? Интернет через роутер пропадет.', { ok: 'Выключить', danger: true }))) return false;
      await ctx.api.post('api/dialup/mobile-dataswitch', { dataswitch: v ? 1 : 0 });
      ui.toast(v ? 'Мобильные данные включены' : 'Мобильные данные выключены', 'ok');
    }, { hint: 'Передача данных через сотовую сеть' }) : null;

    const netCard = ui.card({ title: 'Сеть', icon: 'antenna', actions: [ui.btn('Сигнал', () => ctx.go('signal'), 'ghost', { icon: 'chevron', class: 'btn-sm' })] },
      el('div', { class: 'hero' }, bars, el('div', { class: 'hero-t' }, opName, opSub), connBadge),
      simNote, netKv, ui.simNumber(ctx), dataToggle);

    // --- скорость ---
    const dl = ui.stat('Загрузка', '—', '', { icon: 'arrowdown', class: 'stat-dl' });
    const ulS = ui.stat('Отдача', '—', '', { icon: 'arrowup', class: 'stat-ul' });
    const hist = { dl: [], ul: [] };
    const chart = ui.chart({ height: 90, auto: true, zero: true, points: 60, label: 'Скорость за последние минуты',
      series: [{ name: 'Загрузка', cls: 's1' }, { name: 'Отдача', cls: 's2' }],
      fmt: (v) => (v >= 1e6 ? (v / 1e6).toFixed(0) + 'М' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'К' : Math.round(v)) });
    const sessKv = ui.kv([]);
    const speedCard = ui.card({ title: 'Скорость и трафик', icon: 'chart' }, el('div', { class: 'stats2' }, dl, ulS), chart, sessKv);

    // --- устройство ---
    const batStat = ui.stat('Батарея', '—', '', { icon: 'battery' });
    const cliStat = ui.stat('Клиенты Wi-Fi', '—', '', { icon: 'clients' });
    const devKv = ui.kv([
      ['Модель', dev.DeviceName || 'E5785Lh-23c'],
      ['Прошивка', basic.SoftwareVersion || dev.SoftwareVersion],
      ['Внешний IP', dev.WanIPAddress],
      ['IP роутера', lan.DhcpIPAddress],
    ]);
    const devCard = ui.card({ title: 'Роутер', icon: 'router' },
      el('div', { class: 'stats2' }, batStat, el('a', { href: '#/clients', class: 'stat-link' }, cliStat)), devKv);

    // --- процессор и память: M.mod('sysinfo') раз в 4 с (веб однопоточный — чаще не нужно) ---
    const cpuMeter = ui.meter(null, 0, 100, 'Процессор', { fmt: (v) => Math.round(v) + ' %', good: 70, bad: 90 });
    const memMeter = ui.meter(null, 0, 100, 'Память занята', { fmt: (v) => Math.round(v) + ' %', good: 75, bad: 90 });
    const resKv = ui.kv([]);
    const resNote = el('div');
    const resCard = ui.card({ title: 'Процессор и память', icon: 'chart' }, el('div', { class: 'res-rows' }, cpuMeter, memMeter), resKv, resNote);
    // датчики sysinfo (docs/API.md): <sensors><sensor><name>battery|sim_card1|pa0|xo0</name><c>37.0</c></sensor>
    const SENSOR = { battery: 'батарея', sim_card1: 'SIM', pa0: 'усилитель', xo0: 'кварц' };
    const temps = (d) => M.arr(d.sensors && d.sensors.sensor).filter((x) => x && typeof x === 'object' && x.c !== undefined && x.c !== '')
      .map((x) => (SENSOR[x.name] || x.name) + ' ' + M.fmt.num(M.num(x.c), 1) + ' °C').join(' · ');
    ui.poll(async () => {
      let d;
      try { d = await ctx.mod('sysinfo'); } catch (e) {
        ui.clear(resNote).appendChild(ui.notice(e.code === '9001' ? 'Помощник мода не отвечает: загрузка недоступна.' : 'Загрузка недоступна: ' + e.message, 'warn'));
        return;
      }
      ui.clear(resNote);
      // docs/API.md, sysinfo: cpu_pct, cpu_mhz/cpu_min_mhz/cpu_max_mhz, mem_total_kb, mem_avail_kb (+ mem_avail_est), mem_used_pct, bat_temp_c
      const cpu = M.num(d.cpu_pct);
      cpuMeter.set(isFinite(cpu) ? Math.max(0, Math.min(100, cpu)) : null);
      const total = M.int(d.mem_total_kb);
      const avail = M.int(d.mem_avail_kb);
      const used = M.num(d.mem_used_pct);
      memMeter.set(isFinite(used) ? used : total ? 100 * (1 - avail / total) : null);
      const mb = (kb) => M.fmt.num(kb / 1024, 0) + ' МБ';
      const est = String(d.mem_avail_est) === '1';
      resKv.update([
        ['Частота процессора', d.cpu_mhz ? d.cpu_mhz + ' МГц' + (d.cpu_max_mhz ? ' из ' + d.cpu_max_mhz : '') : ''],
        [est ? 'Память доступно (оценка)' : 'Память доступно', total ? mb(avail) + ' из ' + mb(total) : '', est ? 'свободно + буферы + кэш' : ''],
        temps(d) ? ['Температура', temps(d)] : d.bat_temp_c !== undefined && d.bat_temp_c !== '' ? ['Температура батареи', d.bat_temp_c + ' °C'] : null,
      ].filter((r) => r && r[1]));
      M.emit('sysinfo', { cpu: isFinite(cpu) ? cpu : null, at: Date.now() });
    }, 4000);

    const dnsWarn = ui.dnsWarn(ctx);
    box.appendChild(dnsWarn.el);
    box.appendChild(el('div', { class: 'cols' }, netCard, speedCard, resCard, devCard));
    // VPN включен, а служба DNS нет; ошибка запроса — просто без предупреждения
    ctx.mod('vpn').then((v) => {
      const a = (v && v.awg) || {};
      const isUp = (x) => String(x && x.up) === '1';
      dnsWarn.update({ vpnUp: isUp(a) || isUp(v && v.wg) || isUp(v && v.ovpn), dnsTunnel: isUp(a) && String(a.dns_mode) === 'tunnel' });
    }).catch(() => {});

    // --- обновление ---
    const showStatus = (st) => {
      if (!st || !st.ConnectionStatus) return;
      const plmn = M.state.plmn || {};
      const sim = SIM[M.state.simState] || (st.SimStatus !== '1' ? 'Нет SIM-карты' : '');
      opName.textContent = sim ? sim : (plmn.FullName || plmn.ShortName || (M.int(st.SignalIcon) ? 'Оператор' : 'Нет сети'));
      const nt = M.netType(st);
      opSub.textContent = [nt, st.RoamingStatus === '1' ? 'роуминг' : '', st.flymode === '1' ? 'режим полета' : ''].filter(Boolean).join(' · ');
      ui.clear(bars).appendChild(ui.bars(M.int(st.SignalIcon), M.int(st.maxsignal, 5)));
      const c = CONN[st.ConnectionStatus] || ['Нет данных', 'muted'];
      ui.clear(connBadge).appendChild(ui.badge(c[0], c[1]));
      ui.clear(simNote);
      if (sim) simNote.appendChild(ui.notice(sim + '. Проверьте SIM-карту.', 'warn'));
      netKv.update([
        ['DNS', [st.PrimaryDns, st.SecondaryDns].filter(Boolean).join(', ')],
      ]);
      const p = M.int(st.BatteryPercent);
      const chg = st.BatteryStatus === '1';
      batStat.set(st.BatteryStatus === '2' ? 'нет' : p + '%', chg ? 'заряжается' : st.BatteryStatus === '-1' ? 'низкий заряд' : 'от батареи');
      cliStat.set(st.CurrentWifiUser || '0', 'из ' + (st.TotalWifiUser || '—') + ' возможных');
    };
    showStatus(M.state.status);
    ctx.onLeave(M.on('status', showStatus));
    ui.poll(async () => {
      try { M.state.simState = (await ctx.api.get('api/pin/status')).SimState; } catch (e) { /* без PIN */ }
    }, 30000);

    let month = null;
    let monthAt = 0;
    ui.poll(async () => {
      const t = await ctx.api.get('api/monitoring/traffic-statistics');
      const d = M.num(t.CurrentDownloadRate) || 0;
      const u = M.num(t.CurrentUploadRate) || 0;
      dl.set(M.fmt.speed(d));
      ulS.set(M.fmt.speed(u));
      hist.dl.push(d * 8); hist.ul.push(u * 8);
      if (hist.dl.length > 60) { hist.dl.shift(); hist.ul.shift(); }
      chart.update([hist.dl, hist.ul]);
      if (!month || Date.now() - monthAt > 30000) {
        monthAt = Date.now();
        try { month = await ctx.api.get('api/monitoring/month_statistics'); } catch (e) { month = null; }
      }
      sessKv.update([
        ['Время подключения', M.fmt.duration(t.CurrentConnectTime)],
        ['За сеанс', '↓ ' + M.fmt.bytes(t.CurrentDownload) + '  ↑ ' + M.fmt.bytes(t.CurrentUpload)],
        month ? ['За месяц', '↓ ' + M.fmt.bytes(month.CurrentMonthDownload) + '  ↑ ' + M.fmt.bytes(month.CurrentMonthUpload)] : null,
        ['Всего', '↓ ' + M.fmt.bytes(t.TotalDownload) + '  ↑ ' + M.fmt.bytes(t.TotalUpload)],
      ]);
    }, 3000);
  },
});
