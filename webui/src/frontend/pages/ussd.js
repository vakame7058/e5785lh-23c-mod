// USSD: запрос оператору (*100# и т. п.) и ответ.
// Вызовы как в стоке (offweb js/ussd.js): POST api/ussd/send, затем опрос GET api/ussd/get;
// api/ussd/status (сеанс открыт), api/ussd/release (закрыть сеанс).

const WAIT_MAX = 120000;      // сток: MACRO_USSD_TIMER = 2 минуты
const NOT_READY = '111019';   // ответа еще нет — спрашивать снова
const TIMEOUT = '111020';     // оператор не ответил
const PIN = '111022';         // сток: нужен PIN-код SIM-карты
const HIST_KEY = 'ussd.history';
const HIST_MAX = 8;

const CSS = `
.ussd-in{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ussd-in input{flex:1 1 160px;min-width:0;font-family:var(--mono);font-size:16px}
.ussd-err{color:var(--err);margin:4px 0}
.ussd-err:empty,.chat:empty,.ussd-hist:empty{display:none}
.chat{display:flex;flex-direction:column;gap:8px;margin:10px 0}
.chat-msg{max-width:92%;padding:8px 10px;border-radius:var(--radius-s);background:var(--surface-2);border:1px solid var(--border)}
.chat-msg.out{align-self:flex-end;background:var(--accent-bg)}
.chat-msg.err{background:var(--err-bg)}
.chat-msg.sys{background:none;border-style:dashed}
.chat-who{color:var(--text-3);font-size:12px}
.chat-msg pre{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--mono)}
`;
const addCss = () => {
  if (document.getElementById('css-page-ussd')) return;
  const s = document.createElement('style');
  s.id = 'css-page-ussd';
  s.textContent = CSS;
  document.head.appendChild(s);
};

const errText = (e) => {
  const c = e && e.code;
  if (c === TIMEOUT) return 'Оператор не ответил. Повторите запрос позже.';
  if (c === PIN) return 'SIM-карта заблокирована PIN-кодом. Введите PIN на странице «Сеть».';
  if (c === NOT_READY) return 'Ответ еще не пришел.';
  return (e && e.message) || 'Запрос не выполнен.';
};

M.page({
  id: 'ussd',
  title: 'USSD',
  group: 'Сообщения',
  icon: 'phone',
  order: 120,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;
    addCss();
    let busy = false;
    const isAlive = () => !(ctx.scope && ctx.scope.dead);
    let session = false;

    const log = el('div', { class: 'chat', 'aria-live': 'polite' });
    const input = el('input', {
      id: 'ussd-cmd', class: 'inp', type: 'text', inputmode: 'tel', autocomplete: 'off',
      maxlength: '40', placeholder: '*100#',
    });
    const err = el('div', { class: 'ussd-err', role: 'alert' });
    const state = el('div', { class: 'hint', 'aria-live': 'polite' });
    const hist = el('div', { class: 'row ussd-hist', style: { marginTop: '8px' } });
    const sendBtn = ui.btn('Отправить', () => send(input.value), 'primary');
    const endBtn = ui.btn('Завершить сеанс', () => release(true));
    const endRow = el('div', { class: 'row' }, endBtn);

    const add = (who, text, kind) => {
      const row = el('div', { class: 'chat-msg ' + (kind || '') },
        el('div', { class: 'chat-who' }, who + ' · ' + new Date().toLocaleTimeString('ru-RU')),
        el('pre', null, text));
      log.appendChild(row);
      row.scrollIntoView({ block: 'nearest' });
    };

    const drawHist = () => {
      hist.textContent = '';
      M.store.get(HIST_KEY, []).forEach((c) => {
        hist.appendChild(ui.btn(c, () => { input.value = c; send(c); }));
      });
    };
    const remember = (c) => {
      const h = M.store.get(HIST_KEY, []).filter((x) => x !== c);
      h.unshift(c);
      M.store.set(HIST_KEY, h.slice(0, HIST_MAX));
      drawHist();
    };

    const setBusy = (b, text) => {
      busy = b;
      sendBtn.disabled = b;
      input.disabled = b;
      state.textContent = text || '';
    };

    const checkSession = async () => {
      try {
        const s = await ctx.api.get('api/ussd/status');
        session = String(s && s.result) === '1';
      } catch (e) {
        session = false;
      }
      endRow.hidden = !session;
      if (!busy) {
        state.textContent = session
          ? 'Оператор ждет ответа: введите цифру из меню и нажмите «Отправить».'
          : '';
      }
    };

    const release = async (byUser) => {
      try {
        await ctx.api.get('api/ussd/release');
        if (byUser) add('Роутер', 'Сеанс USSD завершен.', 'sys');
      } catch (e) {
        if (byUser) ui.toast(errText(e), 'err');
      }
      checkSession();
    };

    const send = async (raw) => {
      if (busy) return;
      err.textContent = '';
      const cmd = String(raw || '').replace(/\s+/g, '');
      if (!cmd) { err.textContent = 'Введите команду, например *100#.'; input.focus(); return; }
      if (cmd.length > 40) { err.textContent = 'Команда длиннее 40 символов.'; return; }
      if (!/^[0-9*#+]+$/.test(cmd)) { err.textContent = 'В команде могут быть только цифры, «*», «#» и «+».'; input.focus(); return; }

      setBusy(true, 'Ждем ответ оператора…');
      add('Вы', cmd, 'out');
      if (/^[*#]/.test(cmd)) remember(cmd);
      input.value = '';
      try {
        await ctx.api.post('api/ussd/send', { content: cmd, codeType: 'CodeType', timeout: '' });
        const t0 = Date.now();
        let answer = null;
        while (isAlive() && Date.now() - t0 < WAIT_MAX) {
          await M.sleep(1000);
          try {
            const d = await ctx.api.get('api/ussd/get');
            answer = String((d && d.content) || '').trim();
            break;
          } catch (e) {
            if (e.code !== NOT_READY) throw e;
          }
        }
        if (!isAlive()) return;
        if (answer === null) {
          add('Роутер', 'Оператор не ответил за 2 минуты.', 'err');
          release(false);
        } else {
          add('Оператор', answer || '(пустой ответ)', 'in');
        }
      } catch (e) {
        add('Роутер', errText(e), 'err');
        if (e.code === TIMEOUT) release(false);
      } finally {
        if (isAlive()) {
          setBusy(false);
          await checkSession();
          input.focus();
        }
      }
    };

    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); send(input.value); } });

    root.appendChild(ui.card('Запрос USSD',
      el('p', { class: 'muted' },
        'USSD — короткие команды оператору: баланс, остаток пакета, подключение услуг. ' +
        'Работают только при подключении к сотовой сети.'),
      el('label', { for: 'ussd-cmd' }, 'Команда'),
      el('div', { class: 'ussd-in' }, input, sendBtn),
      err,
      state,
      hist,
      log,
      endRow));
    endRow.hidden = true;
    drawHist();
    await checkSession();
    if (ctx.params && ctx.params.cmd) input.value = ctx.params.cmd;
    input.focus();
  },
});
