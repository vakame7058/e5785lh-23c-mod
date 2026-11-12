// Номер SIM-карты: M.ui.simNumber(ctx) — блок для «Сводки» и «Мобильной сети».
// Данные — M.mod('msisdn') (docs/API.md): number, source, iccid, plmn, ussd_code, cache_iccid_match.
// USSD шлет помощник: сам после загрузки (auto_state) или по кнопке «Узнать у оператора» (query → query_state).
// Если номер пришел в SMS (состояние sms) и помощник SMS не читает (sms_reader=0) — номер из SMS берет страница.
const { el } = M.ui;

const digits = (s) => String(s || '').replace(/\D/g, '');
// 8XXXXXXXXXX и 7XXXXXXXXXX → +7XXXXXXXXXX; иначе + и цифры как есть
const normNumber = (raw) => {
  const plus = /^\s*\+/.test(String(raw || ''));
  let d = digits(raw);
  if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = '7' + d.slice(1);
  else if (!plus && d.length === 10 && d[0] === '9') d = '7' + d;
  return d.length >= 10 && d.length <= 15 ? '+' + d : '';
};
const showNumber = (n) => {
  const d = digits(n);
  if (d.length === 11 && d[0] === '7') return '+7 ' + d.slice(1, 4) + ' ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9);
  return n ? (String(n)[0] === '+' ? n : '+' + d) : '';
};
// Номер в ответе оператора: +7…, 8…, 7… с пробелами, скобками и дефисами
const findNumber = (text) => {
  const s = String(text || '');
  const re = /(\+?\d[\d\s\-()]{8,18}\d)/g;
  let m;
  const found = [];
  while ((m = re.exec(s))) {
    const n = normNumber(m[1]);
    if (n) found.push(n);
  }
  return found.find((n) => n.indexOf('+7') === 0) || found[0] || '';
};
const SOURCE = { ussd: 'узнан у оператора', manual: 'введен вручную', sim: 'записан на SIM-карте', cache: 'сохранен ранее' };

M.simNumber = { normNumber, findNumber, showNumber };
// SMS сами проверяются один раз за сеанс на одну отправку USSD (ключ — ussd_sent_local); дальше — кнопкой
let smsCheckedFor = '';
M.on('logout', () => { smsCheckedFor = ''; });

