// SMS: входящие, отправленные, черновики; чтение, отправка, удаление.
// Вызовы как в стоке (offweb js/sms.js): api/sms/sms-count, sms-list, set-read, delete-sms,
// send-sms, send-status, cancel-send, save-sms.

const BOX = { inbox: 1, sent: 2, draft: 3 };
const PAGE = 20;              // сток: pagesize из config/sms/config.xml (20), не больше 50
const MAX_PHONES = 50;        // сток: maxphone
const BUSY = '113018';        // в SMS это «система занята», а не «длинное сообщение»

// Основной алфавит GSM 03.38 и расширение (символ расширения занимает 2 места)
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';

// Сколько частей займет текст и в какой кодировке он уйдет
const smsInfo = (text) => {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM.indexOf(ch) >= 0) units += 1;
    else if (GSM_EXT.indexOf(ch) >= 0) units += 2;
    else { gsm = false; break; }
  }
  if (!gsm) {
    const n = text.length;
    return { gsm: false, len: n, max: 268, parts: n <= 70 ? 1 : Math.ceil(n / 67) };
  }
  return { gsm: true, len: units, max: 612, parts: units <= 160 ? 1 : Math.ceil(units / 153) };
};

const pad = (n) => (n < 10 ? '0' : '') + n;
const nowStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
};
const shortDate = (s) => String(s || '').replace(/:\d\d$/, '');

// Стили страницы: список сообщений и окно нового сообщения
const CSS = `
.sms-bar{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border)}
.sms-bar .sms-tabs{flex:1 1 auto;min-width:0}
.sms-bar .sms-tabs .tabs{border-bottom:0}
.sms-bar>.row{padding-bottom:8px}
.sms-item{border:1px solid var(--border);border-radius:var(--radius-s);padding:8px 10px;margin:8px 0;background:var(--surface)}
.sms-item.unread{border-left:3px solid var(--accent)}
.sms-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sms-head strong{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.sms-date{color:var(--text-3);font-size:12px}
.sms-text{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0;cursor:pointer}
.sms-text.clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sms-compose label{display:block;font-weight:600;margin:8px 0 4px}
.sms-compose input,.sms-compose textarea{width:100%;box-sizing:border-box}
.sms-count.warn{color:var(--err)}
.sms-err{color:var(--err);min-height:1em}
`;
const addCss = () => {
  if (document.getElementById('css-page-sms')) return;
  const s = document.createElement('style');
  s.id = 'css-page-sms';
  s.textContent = CSS;
  document.head.appendChild(s);
};

const errMsg = (e) => {
  if (e && e.code === BUSY) return 'Модуль SMS занят. Повторите через несколько секунд.';
  return (e && e.message) || 'Не удалось выполнить действие.';
};

