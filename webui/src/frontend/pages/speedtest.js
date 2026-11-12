// Тест скорости: роутер сам скачивает и отдает тестовые данные и меряет скорость (docs/API.md, speedtest).
// M.mod('speedtest', 'servers') — {curl, servers.server[id, name, country, url, https, median_mbps]};
// M.mod('speedtest', 'run', {server: 'auto' | id} или {url}, timeout_s, direction: 'both', via: 'awg'});
// M.mod('speedtest') — состояние: во время замера phase (select | download | upload), elapsed_s, cur_kbps, cur_cpu_pct,
// точки samples.s[t, cpu_pct, kbps] (и отдачи); после — speed_kbps, up_kbps, cpu_avg/max, up_cpu_avg/max, via, vpn_label,
// candidates, history. Замер и график — M.ui.speedPanel (core/75_speed.js).
const { el } = M.ui;
const S = M.speed;

M.page({
  id: 'speedtest',
  title: 'Тест скорости',
  group: 'Улучшения',
  icon: 'arrowdown',
  order: 450,
  render: async (root, ctx) => {
    const ui = ctx.ui;
    const panel = ui.speedPanel(ctx);
    const note = panel.note;
    const cmpBox = el('div', { class: 'stack' });
    const histBox = el('div');
    let servers = [];
    let curl = true;
    let awg = { up: false, label: '' };

    const serverOpts = () => (curl ? [['auto', 'Авто — быстрый и ближайший']] : [])
      .concat(servers.filter((x) => curl || x.https !== '1').map((x) => [x.id, x.name + (x.country ? ' (' + x.country + ')' : '') +
        (M.num(x.median_mbps) ? ', обычно ~' + Math.round(M.num(x.median_mbps)) + ' Мбит/с' : '')]))
      .concat([['custom', 'Свой адрес файла…']]);
    const runArgs = (v, via, withStreams) => {
      const a = { timeout_s: v.timeout, direction: 'both' };
      // без поля роутер сам ставит 4 потока, поэтому значение отправляется всегда; «Сравнить» — без потоков
      a.streams = withStreams ? M.int(v.streams, 4) : 1;
      if (v.server === 'custom') a.url = v.url; else a.server = v.server;
      if (via) a.via = 'awg';
      return a;
    };

    // «Сравнить»: сервер выбирается один раз (первый замер, напрямую), второй замер — на нем же через VPN
    const compare = async () => {
      if (panel.busy()) return;
      if (!awg.up) throw new Error('Туннель AmneziaWG не поднят: сравнивать не с чем.');
      const v = f.values();
      ui.clear(cmpBox);
      cmpBox.appendChild(ui.spinner('Замер 1 из 2: напрямую…'));
      const d1 = await panel.run(runArgs(v, false), Number(v.timeout), v.server === 'auto' ? 20 : 0);
      if (!d1 || String(d1.status) !== 'ok') { ui.clear(cmpBox); return; }
      ui.clear(cmpBox).appendChild(ui.spinner('Замер 2 из 2: через VPN на том же сервере…'));
      const second = Object.assign(runArgs(v, true), d1.server && v.server !== 'custom' ? { server: d1.server } : {});
      const d2 = await panel.run(second, Number(v.timeout), 0);
      ui.clear(cmpBox);
      if (!d2 || String(d2.status) !== 'ok') return;
      drawCompare(d1, d2);
      loadHistory();
    };
    const connMs = (d) => {
      const c = M.arr(d.candidates && d.candidates.c).find((x) => x && x.id === d.server);
      return c && c.connect_ms !== '-' ? c.connect_ms + ' мс' : d.connect_ms ? d.connect_ms + ' мс' : '—';
    };
    const cpuAvg = (avg) => (S.pct(avg) !== null ? Math.round(S.pct(avg)) + ' %' : '—');
    const drawCompare = (a, b) => {
      const sp = (k) => (M.num(k) > 0 ? S.kbpsText(k) : '—');
      const up = (d) => (S.upFailed(d) ? S.upErrorText(d) : M.num(d.up_kbps) > 0 ? S.kbpsText(d.up_kbps) : S.upUnsupported(d) ? 'не поддерживает' : '—');
      cmpBox.appendChild(ui.subhead('Напрямую и через VPN, сервер ' + (a.name || a.server || '—')));
      cmpBox.appendChild(ui.table([
        { key: 'k', title: '' },
        { key: 'a', title: 'Напрямую', cls: 'r' },
        { key: 'b', title: S.viaText(b), cls: 'r' },
      ], [
        { k: 'Прием', a: sp(a.speed_kbps), b: sp(b.speed_kbps) },
        { k: 'Отдача', a: up(a), b: up(b) },
        { k: 'ЦП при приеме', a: cpuAvg(a.cpu_avg), b: cpuAvg(b.cpu_avg) },
        { k: 'ЦП при отдаче', a: cpuAvg(a.up_cpu_avg), b: cpuAvg(b.up_cpu_avg) },
        { k: 'Задержка соединения', a: connMs(a), b: connMs(b) },
      ]));
      const ra = M.num(a.speed_kbps);
      const rb = M.num(b.speed_kbps);
      let text;
      let kind = 'info';
      if (ra > 0 && rb > 0) {
        const loss = Math.round((1 - rb / ra) * 100);
        text = loss > 0 ? 'Через VPN прием ниже на ' + loss + ' %. ' : 'Через VPN прием не ниже, чем напрямую. ';
        const v = S.cpuVerdict(S.samplesOf(b).map((x) => ({ cpu: S.pct(x.cpu_pct) })), b, { tunnel: true });
        text += v.text;
        if (v.kind === 'warn') kind = 'warn';
      } else text = 'Один из замеров не дал скорости приема — сравнить нельзя.';
      cmpBox.appendChild(ui.notice(text, kind));
    };

    const f = ui.form([
      { name: 'server', label: 'Сервер', type: 'select', value: 'auto', options: serverOpts() },
      { name: 'url', label: 'Адрес файла', placeholder: 'http://…', show: (v) => v.server === 'custom',
        hint: 'Файл от 10 МБ, иначе замер слишком короткий.',
        validate: (v, all) => (all.server !== 'custom' ? '' : (curl ? /^https?:\/\/\S+$/i : /^http:\/\/\S+$/i).test(v) ? ''
          : curl ? 'Адрес должен начинаться с http:// или https://' : 'Без curl на роутере — только http://') },
      { name: 'timeout', label: 'Длительность', type: 'select', value: '15',
        options: [['10', '10 секунд'], ['15', '15 секунд'], ['30', '30 секунд'], ['60', '60 секунд']] },
      { name: 'streams', label: 'Потоки', type: 'select', value: '4', options: [['1', '1, замер короче'], ['2', '2'], ['3', '3'], ['4', '4, рекомендуется']],
        hint: 'Прием и отдача идут сначала одним потоком, потом в несколько: видно, упирается ли скорость в одно соединение. С одним потоком замер примерно вдвое короче.' },
      { name: 'via', type: 'checkbox', text: 'Через VPN', value: false, disabled: true, hint: 'туннель не поднят' },
    ], async (v) => {
      if (panel.busy()) return false;
      ui.clear(cmpBox);
      // фазы в несколько потоков удваивают время замера
      await panel.run(runArgs(v, v.via, true), Number(v.timeout), (v.server === 'auto' ? 20 : 0) + (M.int(v.streams, 1) > 1 ? Number(v.timeout) * 2 + 10 : 0));
      loadHistory();
      return false;
    }, { submit: false });
    // «Начать замер» и «Сравнить» — в заголовке карточки «Результат»: кнопка видна сразу, без прокрутки.
    // Кнопка отправляет форму «Настройки замера» (проверка полей и занятость — как у обычной кнопки формы).
    const startBtn = ui.btn('Начать замер', () => f.requestSubmit(), 'primary');
    const cmpBtn = ui.btn('Сравнить', () => compare(), '', { title: 'Два замера подряд на одном сервере: напрямую и через VPN' });
    const formBusy = f.busy;
    f.busy = (b) => { formBusy(b); startBtn.disabled = !!b; startBtn.classList.toggle('busy', !!b); };

    const setVpn = () => {
      const box = f.field('via');
      box.disabled = !awg.up;
      if (!awg.up) box.checked = false;
      const hint = f.row('via').querySelector('.hint');
      if (hint) hint.textContent = awg.up ? 'через профиль «' + (awg.label || 'активный') + '»' : 'туннель не поднят';
      if (cmpBtn) { cmpBtn.disabled = !awg.up; cmpBtn.title = awg.up ? 'Два замера подряд на одном сервере: напрямую и через VPN' : 'Туннель AmneziaWG не поднят'; }
    };

    // история замеров (если помощник ее отдает): когда, как шел, сервер, прием, отдача
    const drawHistory = (d) => {
      const items = M.arr(d && d.history && (d.history.run || d.history.item || d.history.r)).filter((x) => x && typeof x === 'object');
      ui.clear(histBox);
      if (!items.length) { histBox.appendChild(ui.empty('Замеров пока нет.')); return; }
      histBox.appendChild(ui.table([
        { key: 'time', title: 'Когда', render: (x) => (M.int(x.time) ? new Date(M.int(x.time) * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—') },
        { key: 'via', title: 'Как', render: (x) => S.viaText(x) },
        { key: 'name', title: 'Сервер', render: (x) => x.name || x.server || '—' },
        { key: 'speed_kbps', title: 'Прием', cls: 'r', render: (x) => (M.num(x.speed_kbps) > 0 ? S.kbpsText(x.speed_kbps) : '—') },
        { key: 'up_kbps', title: 'Отдача', cls: 'r', render: (x) => (M.num(x.up_kbps) > 0 ? S.kbpsText(x.up_kbps) : '—') },
        // столбец потоков — только если такие замеры были
        items.some((x) => M.num(x.mt_kbps) > 0 || M.num(x.up_mt_kbps) > 0) ? { key: 'mt', title: 'Потоки', cls: 'r', render: (x) => (M.num(x.mt_kbps) > 0 || M.num(x.up_mt_kbps) > 0
          ? '×' + M.int(x.streams, 0) + ': ' + [x.mt_kbps, x.up_mt_kbps].map((k) => (M.num(k) > 0 ? S.kbpsText(k) : '—')).join(' / ') : '—') } : null,
      ].filter(Boolean), items.slice(0, 10)));
    };
    const loadHistory = async () => { try { drawHistory(await ctx.mod('speedtest')); } catch (e) { /* история не обязательна */ } };

    // результат и история — большая колонка, настройки замера — малая рядом; на узком экране настройки сразу под результатом
    const histCard = ui.card({ title: 'Последние замеры', icon: 'clock' }, histBox);
    histCard.classList.add('stack-last');
    root.appendChild(ui.stacks21(
      [ui.card({ title: 'Результат', icon: 'arrowdown', actions: [cmpBtn, startBtn] }, panel.el, cmpBox), histCard],
      ui.card({ title: 'Настройки замера', icon: 'settings' },
        el('p', { class: 'muted' }, 'Роутер скачивает и отдает тестовые данные и считает скорость: это связь роутера с оператором, без Wi-Fi. ' +
          'Замер расходует трафик — до нескольких десятков МБ. Пока он идет, интерфейс роутера отвечает медленнее.'),
        f)));

    try {
      const [d, sv, vpn] = await Promise.all([ctx.mod('speedtest'), ctx.mod('speedtest', 'servers').catch(() => null), ctx.mod('vpn').catch(() => null)]);
      if (sv) {
        curl = String(sv.curl) === '1';
        servers = M.arr(sv.servers && sv.servers.server).filter((x) => x && typeof x === 'object' && x.id)
          .map((x) => ({ id: String(x.id), name: x.name || x.id, country: x.country || '', url: x.url || '', https: String(x.https || '0'), median_mbps: x.median_mbps }));
      }
      const a = vpn && vpn.awg && typeof vpn.awg === 'object' ? vpn.awg : {};
      awg = { up: String(a.installed) === '1' && String(a.up) === '1', label: String(a.active_label || a.active_profile || '') };
      setVpn();
      panel.setServers(servers);
      f.setOptions('server', serverOpts(), curl ? 'auto' : (servers[0] || { id: 'custom' }).id);
      // без curl потоков нет: значение больше 1 роутер отвергает
      if (!curl) { f.set('streams', '1'); f.field('streams').disabled = true; }
      panel.show(d);
      drawHistory(d);
      if (!curl) note.appendChild(ui.notice('На роутере нет curl (пакет dns): автовыбор сервера и https недоступны, качается только http://.', 'info'));
      if (String(d && d.status) === 'running') {
        const r = await panel.follow(60);
        if (r) panel.show(r, true);
      }
    } catch (e) {
      note.appendChild(ui.notice(e.code === '9001' ? 'Помощник мода на роутере не отвечает: тест недоступен.'
        : 'Не удалось получить прошлый замер. ' + e.message, 'err'));
    }
  },
});
