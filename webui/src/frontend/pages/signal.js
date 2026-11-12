// Сигнал: уровни, сота, график, режим наведения антенны, привязка к соте (M.mod('cell'))
const { el } = M.ui;

// Таблица LTE: диапазон, частота начала (МГц) и начало номеров EARFCN для DL и UL
const LTE = [
  { b: 1, name: '2100', dl: [2110, 0, 599], ul: [1920, 18000] },
  { b: 3, name: '1800', dl: [1805, 1200, 1949], ul: [1710, 19200] },
  { b: 7, name: '2600', dl: [2620, 2750, 3449], ul: [2500, 20750] },
  { b: 8, name: '900', dl: [925, 3450, 3799], ul: [880, 21450] },
  { b: 20, name: '800', dl: [791, 6150, 6449], ul: [832, 24150] },
  { b: 28, name: '700', dl: [758, 9210, 9659], ul: [703, 27210] },
  { b: 32, name: '1500', dl: [1452, 9920, 10359], ul: null },
  { b: 38, name: '2600 TDD', dl: [2570, 37750, 38249], ul: null },
  { b: 40, name: '2300 TDD', dl: [2300, 38650, 39649], ul: null },
];
const bandOf = (dl) => LTE.find((x) => dl >= x.dl[1] && dl <= x.dl[2]);
const freqDl = (n) => { const x = bandOf(n); return x ? x.dl[0] + (n - x.dl[1]) / 10 : NaN; };
const freqUl = (dlN, ulN) => {
  const x = bandOf(dlN);
  if (!x) return NaN;
  if (!x.ul) return freqDl(dlN);   // TDD: та же частота
  return x.ul[0] + (ulN - x.ul[1]) / 10;
};
M.lteBands = LTE;

const MODE = { 0: '2G (GSM)', 2: '3G (WCDMA)', 7: '4G (LTE)' };
// '20MHz' → '20'; 'PPusch:12dBm PPucch:3dBm' → 'PUSCH 12, PUCCH 3 дБм'; 'mcsDownCarrier1Code0:17 …' → '17, 16'
const mhz = (x) => String(x || '').replace(/\s*MHz/i, '').replace('.', ',');
const txp = (x) => {
  // первая P — «мощность»: PPusch → PUSCH, PSrs → SRS
  const parts = String(x || '').match(/P([A-Za-z]+):(-?\d+)/g);
  if (!parts) return String(x || '');
  return parts.map((p) => { const m = p.match(/P([A-Za-z]+):(-?\d+)/); return m[1].toUpperCase() + ' ' + m[2].replace('-', '−'); }).join(', ') + ' дБм';
};
const nums = (x) => (String(x || '').match(/:(\d+)/g) || []).map((v) => v.slice(1)).join(', ');

// Пороги качества: [отлично, хорошо, средне] — больше лучше
const Q = {
  rsrp: [-80, -90, -100], sinr: [20, 13, 0], rsrq: [-10, -15, -20], rssi: [-65, -75, -85],
  rscp: [-75, -85, -100], ecio: [-6, -10, -14],
};
const QTXT = [['Отлично', 'ok'], ['Хорошо', 'ok'], ['Средне', 'warn'], ['Плохо', 'err']];
const quality = (k, v) => {
  const t = Q[k];
  if (!t || !isFinite(v)) return null;
  for (let i = 0; i < 3; i++) if (v >= t[i]) return QTXT[i];
  return QTXT[3];
};
const RANGE = { rsrp: [-130, -60], sinr: [-10, 30], rsrq: [-25, -3], rssi: [-110, -40], rscp: [-120, -50], ecio: [-24, 0] };
const UNIT = { rsrp: 'дБм', rssi: 'дБм', rscp: 'дБм', sinr: 'дБ', rsrq: 'дБ', ecio: 'дБ' };
const HINT = {
  rsrp: 'мощность сигнала соты', sinr: 'сигнал/шум, главное для скорости', rsrq: 'качество приема', rssi: 'вся мощность в канале',
  rscp: 'мощность сигнала 3G', ecio: 'качество 3G',
};

// Тон по SINR для наведения: выше SINR — выше звук
let audio = null;
const beep = (sinr) => {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    const f = Math.max(220, Math.min(1760, 330 + (sinr + 5) * 40));
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = f;
    o.type = 'sine';
    g.gain.setValueAtTime(0.0001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.16);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.18);
  } catch (e) { /* звук недоступен */ }
};

