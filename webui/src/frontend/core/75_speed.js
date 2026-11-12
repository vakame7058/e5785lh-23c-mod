// Замер скорости роутером (docs/API.md, speedtest): панель результата с живым графиком приема и ЦП и выводом
// об упоре в процессор. Ею пользуются «Тест скорости» и карточка AmneziaWG (замер через туннель, via=awg).
// M.ui.speedPanel(ctx) → {el, show(d, fromRun), run(args, limitS, extraS), setServers(list), busy()}.
const { el } = M.ui;

const kbpsText = (k) => {
  const v = Number(k) || 0;          // кбит/с
  if (v >= 1000) return M.fmt.num(v / 1000, v >= 100000 ? 0 : 1) + ' Мбит/с';
  return M.fmt.num(v, 0) + ' кбит/с';
};
const when = (t) => {
  const n = M.int(t);
  if (!n) return '';
  return new Date(n * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const pct = (v) => { const x = M.num(v); return isFinite(x) ? Math.max(0, Math.min(100, x)) : null; };
const samplesOf = (d) => M.arr(d && d.samples && d.samples.s).filter((x) => x && typeof x === 'object');
// Вывод об узком месте. Источники: cpu_avg/cpu_max итога (если есть) и точки замера — итоговые и живого опроса
// вместе, без повторов по времени. «Упирается»: средняя ≥ 90 % или ≥ 90 % больше половины точек.
// opts.tunnel — замер через VPN: «упирается» — то же; «возможно, близко к пределу»: 90 % и больше от 20 % до половины
// точек или средняя от 70 %; иначе скорость ограничивает задержка до сервера VPN или его канал
const cpuVerdict = (points, d, opts) => {
  opts = opts || {};
  const xs = points.map((x) => x.cpu).filter((v) => v !== null);
  const avgApi = pct(d && d.cpu_avg);
  const maxApi = pct(d && d.cpu_max);
  const avg = avgApi !== null ? avgApi : xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const max = maxApi !== null ? maxApi : xs.length ? Math.max(...xs) : null;
  const hi = xs.length >= 3 ? xs.filter((v) => v >= 90).length / xs.length : null;
  if (avgApi === null && !xs.length) return { kind: 'info', text: 'Загрузка процессора за этот замер не записана.' };
  if (avgApi === null && xs.length < 3) {
    return { kind: 'info', text: 'Замер слишком короткий, чтобы оценить процессор' +
      (avg !== null ? ': за ' + xs.length + ' ' + (xs.length === 1 ? 'точку' : 'точки') + ' в среднем ' + Math.round(avg) + ' %.' : '.') };
  }
  const tail = ' (в среднем ' + Math.round(avg) + ' %' + (max !== null ? ', наибольшая ' + Math.round(max) + ' %' : '') +
    (hi !== null ? ', 90 % и больше — ' + Math.round(hi * 100) + ' % времени замера' : '') + ').';
  if (opts.tunnel) {
    if (avg >= 90 || (hi !== null && hi > 0.5)) return { kind: 'warn', text: 'Скорость упирается в процессор роутера: он шифрует трафик' + tail };
    if (avg >= 70 || (hi !== null && hi >= 0.2)) return { kind: 'info', text: 'Возможно, скорость близка к пределу процессора роутера' + tail };
    return { kind: 'ok', text: 'Процессор не загружен до предела: скорость ограничивает задержка до сервера VPN или его канал' + tail };
  }
  if (avg >= 90 || (hi !== null && hi > 0.5)) {
    return { kind: 'warn', text: 'Скорость упирается в процессор роутера' + tail + ' Канал оператора может быть быстрее, чем показал замер.' };
  }
  if (avg >= 75) {
    return { kind: 'info', text: 'Процессор работал близко к пределу' + tail + ' Скорость может отчасти упираться в него.' };
  }
  return { kind: 'ok', text: 'Процессор не был узким местом: скорость ограничивает сервер или канал' + tail };
};

// Как шел замер: via (awg / awg0 — через туннель AmneziaWG), vpn_label — профиль
// via: awg — через туннель, direct или пусто — напрямую (docs/API.md, speedtest)
const isTunnel = (d) => { const v = String((d && d.via) || ''); return !!v && v !== 'direct'; };
const viaText = (d) => {
  if (!isTunnel(d)) return 'напрямую';
  return 'через VPN' + (d.vpn_label ? ' «' + d.vpn_label + '»' : '');
};
// точки отдачи: up_samples.s или samples.s с dir=up
const upSamplesOf = (d) => M.arr(d && d.up_samples && d.up_samples.s).filter((x) => x && typeof x === 'object')
  .concat(samplesOf(d).filter((x) => String(x.dir) === 'up'));
const upUnsupported = (d) => d && (String(d.up_supported) === '0' || String(d.up_status) === 'unsupported');
// отдача не удалась (up_status=error): текст up_error уже начинается с «отдача не удалась: …», после подписи «Отдача» слово лишнее
const upFailed = (d) => !!d && String(d.up_status) === 'error';
const upErrorText = (d) => String((d && d.up_error) || 'не удалась').replace(/^отдача\s+/i, '');
// как шла отдача: способ, а запросы и новые соединения — если их больше одного (иначе это и так обычный случай)
const UP_MODE = { single: 'одним запросом', chunks: 'кусками по 1 МиБ', chunks_est: 'кусками, скорость по счетчику интерфейса' };
const upModeText = (d) => {
  if (!d || !UP_MODE[d.up_mode]) return '';
  const parts = [UP_MODE[d.up_mode]];
  if (M.int(d.up_requests, 0) > 1) parts.push('запросов ' + M.int(d.up_requests));
  if (M.int(d.up_connections, 0) > 1) parts.push('новых соединений ' + M.int(d.up_connections));
  return parts.join(', ');
};

M.speed = { kbpsText, cpuVerdict, viaText, pct, samplesOf, upSamplesOf, upUnsupported, upFailed, upErrorText };

M.ui.speedPanel = (ctx, opts) => {
  opts = opts || {};
  const ui = ctx.ui;
  const big = el('div', { class: 'st-result' }, '—');
  const sub = el('div', { class: 'muted' });
  const accel = el('small', { class: 'hint', hidden: true }, 'Разгон первых 2 секунд не учитывается');
  const res = el('div');
  const note = el('div');
  const verdict = el('div');
  // один график на весь замер: фазы подписаны прямо на нем, между ними разделитель, у каждой фазы итог
  const chSpeed = ui.chart({ height: 130, auto: true, zero: true, points: 2, label: 'Скорость во время замера', phaseBand: true, noLegend: true,
    series: [{ name: 'Прием', cls: 's1' }, { name: 'Отдача', cls: 's2' }], fmt: (v) => M.fmt.num(v, v < 10 ? 1 : 0) });
  const chCpu = ui.chart({ height: 90, min: 0, max: 100, points: 2, label: 'Загрузка процессора во время замера',
    series: [{ name: 'ЦП, %', cls: 's3' }] });
  const live = el('div', { class: 'stack', hidden: true },
    el('div', { class: 'ch-l' }, 'Скорость, Мбит/с'), chSpeed,
    el('div', { class: 'ch-l' }, 'Загрузка процессора, %'), chCpu);
  let totals = {};
  let servers = [];
  let running = false;
  // точки по времени t (прием и отдача — отдельно), повтор по t перезаписывается; отдача на графике идет после приема
  const pts = { down: new Map(), up: new Map() };
  const addPoint = (map, t, cpu, kbps, phase) => {
    const tt = M.num(t);
    if (!isFinite(tt)) return;
    const k = M.num(kbps);
    map.set(Math.round(tt * 100) / 100, { t: tt, cpu: pct(cpu), kbps: isFinite(k) ? k : null, phase: phase || '' });
  };
  const collect = (d) => {
    const sm = samplesOf(d).filter((x) => String(x.dir || 'down') !== 'up');
    sm.forEach((x) => addPoint(pts.down, x.t, x.cpu_pct, x.kbps, x.phase));
    upSamplesOf(d).forEach((x) => addPoint(pts.up, x.t, x.cpu_pct, x.kbps, x.phase));
    if (d && M.int(d.streams, 0) > 1) totals.streams = M.int(d.streams);
    // cur_* — последняя точка того же ряда; отдельно берется, только если ряда в ответе нет
    if (!sm.length && d && !/^upload/.test(String(d.phase)) && M.num(d.elapsed_s) > 0 && d.cur_cpu_pct !== undefined && d.cur_cpu_pct !== '') addPoint(pts.down, d.elapsed_s, d.cur_cpu_pct, d.cur_kbps);
  };
  const sorted = (m) => [...m.values()].sort((a, b) => a.t - b.t);
  const points = () => sorted(pts.down);
  const drawSamples = () => {
    const dn = sorted(pts.down);
    const up = sorted(pts.up);
    if (!dn.length && !up.length) return dn;
    live.hidden = false;
    const mb = (x) => (x.kbps === null ? null : x.kbps / 1000);
    // отдача идет порциями, мгновенная скорость скачет от нуля до пика: на графике — среднее за 1 с вокруг точки, итог не меняется
    const upSm = up.map((x) => {
      if (x.kbps === null) return null;
      const w = up.filter((y) => y.kbps !== null && y.phase === x.phase && Math.abs(y.t - x.t) <= 0.5);
      return w.reduce((a, y) => a + y.kbps, 0) / w.length / 1000;
    });
    // подписи фаз: при замере в несколько потоков их четыре — название и цифра в две строки
    const seq = dn.map((x) => x.phase || 'download').concat(up.map((x) => x.phase || 'upload'));
    const phases = [];
    seq.forEach((ph, i) => {
      if (i && seq[i - 1] === ph) return;
      const mt = /_mt$/.test(ph);
      const name = (/^up/.test(ph) ? 'Отдача' : 'Прием') + (mt ? ' ' + (totals.streams || '') + ' потока' : '');
      const kbps = totals[ph];
      const val = M.num(kbps) > 0 ? kbpsText(kbps) : '';
      phases.push({ at: i, cls: /^up/.test(ph) ? 's2' : 's1', label: (name + ' ' + val).trim(), lines: [name, val].filter(Boolean),
        short: [(/^up/.test(ph) ? 'Отдача' : 'Прием') + (mt ? ' ×' + (totals.streams || '') : ''), val.replace(' Мбит/с', '')].filter(Boolean) });
    });
    const two = phases.length > 2;
    chSpeed.setPhases(phases.map((x) => (two ? x : { at: x.at, cls: x.cls, label: x.label })));
    chCpu.setPhases(phases.map((x) => ({ at: x.at })));
    chSpeed.update([dn.map(mb).concat(up.map(() => null)), dn.map(() => null).concat(upSm)]);
    chCpu.update([dn.concat(up).map((x) => x.cpu)]);
    return dn;
  };

  const setBig = (text, unit, s) => {
    ui.clear(big);
    big.appendChild(document.createTextNode(text));
    if (unit) big.appendChild(el('small', null, unit));
    sub.textContent = s || '';
  };
  const speedParts = (k) => {
    const t = kbpsText(k).split(' ');
    return [t[0], t.slice(1).join(' ')];
  };
  const serverName = (d) => d.name || (servers.find((x) => x.id === d.server) || {}).name || d.server || '';
  const cpuLine = (avg, max) => (pct(avg) !== null ? 'в среднем ' + Math.round(pct(avg)) + ' %' + (pct(max) !== null ? ', наибольшая ' + Math.round(pct(max)) + ' %' : '') : '');

  // строка итога для нескольких потоков: скорость и ЦП; не выдержали — причина как есть
  const mtRow = (name, d, kbps, avg, max, err, note, other) => {
    const has = M.num(kbps) > 0;
    if (!has && !err) return null;
    const label = name + ', ' + (M.int(d.mt_streams, 0) || M.int(d.streams, 0)) + ' потока';
    const notes = [has && err ? String(err) : '', other || '', note || ''].filter(Boolean).join('; ');
    return [label, has ? kbpsText(kbps) + (cpuLine(avg, max) ? ', ЦП ' + cpuLine(avg, max) : '') : String(err), notes || undefined];
  };
  const show = (d, fromRun) => {
    accel.hidden = true;
    if (!fromRun) { pts.down.clear(); pts.up.clear(); }
    collect(d);
    ui.clear(res);
    ui.clear(note);
    const s = String((d && d.status) || 'none');
    if (s === 'running') { setBig('…', '', 'идет замер'); return; }
    if (s === 'none') { setBig('—', '', 'замеров еще не было'); return; }
    if (s === 'nonet') {
      setBig('—', '', 'нет интернета');
      note.appendChild(ui.notice('Роутер не подключен к интернету: проверить скорость нельзя. Проверьте SIM-карту и сигнал на «Сводке».', 'warn'));
      return;
    }
    if (s !== 'ok') {
      setBig('—', '', 'ошибка замера');
      // замер только на отдачу при ошибке: status=error и текст в up_error
      if (d && d.up_error) note.appendChild(ui.notice('Отдача: ' + upErrorText(d), 'err'));
      else note.appendChild(ui.notice('Замер не удался: сервер не ответил или связь оборвалась. Выберите другой сервер или повторите позже.', 'err'));
      if (d && d.output) note.appendChild(ui.pre(String(d.output).trim()));
      return;
    }
    accel.hidden = d.window_s === undefined || d.window_s === '';
    totals = { download: d.speed_kbps, download_mt: d.mt_kbps, upload: d.up_kbps, upload_mt: d.up_mt_kbps, streams: M.int(d.mt_streams, 0) || M.int(d.streams, 0) };
    drawSamples();
    const p = speedParts(d.speed_kbps);
    const upTxt = upFailed(d) ? 'отдача не удалась' : M.num(d.up_kbps) > 0 ? 'отдача ' + kbpsText(d.up_kbps) : upUnsupported(d) ? 'отдача: сервер не поддерживает' : '';
    setBig(p[0], p[1] + ', прием', [upTxt, viaText(d), when(d.time)].filter(Boolean).join(' · '));
    const cand = M.arr(d.candidates && d.candidates.c).filter((x) => x && typeof x === 'object');
    const conn = cand.find((c) => c.id === d.server);
    res.appendChild(ui.kv([
      ['Как шел замер', viaText(d)],
      // сервер отдачи может отличаться от сервера приема
      ['Сервер', serverName(d) || '—', d.up_name && d.up_name !== serverName(d) ? 'Отдача: ' + d.up_name : undefined],
      ['Прием', kbpsText(d.speed_kbps) + (cpuLine(d.cpu_avg, d.cpu_max) ? ', ЦП ' + cpuLine(d.cpu_avg, d.cpu_max) : '')],
      // потоки могут идти на другой сервер (при автовыборе и HTTPS)
      mtRow('Прием', d, d.mt_kbps, d.mt_cpu_avg, d.mt_cpu_max, d.mt_error, d.mt_note, d.mt_name && d.mt_name !== serverName(d) ? 'потоки: ' + d.mt_name : ''),
      upFailed(d) ? ['Отдача', upErrorText(d)] : M.num(d.up_kbps) > 0 ? ['Отдача', kbpsText(d.up_kbps) + (cpuLine(d.up_cpu_avg, d.up_cpu_max) ? ', ЦП ' + cpuLine(d.up_cpu_avg, d.up_cpu_max) : '')]
        : upUnsupported(d) ? ['Отдача', 'сервер не поддерживает'] : null,
      mtRow('Отдача', d, d.up_mt_kbps, d.up_mt_cpu_avg, d.up_mt_cpu_max, d.up_mt_error, d.up_mt_note),
      upModeText(d) ? ['Как шла отдача', upModeText(d)] : null,
      conn && conn.connect_ms !== '-' ? ['Задержка соединения', conn.connect_ms + ' мс'] : d.connect_ms ? ['Задержка соединения', d.connect_ms + ' мс'] : null,
      ['Скачано', M.fmt.bytes(d.bytes) + ' за ' + M.fmt.num(Number(d.seconds) || 0, 1) + ' с'],
      M.num(d.traffic_mb) > 0 ? ['Трафик замера', M.fmt.num(Number(d.traffic_mb), Number(d.traffic_mb) < 10 ? 1 : 0) + ' МБ'] : null,
      d.url ? ['Файл', el('code', { class: 'mono' }, d.url)] : null,
      cand.length ? ['Выбор сервера', cand.map((c) => ((servers.find((x) => x.id === c.id) || {}).name || c.id) + ' — ' +
        (c.connect_ms === '-' ? 'не ответил' : c.connect_ms + ' мс')).join('; ')] : null,
    ]));
    const sm = drawSamples();
    ui.clear(verdict);
    // через туннель — свой вывод, см. cpuVerdict
    const vo = { tunnel: isTunnel(d) || !!opts.tunnel };
    const only = (arr, ph) => arr.filter((x) => (x.phase || (ph === 'upload' ? 'upload' : 'download')) === ph);
    if (M.num(d.mt_kbps) > 0 || M.num(d.up_mt_kbps) > 0) {
      // несколько потоков: вывод о процессоре по каждой фазе
      const n = totals.streams;
      const upPts = sorted(pts.up);
      const rows = [
        ['Прием', d.speed_kbps, only(sm, 'download'), d.cpu_avg, d.cpu_max],
        ['Прием ' + n + ' потока', d.mt_kbps, only(sm, 'download_mt'), d.mt_cpu_avg, d.mt_cpu_max],
        ['Отдача', d.up_kbps, only(upPts, 'upload'), d.up_cpu_avg, d.up_cpu_max],
        ['Отдача ' + n + ' потока', d.up_mt_kbps, only(upPts, 'upload_mt'), d.up_mt_cpu_avg, d.up_mt_cpu_max],
      ].filter((r) => M.num(r[1]) > 0).map((r) => ({ name: r[0], v: cpuVerdict(r[2], { cpu_avg: r[3], cpu_max: r[4] }, vo) }));
      const kind = rows.some((r) => r.v.kind === 'warn') ? 'warn' : rows.some((r) => r.v.kind === 'info') ? 'info' : 'ok';
      verdict.appendChild(ui.notice(el('div', { class: 'stack' }, rows.map((r) => el('div', null, el('b', null, r.name + '. '), r.v.text))), kind));
    } else {
      const v = cpuVerdict(only(sm, 'download'), d, vo);
      verdict.appendChild(ui.notice(v.text, v.kind));
    }
  };

  // замер идет в фоне на роутере: раз в 1 с читаем состояние, пока status=running
  const follow = async (limitS, extraS) => {
    running = true;
    M.quiet = true;
    accel.hidden = true;
    ui.clear(verdict);
    pts.down.clear(); pts.up.clear();
    totals = {};
    const t0 = Date.now();
    let d = null;
    try {
      while (!ctx.scope.dead && Date.now() - t0 < (limitS * 2 + (extraS || 0) + 40) * 1000) {
        // опрос сам отнимает скорость (ЦП роутера): раз в 3 с, точки графика и так приходят все в samples
        await M.sleep(3000);
        d = await ctx.mod('speedtest');
        if (String(d.status) !== 'running') break;
        collect(d);
        drawSamples();
        if (d.phase === 'select') { setBig('…', '', 'выбираю сервер по задержке'); continue; }
        if (d.phase === 'select_up') { setBig('…', '', 'выбираю сервер для отдачи'); continue; }
        const phaseName = { download: 'прием', download_mt: 'прием, ' + M.int(d.streams, 0) + ' потока', upload: 'отдача', upload_mt: 'отдача, ' + M.int(d.streams, 0) + ' потока' }[d.phase] || 'прием';
        const k = M.num(d.cur_kbps);
        const c = pct(d.cur_cpu_pct);
        const p = isFinite(k) && k > 0 ? speedParts(k) : ['…', ''];
        setBig(p[0], p[1], phaseName + ' · ' + ((/^upload/.test(d.phase) && d.up_name) || d.name ? ((/^upload/.test(d.phase) && d.up_name) || d.name) + ' · ' : '') + M.int(d.elapsed_s) + ' с из ' + limitS +
          (c !== null ? ' · ЦП ' + Math.round(c) + ' %' : ''));
      }
    } finally { running = false; M.quiet = false; }
    return d && String(d.status) !== 'running' ? d : null;
  };
  // запуск: run → status=running → опрос раз в 1 с → итог; ошибки помощника — понятным текстом
  const run = async (args, limitS, extraS) => {
    if (running) return null;
    ui.clear(note); ui.clear(res);
    setBig('…', '', 'запускаю замер');
    try {
      let d = await ctx.mod('speedtest', 'run', args);
      if (String(d && d.status) === 'running') d = await follow(limitS, extraS);
      if (ctx.scope.dead) return null;
      if (!d) {
        setBig('—', '', '');
        note.appendChild(ui.notice('Роутер не сообщил результат замера. Обновите страницу через минуту.', 'warn'));
      } else show(d, true);
      return d;
    } catch (e) {
      setBig('—', '', '');
      if (e.code === '9007') show({ status: 'nonet' });
      else if (e.code === '9002') note.appendChild(ui.notice(opts.busyText || 'Замер уже идет. Дождитесь результата.', 'info'));
      else note.appendChild(ui.notice(e.code === '9001' ? 'Помощник мода на роутере не отвечает.' : 'Замер не выполнен. ' + e.message, 'err'));
      return null;
    }
  };
  // широкая карточка: скорость и графики слева, таблица результата справа
  const box = ui.split([el('div', null, big, sub, accel), note, verdict, live], res, { big: true });
  return { el: box, show, run, follow, note, setBig, setServers: (l) => { servers = l || []; }, busy: () => running };
};