M.page({
  id: 'sms',
  title: 'SMS',
  group: 'Сообщения',
  icon: 'sms',
  order: 110,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;
    addCss();
    const st = { box: BOX.inbox, page: 1, count: null, list: [], open: {}, checked: {}, sig: '' };

    const counters = el('div', { class: 'row' });
    const tabs = el('div', { class: 'sms-tabs' });
    const listBox = el('div', { class: 'sms-list' });
    const pager = el('div', { class: 'row' });
    const fullNote = el('div');
    const compose = el('div');

    const boxName = { 1: 'Входящие', 2: 'Отправленные', 3: 'Черновики' };

    const boxTotal = () => {
      const c = st.count || {};
      return M.int(st.box === 1 ? c.LocalInbox : st.box === 2 ? c.LocalOutbox : c.LocalDraft);
    };

    const drawTabs = () => {
      const c = st.count || {};
      const label = { 1: 'Входящие', 2: 'Отправленные', 3: 'Черновики' };
      const nums = { 1: c.LocalInbox, 2: c.LocalOutbox, 3: c.LocalDraft };
      tabs.textContent = '';
      tabs.appendChild(ui.tabs([1, 2, 3].map((b) => ({ id: b, label: label[b], badge: String(M.int(nums[b])) })), (b) => {
        st.box = Number(b);
        st.page = 1;
        st.open = {};
        st.checked = {};
        loadList();
      }, st.box));
    };

    const drawCounters = () => {
      const c = st.count || {};
      const used = M.int(c.LocalInbox) + M.int(c.LocalOutbox) + M.int(c.LocalDraft) + M.int(c.LocalDeleted);
      const max = M.int(c.LocalMax);
      fullNote.textContent = '';
      if (max > 0 && used >= max) {
        fullNote.appendChild(ui.notice(
          'Память SMS заполнена (' + used + ' из ' + max + '). Новые сообщения не придут, пока вы не удалите старые.', 'warn'));
      }
      counters.textContent = '';
      if (M.int(c.LocalUnread)) counters.appendChild(ui.badge('Новых: ' + M.int(c.LocalUnread), 'info'));
      if (max > 0) counters.appendChild(ui.badge('Занято ' + used + ' из ' + max, used >= max ? 'err' : ''));
      if (M.int(c.SimInbox) || M.int(c.SimOutbox) || M.int(c.SimDraft)) {
        counters.appendChild(ui.badge('На SIM-карте: ' + (M.int(c.SimInbox) + M.int(c.SimOutbox) + M.int(c.SimDraft))));
      }
    };

    const loadCount = async () => {
      st.count = await ctx.api.get('api/sms/sms-count');
      drawTabs();
      drawCounters();
    };

    const markRead = async (m) => {
      if (String(m.Smstat) !== '0') return;
      try {
        await ctx.api.post('api/sms/set-read', { Index: m.Index });
        m.Smstat = '1';
        loadCount().catch(() => {});
      } catch (e) { /* не критично */ }
    };

    const delMessages = async (ids) => {
      if (!ids.length) return;
      const ok = await ui.confirm(ids.length === 1 ? 'Удалить сообщение?' : 'Удалить выбранные сообщения (' + ids.length + ')?');
      if (!ok) return;
      try {
        await ctx.api.post('api/sms/delete-sms', { Index: ids });
        ui.toast(ids.length === 1 ? 'Сообщение удалено' : 'Сообщения удалены', 'ok');
        st.checked = {};
        await refresh();
      } catch (e) {
        ui.toast(errMsg(e), 'err');
      }
    };

    const msgText = (m) => {
      const t = M.int(m.SmsType);
      if (t === 5) return 'MMS: роутер не показывает такие сообщения.';
      if (t === 7) return 'Отчет о доставке: доставлено.';
      if (t === 8) return 'Отчет о доставке: не доставлено.';
      return String(m.Content || '');
    };

    const drawList = () => {
      listBox.textContent = '';
      const sel = Object.keys(st.checked).filter((k) => st.checked[k]);
      // действия карточки — в ее заголовке справа (правило каркаса, CORE.md)
      smsCard.setActions([
        ui.btn('Новое сообщение', () => openCompose({}), 'primary', { icon: 'plus' }),
        sel.length ? ui.btn('Удалить (' + sel.length + ')', () => delMessages(sel), 'danger', { class: 'btn-ghost' }) : null,
        ui.btn('', () => refresh().catch((e) => ui.toast(errMsg(e), 'err')), 'ghost', { icon: 'refresh', title: 'Обновить' }),
      ]);

      if (!st.list.length) {
        listBox.appendChild(ui.empty('В папке «' + boxName[st.box] + '» нет сообщений.', 'sms'));
        return;
      }
      st.list.forEach((m) => {
        const id = String(m.Index);
        const unread = st.box === BOX.inbox && String(m.Smstat) === '0';
        const text = msgText(m);
        const isOpen = !!st.open[id];
        const phones = String(m.Phone || '').split(';').filter(Boolean).join(', ') || 'без номера';
        const cb = el('input', {
          type: 'checkbox',
          'aria-label': 'Выбрать сообщение от ' + phones,
          onchange: (ev) => { st.checked[id] = ev.target.checked; drawList(); },
        });
        cb.checked = !!st.checked[id];
        const head = el('div', { class: 'sms-head' },
          cb,
          el('strong', null, phones),
          unread ? ui.badge('новое', 'info') : null,
          el('span', { class: 'sms-date' }, shortDate(m.Date)));
        const body = el('div', { class: 'sms-text' + (isOpen ? '' : ' clamp') }, text);
        const actions = el('div', { class: 'row' });
        if (isOpen) {
          if (st.box === BOX.inbox) {
            actions.appendChild(ui.btn('Ответить', () => openCompose({ phone: String(m.Phone || '').split(';')[0] })));
          }
          if (st.box === BOX.draft) {
            actions.appendChild(ui.btn('Изменить', () => openCompose({ phone: m.Phone, text: m.Content, index: m.Index })));
          }
          if (st.box === BOX.sent) {
            actions.appendChild(ui.btn('Переслать', () => openCompose({ text: m.Content })));
          }
          actions.appendChild(ui.btn('Удалить', () => delMessages([id]), 'danger'));
        }
        const item = el('div', {
          class: 'sms-item' + (unread ? ' unread' : '') + (isOpen ? ' open' : ''),
        }, head, body, actions);
        body.addEventListener('click', () => {
          st.open[id] = !st.open[id];
          if (st.open[id]) markRead(m);
          drawList();
        });
        body.setAttribute('tabindex', '0');
        body.setAttribute('role', 'button');
        body.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        body.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); body.click(); } });
        listBox.appendChild(item);
      });
    };

    const drawPager = () => {
      pager.textContent = '';
      const pages = Math.max(1, Math.ceil(boxTotal() / PAGE));
      if (pages <= 1) return;
      pager.appendChild(ui.btn('Назад', () => { if (st.page > 1) { st.page--; loadList(); } }));
      pager.appendChild(el('span', {}, 'Страница ' + st.page + ' из ' + pages));
      pager.appendChild(ui.btn('Вперед', () => { if (st.page < pages) { st.page++; loadList(); } }));
    };

    const loadList = async () => {
      const box = st.box;
      try {
        const d = await ctx.api.post('api/sms/sms-list', {
          PageIndex: st.page, ReadCount: PAGE, BoxType: box, SortType: 0, Ascending: 0, UnreadPreferred: 0,
        });
        if (box !== st.box) return;
        st.list = M.arr(d && d.Messages && d.Messages.Message);
        st.sig = st.list.map((m) => m.Index + ':' + m.Smstat).join(',');
        drawList();
        drawPager();
      } catch (e) {
        listBox.textContent = '';
        listBox.appendChild(ui.notice('Не удалось загрузить сообщения. ' + errMsg(e), 'err'));
      }
    };

    const refresh = async () => {
      await loadCount();
      const pages = Math.max(1, Math.ceil(boxTotal() / PAGE));
      if (st.page > pages) st.page = pages;
      await loadList();
    };

    // --- новое сообщение ---
    let sending = false;
    const openCompose = (pre) => {
      compose.textContent = '';
      const phone = el('input', {
        type: 'tel', id: 'sms-to', class: 'inp', autocomplete: 'off', inputmode: 'tel',
        placeholder: '+7 900 000-00-00; 900',
      });
      phone.value = pre.phone || '';
      const text = el('textarea', { id: 'sms-text', class: 'inp', rows: '5', placeholder: 'Текст сообщения' });
      text.value = pre.text || '';
      const info = el('div', { class: 'hint sms-count' });
      const err = el('div', { class: 'sms-err', role: 'alert' });
      const upd = () => {
        const i = smsInfo(text.value);
        info.textContent = i.len + ' из ' + i.max + ' символов · частей: ' + i.parts +
          (i.gsm ? '' : ' · кириллица и другие символы: до 70 в одной части');
        info.classList.toggle('warn', i.len > i.max);
      };
      text.addEventListener('input', upd);
      upd();

      const check = (needPhone) => {
        err.textContent = '';
        const list = phone.value.split(/[;,]/).map((s) => s.replace(/[\s()-]/g, '')).filter(Boolean);
        if (needPhone && !list.length) { err.textContent = 'Укажите номер получателя.'; phone.focus(); return null; }
        if (list.length > MAX_PHONES) { err.textContent = 'Не больше ' + MAX_PHONES + ' получателей.'; return null; }
        const bad = list.filter((p) => !/^\+?[0-9*#]{1,20}$/.test(p));
        if (bad.length) { err.textContent = 'Неверный номер: ' + bad[0] + '. Можно цифры, «+» в начале, «*» и «#».'; phone.focus(); return null; }
        const i = smsInfo(text.value);
        if (needPhone && !text.value.trim()) { err.textContent = 'Введите текст сообщения.'; text.focus(); return null; }
        if (i.len > i.max) { err.textContent = 'Текст слишком длинный: не больше ' + i.max + ' символов.'; text.focus(); return null; }
        return { list, gsm: i.gsm };
      };
      const body = (r) => ({
        Index: pre.index !== undefined ? pre.index : -1,
        Phones: { Phone: r.list },
        Sca: '',
        Content: text.value,
        Length: text.value.length,
        Reserved: r.gsm ? 1 : 0,
        Date: nowStr(),
      });

      const status = el('div', { class: 'muted', 'aria-live': 'polite' });
      const send = async () => {
        if (sending) return;
        const r = check(true);
        if (!r) return;
        sending = true;
        stopBtn.hidden = false;
        status.textContent = 'Отправка…';
        try {
          await ctx.api.post('api/sms/send-sms', body(r));
          const t0 = Date.now();
          let res = null;
          while (Date.now() - t0 < 120000) {
            await M.sleep(1500);
            const s = await ctx.api.get('api/sms/send-status');
            if (s && String(s.Phone || '') === '' && (s.SucPhone !== undefined || s.FailPhone !== undefined)) { res = s; break; }
            if (s) status.textContent = 'Отправка ' + M.int(s.CurIndex) + ' из ' + M.int(s.TotalCount) + '…';
          }
          if (!res) { status.textContent = 'Роутер не сообщил результат отправки. Проверьте папку «Отправленные».'; return; }
          const ok = String(res.SucPhone || '').split(',').filter(Boolean);
          const bad = String(res.FailPhone || '').split(',').filter(Boolean);
          if (bad.length) {
            status.textContent = '';
            ui.toast('Не отправлено: ' + bad.join(', ') + (ok.length ? '. Отправлено: ' + ok.join(', ') : ''), 'err');
          } else {
            ui.toast('Сообщение отправлено', 'ok');
            compose.textContent = '';
          }
          refresh().catch(() => {});
        } catch (e) {
          status.textContent = '';
          ui.toast('Сообщение не отправлено. ' + errMsg(e), 'err');
        } finally {
          sending = false;
          stopBtn.hidden = true;
        }
      };
      const save = async () => {
        const r = check(false);
        if (!r) return;
        if (!r.list.length && !text.value.trim()) { err.textContent = 'Пустой черновик сохранять незачем.'; return; }
        try {
          await ctx.api.post('api/sms/save-sms', body(r));
          ui.toast('Черновик сохранен', 'ok');
          compose.textContent = '';
          refresh().catch(() => {});
        } catch (e) {
          ui.toast('Черновик не сохранен. ' + errMsg(e), 'err');
        }
      };
      const stop = async () => {
        try { await ctx.api.post('api/sms/cancel-send', 1); } catch (e) { /* уже отправлено */ }
      };
      const stopBtn = ui.btn('Остановить отправку', stop);
      stopBtn.hidden = true;

      const c = ui.card(pre.index !== undefined ? 'Черновик' : 'Новое сообщение',
        el('label', { for: 'sms-to' }, 'Кому'),
        phone,
        el('small', { class: 'hint' }, 'Несколько номеров — через точку с запятой.'),
        el('label', { for: 'sms-text' }, 'Текст'),
        text,
        info,
        err,
        status,
        el('div', { class: 'row' },
          ui.btn('Отправить', send, 'primary'),
          ui.btn('Сохранить черновик', save),
          stopBtn,
          ui.btn('Закрыть', () => { compose.textContent = ''; })));
      c.classList.add('sms-compose');
      compose.appendChild(c);
      compose.scrollIntoView({ behavior: 'smooth', block: 'start' });
      (pre.phone ? text : phone).focus();
    };

    root.appendChild(compose);
    // счетчики («Новых», «Занято N из 500») — в строке вкладок справа
    const smsCard = ui.card({ title: 'Сообщения', icon: 'sms' }, fullNote, el('div', { class: 'sms-bar' }, tabs, counters), listBox, pager);
    root.appendChild(smsCard);
    listBox.appendChild(ui.spinner());

    try {
      await refresh();
    } catch (e) {
      listBox.textContent = '';
      listBox.appendChild(ui.notice('Не удалось получить SMS. ' + errMsg(e), 'err'));
    }
    if (ctx.params && ctx.params.to) openCompose({ phone: ctx.params.to });

    // новые сообщения: опрос счетчиков, при изменении — перечитать папку
    let last = st.count ? [st.count.LocalUnread, st.count.LocalInbox, st.count.LocalOutbox, st.count.LocalDraft].join() : '';
    ui.poll(async () => {
      if (sending) return;
      const c = await ctx.api.get('api/sms/sms-count');
      const sig = [c.LocalUnread, c.LocalInbox, c.LocalOutbox, c.LocalDraft].join();
      if (sig !== last) {
        last = sig;
        st.count = c;
        drawTabs();
        drawCounters();
        await loadList();
      }
    }, 15000);
  },
});
