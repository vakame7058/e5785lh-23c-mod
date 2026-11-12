// Трафик: текущий сеанс, всего, за месяц; месячный лимит.
// Вызовы как в стоке (offweb js/statistic.js): api/monitoring/traffic-statistics, month_statistics,
// start_date (GET/POST), clear-traffic.

const UNITS = [['MB', 'МБ'], ['GB', 'ГБ']];

// '20GB' → {value: 20, unit: 'GB'}
const parseLimit = (s) => {
  const m = String(s || '').trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B)$/i);
  if (!m) return { value: 0, unit: 'GB' };
  return { value: Number(m[1]), unit: m[2].toUpperCase() === 'MB' ? 'MB' : 'GB' };
};
const limitBytes = (l) => l.value * (l.unit === 'MB' ? 1024 * 1024 : 1024 * 1024 * 1024);

// '2026-10-01' или '20261001' → '01.10.2026'
const fmtDay = (s) => {
  const t = String(s || '').trim();
  const p2 = (x) => (String(x).length < 2 ? '0' : '') + x;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) m = t.match(/^(\d{4})(\d\d)(\d\d)$/);
  return m ? p2(m[3]) + '.' + p2(m[2]) + '.' + m[1] : t;
};

M.page({
  id: 'stats',
  title: 'Трафик',
  group: 'Сеть',
  icon: 'chart',
  order: 210,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;
    const F = M.fmt;

    // --- текущий сеанс ---
    const sDown = ui.stat('Скорость приема', '—', '', { icon: 'arrowdown' });
    const sUp = ui.stat('Скорость передачи', '—', '', { icon: 'arrowup' });
    const sTime = ui.stat('Время сеанса', '—', '', { icon: 'clock' });
    const sVol = ui.stat('Трафик сеанса', '—', '', { icon: 'chart' });
    const total = ui.kv([]);
    const month = ui.kv([]);
    const limitMeter = ui.meter(0, 0, 100, 'Израсходовано от лимита', { fmt: (v) => Math.round(v) + '%', good: 0, bad: 90 });
    const limitBox = el('div');
    const err = el('div');

    let traffic = null;
    let monthData = null;
    let limit = null;

    let drawTraffic = () => {
      const t = traffic || {};
      sDown.set(F.speed(t.CurrentDownloadRate));
      sUp.set(F.speed(t.CurrentUploadRate));
      sTime.set(F.duration(t.CurrentConnectTime));
      sVol.set(F.bytes(M.int(t.CurrentDownload) + M.int(t.CurrentUpload)),
        'прием ' + F.bytes(t.CurrentDownload) + ', передача ' + F.bytes(t.CurrentUpload));
      total.update([
        ['Принято', F.bytes(t.TotalDownload)],
        ['Передано', F.bytes(t.TotalUpload)],
        ['Всего', F.bytes(M.int(t.TotalDownload) + M.int(t.TotalUpload))],
        ['Время в сети', F.duration(t.TotalConnectTime)],
      ]);
    };

    let drawMonth = () => {
      const m = monthData || {};
      const used = M.int(m.CurrentMonthDownload) + M.int(m.CurrentMonthUpload);
      month.update([
        ['Принято', F.bytes(m.CurrentMonthDownload)],
        ['Передано', F.bytes(m.CurrentMonthUpload)],
        ['Всего за месяц', F.bytes(used)],
        ['Время в сети', m.MonthDuration !== undefined ? F.duration(m.MonthDuration) : ''],
        ['Счет с', fmtDay(m.MonthLastClearTime)],
      ]);
      limitBox.textContent = '';
      if (!limit) return;
      const on = String(limit.SetMonthData) === '1';
      const l = parseLimit(limit.DataLimit);
      if (!on || !l.value) {
        limitBox.appendChild(el('p', { class: 'hint' }, 'Лимит не задан. Задайте его ниже, чтобы видеть остаток.'));
        return;
      }
      const lb = limitBytes(l);
      const pct = lb ? (used / lb) * 100 : 0;
      limitMeter.set(Math.min(pct, 100));
      limitBox.appendChild(limitMeter);
      limitBox.appendChild(el('p', { class: 'hint' },
        'Израсходовано ' + F.bytes(used) + ' из ' + l.value + ' ' + (l.unit === 'MB' ? 'МБ' : 'ГБ') +
        (used < lb ? ', осталось ' + F.bytes(lb - used) : '') + '.'));
      if (pct >= M.int(limit.MonthThreshold, 90)) {
        limitBox.appendChild(ui.notice(pct >= 100
          ? 'Лимит трафика исчерпан.'
          : 'Израсходовано больше ' + M.int(limit.MonthThreshold, 90) + '% лимита.', 'warn'));
      }
    };

    const loadTraffic = async () => {
      traffic = await ctx.api.get('api/monitoring/traffic-statistics');
      drawTraffic();
    };
    const loadMonth = async () => {
      monthData = await ctx.api.get('api/monitoring/month_statistics');
      drawMonth();
    };

    // --- форма лимита ---
    const days = [];
    for (let i = 1; i <= 31; i++) days.push([String(i), String(i)]);
    const thresholds = [];
    for (let i = 50; i <= 100; i += 5) thresholds.push([String(i), i + '%']);
    const limitForm = ui.form([
      { name: 'on', label: 'Следить за лимитом', type: 'toggle', value: false },
      { name: 'value', label: 'Лимит в месяц', type: 'number', min: 1, max: 99999, value: '',
        show: (v) => v.on, validate: (v, all) => (all.on && !(Number(v) > 0) ? 'Укажите лимит.' : '') },
      { name: 'unit', label: 'Единица', type: 'select', options: UNITS, value: 'GB', show: (v) => v.on },
      { name: 'day', label: 'День начала месяца', type: 'select', options: days, value: '1', show: (v) => v.on,
        hint: 'В этот день счетчик месяца начинается заново, как у оператора.' },
      { name: 'threshold', label: 'Предупредить при', type: 'select', options: thresholds, value: '90', show: (v) => v.on },
    ], async (v) => {
      const body = v.on
        ? { StartDay: (Number(v.day) < 10 ? '0' : '') + Number(v.day), DataLimit: Number(v.value) + v.unit,
          MonthThreshold: v.threshold, SetMonthData: 1 }
        : { StartDay: (limit && limit.StartDay) || '01', DataLimit: '0GB',
          MonthThreshold: (limit && limit.MonthThreshold) || '90', SetMonthData: 0 };
      await ctx.api.post('api/monitoring/start_date', body);
      limit = await ctx.api.get('api/monitoring/start_date');
      drawMonth();
    }, { primary: true });

    const loadLimit = async () => {
      try {
        limit = await ctx.api.get('api/monitoring/start_date');
      } catch (e) {
        limit = null;
        limitForm.replaceWith(ui.notice('Лимит трафика на этом роутере недоступен. ' + e.message, 'info'));
        return;
      }
      const l = parseLimit(limit.DataLimit);
      limitForm.setAll({
        on: String(limit.SetMonthData) === '1' && l.value > 0,
        value: l.value || '',
        unit: l.unit,
        day: String(M.int(limit.StartDay, 1) || 1),
        threshold: String(M.int(limit.MonthThreshold, 90) || 90),
      });
      drawMonth();
    };

    const clearBtn = ui.btn('Сбросить счетчики', async () => {
      const ok = await ui.confirm('Обнулить счетчики трафика «Всего» и «За месяц»? Вернуть значения будет нельзя.',
        { danger: true, ok: 'Сбросить' });
      if (!ok) return;
      await ctx.api.post('api/monitoring/clear-traffic', { ClearTraffic: 1 });
      ui.toast('Счетчики обнулены', 'ok');
      await Promise.all([loadTraffic(), loadMonth()]);
    }, 'danger', { class: 'btn-sm btn-ghost' });

    // «За месяц» и «Всего» с одинаковыми цифрами (месяц начался вместе со счетом) — одна карточка с пометкой
    const sameNote = el('p', { class: 'hint', hidden: true });
    const monthCard = ui.card('За месяц', month, limitBox);
    const totalCard = ui.card({ title: 'Всего', actions: clearBtn }, total, sameNote,
      el('p', { class: 'hint' }, 'Счет роутера может расходиться со счетом оператора. Ориентируйтесь на данные оператора.'));
    const monthBody = monthCard.querySelector('.card-b');
    const totalBody = totalCard.querySelector('.card-b');
    const totalTitle = totalCard.querySelector('.card-h h2');
    const syncSame = () => {
      const t = traffic || {};
      const m = monthData || {};
      const same = !!traffic && !!monthData && M.int(t.TotalDownload) === M.int(m.CurrentMonthDownload) &&
        M.int(t.TotalUpload) === M.int(m.CurrentMonthUpload);
      monthCard.hidden = same;
      totalTitle.textContent = same ? 'Трафик' : 'Всего';
      sameNote.hidden = !same;
      sameNote.textContent = same ? 'Счет с ' + fmtDay(m.MonthLastClearTime) + ': за месяц и за весь срок столько же.' : '';
      const home = same ? totalBody : monthBody;
      if (limitBox.parentNode !== home) home.insertBefore(limitBox, same ? sameNote : null);
    };
    const drawTraffic0 = drawTraffic;
    const drawMonth0 = drawMonth;
    drawTraffic = () => { drawTraffic0(); syncSame(); };
    drawMonth = () => { drawMonth0(); syncSame(); };

    root.appendChild(err);
    root.appendChild(ui.card({ title: 'Текущий сеанс', icon: 'chart' }, ui.stats(sDown, sUp, sTime, sVol)));
    root.appendChild(ui.stacks([monthCard, totalCard], [ui.card('Месячный лимит', limitForm)]));

    // ошибка опроса — одна плашка над карточками; при успехе убирается
    const onError = (e) => {
      ui.clear(err);
      err.appendChild(ui.notice('Не удалось получить статистику. ' + e.message, 'err'));
    };
    const ok = (fn) => async () => { await fn(); ui.clear(err); };
    ui.poll(ok(loadTraffic), 3000, { onError });
    ui.poll(ok(loadMonth), 30000, { onError });
    await loadLimit();
  },
});