M.page({
  id: 'signal', title: 'Сигнал', icon: 'signal', order: 2,
  async render(box, ctx) {
    const ui = ctx.ui;
    let aim = ctx.params.aim === '1';
    let sound = false;
    let lastSig = {};
    const hist = { rsrp: [], sinr: [] };
    const best = { rsrp: -Infinity, sinr: -Infinity };
    const lockState = { info: null, err: null, cur: {}, reboot: false };

    // плитки
    const tiles = {};
    const tile = (k, label) => {
      const v = el('div', { class: 'sig-v num' }, '—');
      const q = el('span', { class: 'sig-q' });
      const sub = el('div', { class: 'sig-sub' }, HINT[k] || '');
      const m = ui.meter(null, RANGE[k][0], RANGE[k][1], '', {});
      const n = el('div', { class: 'sig-tile' }, el('div', { class: 'sig-h' }, el('span', { class: 'sig-l' }, label), q), v, m, sub);
      tiles[k] = { n, v, q, m, sub };
      return n;
    };
    const tilesBox = el('div', { class: 'sig-tiles' });
    const modeBadge = el('span');
    const aimBtn = ui.btn(aim ? 'Обычный режим' : 'Наведение антенны', () => setAim(!aim), aim ? '' : 'primary', { icon: 'target' });
    const soundBtn = ui.btn('Звук', () => setSound(!sound), 'ghost', { icon: 'mute', title: 'Звук по SINR' });
    const resetBtn = ui.btn('Сбросить лучшее', () => { best.rsrp = -Infinity; best.sinr = -Infinity; draw(lastSig); }, 'ghost', { icon: 'refresh' });
    const head = el('div', { class: 'sig-head' }, modeBadge, el('div', { class: 'row sig-actions' }, soundBtn, resetBtn, aimBtn));

    const chRsrp = ui.chart({ height: 110, min: -130, max: -60, label: 'RSRP по времени', series: [{ name: 'RSRP', cls: 's1' }] });
    const chSinr = ui.chart({ height: 110, min: -10, max: 30, label: 'SINR по времени', series: [{ name: 'SINR', cls: 's2' }] });
    const chartCard = ui.card({ title: 'Последние минуты', icon: 'chart', sub: 'обновление раз в 3 с' },
      el('div', { class: 'ch-l' }, 'RSRP, дБм'), chRsrp, el('div', { class: 'ch-l' }, 'SINR, дБ'), chSinr);

    const cellKv = ui.kv([]);
    const cellCard = ui.card({ title: 'Сота', icon: 'antenna' }, cellKv);

    // привязка к соте
    const lockBox = el('div', { class: 'lock-box' }, ui.spinner('Проверяю привязку…'));
    const lockCard = ui.card({ title: 'Привязка к соте', icon: 'lock' }, lockBox);

    const extraBox = el('div');
    const extraCard = ui.card({ title: 'Данные модема', icon: 'terminal', sub: 'AT-запросы помощника' }, extraBox);
    extraCard.hidden = true;

    box.appendChild(head);
    box.appendChild(tilesBox);
    box.appendChild(el('div', { class: 'cols' }, chartCard, lockCard, cellCard, extraCard));

    const setSound = (v) => {
      sound = v;
      soundBtn.classList.toggle('on', v);
      ui.clear(soundBtn).appendChild(M.icon(v ? 'sound' : 'mute', 18));
      soundBtn.appendChild(el('span', null, v ? 'Звук включен' : 'Звук'));
      if (v) beep(M.num(lastSig.sinr) || 0);
    };
    const setAim = (v) => {
      aim = v;
      box.classList.toggle('aiming', v);
      ui.clear(aimBtn).appendChild(M.icon('target', 18));
      aimBtn.appendChild(el('span', null, v ? 'Обычный режим' : 'Наведение антенны'));
      aimBtn.className = 'btn ' + (v ? '' : 'btn-primary');
      soundBtn.hidden = !v;
      resetBtn.hidden = !v;
      if (!v && sound) setSound(false);
      M.keepAwake(v);
      chartCard.querySelector('.card-sub').textContent = v ? 'обновление раз в секунду' : 'обновление раз в 3 с';
      poll.setInterval(v ? 1000 : 3000);
    };

    const kinds = (mode) => (mode === '7' ? [['rsrp', 'RSRP'], ['sinr', 'SINR'], ['rsrq', 'RSRQ'], ['rssi', 'RSSI']]
      : mode === '2' ? [['rscp', 'RSCP'], ['ecio', 'Ec/Io'], ['rssi', 'RSSI']] : [['rssi', 'RSSI']]);
    let tileMode = null;

    const draw = (s) => {
      const mode = String(s.mode || '');
      if (tileMode !== mode) {
        tileMode = mode;
        ui.clear(tilesBox);
        kinds(mode).forEach(([k, l]) => tilesBox.appendChild(tile(k, l)));
      }
      ui.clear(modeBadge).appendChild(ui.badge(MODE[mode] || 'Нет сети', MODE[mode] ? 'info' : 'muted'));
      kinds(mode).forEach(([k]) => {
        const t = tiles[k];
        const v = M.num(s[k]);
        ui.clear(t.v);
        if (isFinite(v)) ui.add(t.v, [String(v).replace('-', '−'), el('span', { class: 'sig-u' }, UNIT[k])]);
        else t.v.textContent = '—';
        const q = quality(k, v);
        t.q.className = 'sig-q' + (q ? ' ' + q[1] : '');
        t.q.textContent = q ? q[0] : '';
        t.m.set(isFinite(v) ? v : null);
        t.m.dataset.level = q ? (q[1] === 'ok' ? 'good' : q[1] === 'warn' ? 'mid' : 'bad') : 'none';
        if (aim && best[k] !== undefined && isFinite(best[k])) t.sub.textContent = 'лучшее: ' + String(best[k]).replace('-', '−') + ' ' + UNIT[k];
        else t.sub.textContent = HINT[k] || '';
      });

      // сота
      const ef = String(s.earfcn || '');
      const mdl = ef.match(/DL:\s*(\d+)/);
      const mul = ef.match(/UL:\s*(\d+)/);
      const dlN = mdl ? +mdl[1] : (/^\d+$/.test(ef) ? +ef : NaN);
      const ulN = mul ? +mul[1] : NaN;
      const bd = mode === '7' && isFinite(dlN) ? bandOf(dlN) : null;
      const band = s.band ? 'B' + s.band : bd ? 'B' + bd.b : '';
      const bname = bd ? ' (' + bd.name + ' МГц)' : '';
      const cid = M.int(s.cell_id, NaN);
      const st = M.state.status || {};
      const nei = String(s.nei_cellid || '').split(/No\d+:/).filter(Boolean);
      const fr = isFinite(dlN) && mode === '7' ? [freqDl(dlN), freqUl(dlN, ulN)] : null;
      cellKv.update([
        ['Диапазон', band ? band + bname : ''],
        ['EARFCN', isFinite(dlN) ? 'DL ' + dlN + (isFinite(ulN) ? ' / UL ' + ulN : '') : ef],
        fr && isFinite(fr[0]) ? ['Частота', M.fmt.num(fr[0], 1) + (isFinite(fr[1]) ? ' / ' + M.fmt.num(fr[1], 1) : '') + ' МГц'] : null,
        ['Ширина канала DL / UL', s.dlbandwidth || s.ulbandwidth ? (mhz(s.dlbandwidth) || '—') + ' / ' + (mhz(s.ulbandwidth) || '—') + ' МГц' : ''],
        ['Агрегация (CA)', st.CurrentNetworkTypeEx === '1011' ? 'есть (4G+)' : mode === '7' ? 'нет' : ''],
        ['PCI', s.pci],
        ['Cell ID', isFinite(cid) ? cid + ' (0x' + cid.toString(16).toUpperCase() + ')' : ''],
        mode === '7' && isFinite(cid) ? ['eNB / сектор', (cid >> 8) + ' / ' + (cid & 255)] : null,
        ['TAC', s.tac ? s.tac + ' (0x' + M.int(s.tac).toString(16).toUpperCase() + ')' : (s.lac || '')],
        ['PLMN', s.plmn],
        ['Соседние PCI', nei.join(', ')],
        ['Мощность передачи', txp(s.txpower)],
        ['MCS DL / UL', s.dl_mcs || s.ul_mcs ? (nums(s.dl_mcs) || '—') + ' / ' + (nums(s.ul_mcs) || '—') : ''],
      ].filter((r) => r && r[1] !== '' && r[1] !== undefined));
      lockState.cur = { pci: s.pci, earfcn: isFinite(dlN) ? dlN : '' };
      renderLock();
    };

    const poll = ui.poll(async () => {
      const s = await ctx.api.get('api/device/signal');
      lastSig = s || {};
      ['rsrp', 'sinr'].forEach((k) => {
        const v = M.num(s[k]);
        hist[k].push(isFinite(v) ? v : null);
        if (hist[k].length > 300) hist[k].shift();
        if (isFinite(v) && v > best[k]) best[k] = v;
      });
      draw(lastSig);
      const n = aim ? 300 : 100;
      chRsrp.update([hist.rsrp.slice(-n)]);
      chSinr.update([hist.sinr.slice(-n)]);
      if (sound && aim) beep(M.num(s.sinr) || -5);
    }, 3000, { onError: (e) => { ui.clear(modeBadge).appendChild(ui.badge('Нет данных: ' + e.message, 'err')); } });

    // --- привязка к соте ---
    let lockSig = '';
    // Привязка к соте (API.md, cell): пишется в NV 53810 и действует после перезагрузки роутера
    const mhz100 = (x) => (x ? M.fmt.num(M.int(x) / 10, 1) + ' МГц' : '');
    const earfcnOk = (n) => { const b = bandOf(n); return !!b && [1, 3, 7, 8, 20, 28, 32, 38].indexOf(b.b) >= 0; };
    // NV-запись выключена в помощнике (9008) — не тупик, а ссылка на «Опасные настройки»
    const cellCall = async (action, args) => {
      try { return await ctx.mod('cell', action, args); } catch (e) {
        if (e.code === '9008') { lockState.flag = true; lockSig = ''; renderLock(); return null; }
        throw e;
      }
    };
    const afterChange = (r, text) => {
      if (r === null) return;
      ui.toast(text, 'ok');
      lockState.reboot = r && String(r.reboot_needed) === '1';
      if (r && typeof r === 'object') lockState.info = Object.assign({}, lockState.info || {}, r);
      lockSig = '';
      renderLock();
    };
    function renderLock() {
      const key = JSON.stringify([lockState.info, lockState.err && lockState.err.message, lockState.cur, lockState.reboot, lockState.flag]);
      if (key === lockSig) return;
      lockSig = key;
      ui.clear(lockBox);
      if (lockState.err) {
        lockCard.setActions([]);
        lockBox.appendChild(ui.notice('Привязка недоступна: ' + lockState.err.message, 'warn'));
        return;
      }
      if (!lockState.info) { lockBox.appendChild(ui.spinner('Проверяю привязку…')); return; }
      const i = lockState.info;
      const on = String(i.enabled) === '1';
      lockBox.appendChild(el('p', { class: 'lock-st' }, on
        ? ['Записана привязка к соте ', el('b', null, 'PCI ' + (i.pci || '?')), i.band ? ', B' + i.band : '', i.freq_dl_100khz ? ', ' + mhz100(i.freq_dl_100khz) : '', '.']
        : 'Привязки нет: модем сам выбирает соту.'));
      lockBox.appendChild(el('p', { class: 'muted' },
        'Привязка держит модем на одной соте, даже если рядом есть лучше. Она начинает действовать после перезагрузки роутера. Если сота пропадет, связи не будет, пока привязку не снять.'));
      if (lockState.flag) {
        lockBox.appendChild(ui.notice(el('span', null, 'Привязка пишется в память модема (NV), а запись сейчас выключена. ', ui.dangerLink()), 'info'));
      }
      if (lockState.reboot) {
        lockBox.appendChild(el('div', { class: 'stack' },
          ui.notice('Изменение записано. Чтобы оно заработало, перезагрузите роутер.', 'warn'),
          el('div', { class: 'row' }, ui.btn('Перезагрузить роутер', async () => {
            if (!(await ui.confirm('Перезагрузить роутер? Связь и Wi-Fi пропадут примерно на минуту.', { ok: 'Перезагрузить', danger: true }))) return;
            await ctx.api.post('api/device/control', { Control: 1 });
            ui.toast('Роутер перезагружается', 'ok');
          }, 'danger', { icon: 'power' }))));
      }
      const c = { pci: i.cur_pci || lockState.cur.pci, earfcn: i.cur_earfcn || lockState.cur.earfcn, band: i.cur_band };
      // действия карточки — в заголовке справа
      const acts = [];
      if (c.pci) {
        acts.push(ui.btn('Привязать к PCI ' + c.pci, async () => {
          const ok = await ui.confirm('Записать привязку к текущей соте: PCI ' + c.pci + (c.earfcn !== '' && c.earfcn !== undefined ? ', EARFCN ' + c.earfcn : '') +
            '?\n\nПривязка заработает после перезагрузки роутера. Если эта сота пропадет, интернета не будет, пока привязку не снять.',
          { title: 'Привязка к соте', ok: 'Записать', danger: true });
          if (!ok) return;
          afterChange(await cellCall('set'), 'Привязка записана');
        }, 'ghost', { icon: 'lock', title: 'Привязать к текущей соте' }));
      }
      if (on) {
        acts.push(ui.btn('Снять привязку', async () => {
          if (!(await ui.confirm('Снять привязку к соте? Изменение заработает после перезагрузки роутера.', { ok: 'Снять' }))) return;
          afterChange(await cellCall('clear'), 'Привязка снята');
        }, 'ghost', { icon: 'unlock' }));
      }
      lockCard.setActions(acts);
      const f = ui.form([
        { name: 'pci', label: 'PCI', type: 'number', min: 0, max: 503, required: true },
        { name: 'earfcn', label: 'EARFCN DL', type: 'number', min: 0, max: 65535, required: true,
          hint: 'Только диапазоны роутера: B1, B3, B7, B8, B20, B28, B32, B38',
          validate: (v) => (earfcnOk(+v) ? '' : 'Этот EARFCN не из диапазонов роутера.') },
      ], async (v) => {
        const b = bandOf(+v.earfcn);
        const ok = await ui.confirm('Записать привязку к соте PCI ' + v.pci + ', EARFCN ' + v.earfcn + ' (B' + b.b + ')? Заработает после перезагрузки роутера.',
          { title: 'Привязка к соте', ok: 'Записать', danger: true });
        if (!ok) return false;
        afterChange(await cellCall('set', { pci: v.pci, earfcn: v.earfcn }), 'Привязка записана');
        return false;
      }, { submit: 'Записать', class: 'form-inline' });
      lockBox.appendChild(el('details', { class: 'more' }, el('summary', null, 'Другая сота'), f));
      if (i.output) lockBox.appendChild(el('details', { class: 'more' }, el('summary', null, 'Ответ модема'), ui.pre(i.output)));
    }
    async function loadLock() {
      try { lockState.info = await ctx.mod('cell'); lockState.err = null; } catch (e) { lockState.err = e; }
      lockSig = '';
      renderLock();
    }
    loadLock();

    // AT-данные помощника (CA, частоты): /api/mod/signal отвечает ~4 с, а веб роутера однопоточный —
    // пока ждет помощника, стоит весь веб. Поэтому редко (30 с) и никогда в режиме наведения.
    let modOff = false;
    ui.poll(async () => {
      if (aim || modOff) return;
      let d;
      try { d = await ctx.mod('signal'); } catch (e) { modOff = e.code === '100002' || e.code === '9001' || e.code === '9002'; return; }
      if (!d || !d.output) return;
      extraCard.hidden = false;
      ui.clear(extraBox);
      const f100 = (x) => (x ? M.fmt.num(M.int(x) / 10, 1) : '');
      extraBox.appendChild(ui.kv([
        ['Режим (^HCSQ)', d.hcsq_mode],
        ['Диапазон (^HFREQINFO)', d.band ? 'B' + d.band : ''],
        ['EARFCN DL / UL', d.earfcn_dl ? d.earfcn_dl + ' / ' + (d.earfcn_ul || '—') : ''],
        ['Частота DL / UL', d.freq_dl_100khz ? f100(d.freq_dl_100khz) + ' / ' + (f100(d.freq_ul_100khz) || '—') + ' МГц' : ''],
        ['Ширина DL / UL', d.bw_dl_mhz ? d.bw_dl_mhz + ' / ' + (d.bw_ul_mhz || '—') + ' МГц' : ''],
        ['PCI (^CECELLID)', d.pci],
      ].filter((r) => r[1])));
      extraBox.appendChild(el('details', { class: 'more' }, el('summary', null, 'Ответы модема'), ui.pre(d.output)));
    }, 30000);

    setAim(aim);
    ctx.onLeave(() => { if (audio) { try { audio.close(); } catch (e) { /* уже закрыт */ } audio = null; } });
  },
});