M.ui.simNumber = (ctx) => {
  const ui = M.ui;
  const box = el('div', { class: 'sim-num' }, ui.spinner('Номер SIM…'));
  let d = null;

  let fromSmsAt = '';   // номер только что определен из SMS: отправитель и время
  const save = async (number, source, toast) => {
    const r = await ctx.mod('msisdn', 'set', { number, source });
    d = Object.assign({}, d, r && typeof r === 'object' ? r : {}, { number, source, cache_iccid_match: '1' });
    fromSmsAt = '';
    ui.toast(toast || 'Номер сохранен', 'ok');
    draw();
  };

  const manual = (preset, answer) => {
    const f = ui.form([
      { name: 'number', label: 'Номер', value: preset || '', placeholder: '+7 900 123-45-67', required: true,
        validate: (v) => (normNumber(v) ? '' : 'Нужно 10–15 цифр, например +7 900 123-45-67.') },
    ], null, { submit: false });
    const body = el('div', { class: 'stack' },
      answer !== undefined ? el('p', { class: 'muted' }, 'В ответе оператора номера не нашлось:') : null,
      answer !== undefined ? ui.pre(answer || '(пустой ответ)') : null,
      f);
    ui.modal('Номер SIM-карты', body, [
      { label: 'Отмена', value: false },
      { label: 'Сохранить', kind: 'primary', onClick: async () => {
        const v = f.values();
        const n = normNumber(v.number);
        if (!n) { f.error('Нужно 10–15 цифр, например +7 900 123-45-67.'); return false; }
        await save(n, 'manual');
        return true;
      } },
    ]);
  };

  // Номер в SMS оператора (docs/API.md, msisdn, «Номер в SMS»; при sms_reader=0 разбирает страница):
  // стоковый sms-list (входящие, новые первыми, 5 шт.), только отправители из ussd_senders и Date не раньше
  // ussd_sent_local. Чужие SMS не открываются и не показываются; set-read не вызывается (sms-list пометку
  // не ставит); текст SMS никуда не пишется, кроме parse.
  let smsTried = false;
  let smsNote = '';
  const smsWait = () => String(d.sms_reader) === '0' && (d.auto_state === 'sms' || d.query_state === 'sms') &&
    !!String(d.ussd_senders || '').trim() && !!d.ussd_sent_local;
  const fromSms = async (byUser) => {
    if (!byUser && (smsTried || smsCheckedFor === String(d.ussd_sent_local))) return;
    smsTried = true;
    smsCheckedFor = String(d.ussd_sent_local);
    const senders = String(d.ussd_senders).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const since = String(d.ussd_sent_local).trim();
    let list;
    try {
      const r = await ctx.api.post('api/sms/sms-list', { PageIndex: 1, ReadCount: 5, BoxType: 1, SortType: 0, Ascending: 0, UnreadPreferred: 0 });
      list = M.arr(r && r.Messages && r.Messages.Message);
    } catch (e) {
      smsNote = 'SMS прочитать не удалось: ' + e.message;
      draw();
      return;
    }
    if (ctx.scope.dead) return;
    const ours = list.filter((m) => m && typeof m === 'object' && senders.indexOf(String(m.Phone || '').trim().toLowerCase()) >= 0 &&
      String(m.Date || '') >= since);
    let number = '';
    let sms = null;
    for (const m of ours) {
      const text = String(m.Content || '');
      try {
        const p = await ctx.mod('msisdn', 'parse', { text_b64: M.crypto.b64utf8(text) });
        if (p && String(p.found) === '1' && p.number) number = normNumber(p.number);
      } catch (e) { number = findNumber(text); }
      if (number) { sms = m; break; }
    }
    if (ctx.scope.dead) return;
    if (!number) {
      smsNote = 'SMS от оператора с номером пока нет (' + senders.join(', ') + ', после ' + since + ').';
      draw();
      return;
    }
    // SMS прошло фильтры (отправитель оператора, после отправки USSD) — номер сохраняется сразу
    await save(number, 'ussd', 'Номер определен из SMS оператора');
    fromSmsAt = String(sms.Phone).trim() + ', ' + sms.Date;
    draw();
  };

  // «Узнать у оператора»: USSD шлет помощник (M.mod('msisdn', 'query')), страница ждет итога в query_state / auto_state
  let waiting = false;
  const pending = () => d.query_state === 'pending' || d.auto_state === 'pending';
  const follow = async () => {
    if (waiting) return;
    waiting = true;
    try {
      const t0 = Date.now();
      while (!ctx.scope.dead && Date.now() - t0 < 120000) {
        await M.sleep(3000);
        try { d = await ctx.mod('msisdn'); } catch (e) { break; }
        if (ctx.scope.dead) return;
        if (!pending()) { smsTried = false; draw(); break; }
        draw();
      }
    } finally { waiting = false; }
  };
  const ask = async () => {
    const r = await ctx.mod('msisdn', 'query');
    if (r && typeof r === 'object') d = Object.assign({}, d, r);
    d.query_state = 'pending';
    smsNote = '';
    draw();
    follow();
  };

  const STATE = {
    pending: 'запрашивается у оператора…',
    sms: 'номер придет в SMS от оператора',
    waiting_net: 'ждет домашнюю сеть, чтобы спросить оператора',
    roaming: 'в роуминге номер не запрашивается',
    busy: 'модем занят, запрос будет позже',
    no_network: 'нет сети, номер спросить нельзя',
    unverified: 'код запроса не подтвержден на сайте оператора — можно спросить кнопкой',
  };
  function draw() {
    ui.clear(box);
    const qs = String(d.query_state || 'idle');
    const as = String(d.auto_state || 'idle');
    const st = qs !== 'idle' && qs !== 'done' ? qs : as;
    const changed = String(d.cache_iccid_match) === '0';
    const has = !changed && !!d.number;
    let value;
    let hint = '';
    if (has) {
      value = el('span', { class: 'num' }, showNumber(d.number));
      hint = fromSmsAt ? 'определен из SMS оператора (' + fromSmsAt + ')' : SOURCE[d.source] || '';
    }
    else if (STATE[st]) value = STATE[st];
    else if (st === 'failed') value = 'оператор не ответил' + (d.attempts ? ' (попыток ' + d.attempts + ' из 3)' : '');
    else if (changed) value = 'SIM сменилась, номер неизвестен';
    else value = 'неизвестен';
    if (!has && st === 'failed' && M.int(d.next_try_s)) hint = 'следующая попытка через ' + M.fmt.duration(d.next_try_s);
    if (!has && smsNote) hint = smsNote;
    box.appendChild(ui.kv([['Номер SIM', value, hint]]));
    const acts = el('div', { class: 'row' });
    const canAsk = !has && d.ussd_code && !pending() && st !== 'roaming' && st !== 'no_code' && String(d.roaming) !== '1';
    if (!has && smsWait()) acts.appendChild(ui.btn('Проверить SMS', () => fromSms(true), '', { icon: 'sms', class: 'btn-sm' }));
    if (canAsk) acts.appendChild(ui.btn('Узнать у оператора', ask, '', { icon: 'phone', class: 'btn-sm' }));
    if (!pending() || has) acts.appendChild(ui.btn(has ? 'Изменить' : 'Ввести вручную', () => manual(has ? showNumber(d.number) : ''), 'ghost', { icon: 'edit', class: 'btn-sm' }));
    if (acts.firstChild) box.appendChild(acts);
    if (!has && pending()) follow();
    else if (!has && smsWait() && !smsTried) fromSms(false);
  }

  (async () => {
    try { d = await ctx.mod('msisdn'); } catch (e) {
      // модуля нет (старый помощник) — блок не показываем
      box.hidden = true;
      return;
    }
    if (!ctx.scope.dead) draw();
  })();
  return box;
};
