// Консоль AT: команды модему.
// Вызовы мода (docs/API.md): M.mod('at') — режим и список запрещенных; M.mod('at', 'send', {cmd}) → <output>.

const HIST_KEY = 'at.history';
const HIST_MAX = 30;
const QUICK = [
  ['ATI', 'модель и версия'],
  ['AT+CSQ', 'уровень сигнала'],
  ['AT^HCSQ?', 'сигнал подробно'],
  ['AT+COPS?', 'оператор'],
  ['AT^SYSINFOEX', 'состояние сети'],
  ['AT^SYSCFGEX?', 'режим сети'],
  ['AT+CGDCONT?', 'точки доступа'],
  ['AT^CHIPTEMP?', 'температура'],
];

M.page({
  id: 'atconsole',
  title: 'Консоль AT',
  group: 'Улучшения',
  icon: 'terminal',
  order: 440,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;
    let hist = M.store.get(HIST_KEY, []);
    let pos = -1;
    let info = null;

    const out = ui.pre('');
    out.style.minHeight = '220px';
    out.setAttribute('aria-live', 'polite');
    const input = el('input', {
      type: 'text', id: 'at-cmd', class: 'inp', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters',
      placeholder: 'AT+CSQ', style: { flex: '1 1 200px', minWidth: 0, fontFamily: 'var(--mono)', fontSize: '16px' },
    });
    const modeBox = el('div');
    const log = [];

    const print = (text) => {
      log.push(text);
      while (log.length > 200) log.shift();
      out.set(log.join('\n'));
    };

    const send = async (raw) => {
      const cmd = String(raw || '').trim();
      if (!cmd) { input.focus(); return; }
      if (!/^AT/i.test(cmd)) { ui.toast('Команда должна начинаться с AT.', 'warn'); input.focus(); return; }
      if (/[\r\n;]/.test(cmd)) { ui.toast('Одна команда за раз: без «;» и переводов строки.', 'warn'); return; }
      hist = [cmd].concat(hist.filter((x) => x !== cmd)).slice(0, HIST_MAX);
      M.store.set(HIST_KEY, hist);
      pos = -1;
      input.value = '';
      print('> ' + cmd);
      try {
        const d = await ctx.mod('at', 'send', { cmd });
        const text = String((d && typeof d === 'object' ? d.output : d) || '').replace(/\s+$/, '');
        print(text || '(пустой ответ)');
      } catch (e) {
        if (e.code === '9002') print('Запрещено: эта команда в черном списке, она может испортить модем.');
        else if (e.code === '9008') print('Запрещено сейчас: команда меняет состояние модема, а разрешены только запросы.');
        else if (e.code === '9001') print('Помощник мода на роутере не отвечает.');
        else print('Ошибка: ' + e.message + (e.data && e.data.output ? '\n' + e.data.output : ''));
      }
      print('');
      input.focus();
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); send(input.value); return; }
      if (ev.key === 'ArrowUp' && hist.length) {
        ev.preventDefault();
        pos = Math.min(pos + 1, hist.length - 1);
        input.value = hist[pos];
      } else if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        pos = Math.max(pos - 1, -1);
        input.value = pos >= 0 ? hist[pos] : '';
      }
    });

    const drawMode = () => {
      ui.clear(modeBox);
      if (!info) return;
      const full = String(info.mode) === 'full';
      const bl = M.arr(info.blacklist && info.blacklist.cmd).filter((x) => typeof x === 'string');
      modeBox.appendChild(ui.kv([
        ['Режим', full ? ui.badge('все команды', 'warn') : ui.badge('только запросы', 'ok'),
          full ? 'Разрешены команды, меняющие настройки модема.' : 'Можно ATI, команды со знаком «?» на конце и чтение вроде AT+CSQ, AT^SYSINFOEX.'],
        bl.length ? ['Заблокированы всегда', bl.join(', ')] : null,
      ]));
      if (!full) modeBox.appendChild(el('small', { class: 'hint' }, 'Команды, меняющие модем, разрешаются отдельно: ', ui.dangerLink()));
    };

    root.appendChild(ui.card({ title: 'Консоль AT', icon: 'terminal', actions: [ui.btn('Очистить', () => { log.length = 0; out.set(''); }, 'ghost')] },
      ui.notice('Команды идут прямо в модем. Опасные команды (смена IMEI, запись NV, прошивка) заблокированы, ' +
        'но и разрешенные могут сбить настройки сети. Не вводите команды, которых не понимаете.', 'warn'),
      // широкая карточка: режим и ввод команды слева, ответы модема справа
      ui.split([
        modeBox,
        el('label', { for: 'at-cmd', class: 'f-l' }, 'Команда'),
        el('div', { class: 'row' }, input, ui.btn('Отправить', () => send(input.value), 'primary')),
        el('small', { class: 'hint' }, 'Стрелки вверх и вниз — предыдущие команды.'),
        el('div', { class: 'row' },
          QUICK.map((q) => ui.btn(q[0], () => send(q[0]), 'ghost', { title: q[0] + ' — ' + q[1], class: 'btn-sm' }))),
      ], [ui.subhead('Ответы модема'), out])));

    try {
      info = await ctx.mod('at');
      drawMode();
    } catch (e) {
      modeBox.appendChild(ui.notice(e.code === '9001' ? 'Помощник мода на роутере не отвечает: консоль недоступна.'
        : 'Не удалось получить режим консоли. ' + e.message, 'err'));
    }
    input.focus();
  },
});
