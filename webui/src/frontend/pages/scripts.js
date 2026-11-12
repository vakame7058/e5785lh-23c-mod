// Скрипты пользователя в /online/scripts: список, запуск, вывод, правка, автозапуск.
// Вызовы мода (docs/API.md): M.mod('scripts'); POST run, read, save, delete, autorun.

const NAME_RE = /^[A-Za-z0-9_.-]{1,61}\.sh$/;
const TEMPLATE = '#!/bin/sh\n# Скрипт выполняется от root.\n\necho "Привет от роутера"\nuptime\n';

const b64 = (s) => (M.crypto && M.crypto.b64utf8 ? M.crypto.b64utf8(s) : btoa(unescape(encodeURIComponent(s))));
const when = (t) => {
  const n = M.int(t);
  if (!n) return '';
  const d = new Date(n * 1000);
  const p = (x) => (x < 10 ? '0' : '') + x;
  return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};

M.page({
  id: 'scripts',
  title: 'Скрипты',
  group: 'Улучшения',
  icon: 'list',
  order: 430,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;
    let scripts = [];

    const listBox = el('div', null, ui.spinner());
    const runBox = el('div');
    const editBox = el('div');

    const err = (e) => {
      if (e && e.code === '9001') return 'Помощник мода на роутере не отвечает.';
      if (e && e.code === '9005') return 'Скрипт не завершился вовремя и остановлен.';
      return (e && e.message) || 'Ошибка.';
    };

    // --- запуск ---
    const openRun = (s) => {
      ui.clear(editBox);
      ui.clear(runBox);
      const out = ui.pre('');
      out.hidden = true;
      const rcLine = el('div');
      const f = ui.form([
        { name: 'args', label: 'Аргументы', placeholder: 'необязательно', hint: 'Через пробел. Нельзя символы ` $ ; | & < > ( ) \\',
          validate: (v) => (/[`$;|&<>()\\]/.test(v) ? 'В аргументах есть запрещенный символ.' : '') },
        { name: 'timeout', label: 'Ждать не дольше, с', type: 'number', min: 1, max: 60, value: 20,
          hint: 'Не больше 60 с. Потом скрипт останавливается.' },
      ], async (v) => {
        ui.clear(rcLine);
        out.set('Выполняется…');
        out.hidden = false;
        try {
          const r = await ctx.mod('scripts', 'run', { name: s.name, args: v.args || undefined, timeout_s: v.timeout || 20 },
            { timeout: (Number(v.timeout || 20) + 15) * 1000 });
          const rc = M.int(r && r.rc);
          out.set(String((r && r.output) || '').replace(/\s+$/, '') || '(вывода нет)');
          if (String(r && r.timeout) === '1') rcLine.appendChild(ui.badge('остановлен: не уложился в ' + (v.timeout || 20) + ' с', 'warn'));
          else rcLine.appendChild(rc === 0 ? ui.badge('завершен, код 0', 'ok') : ui.badge('завершен с ошибкой, код ' + rc, 'err'));
        } catch (e) {
          out.set(String((e.data && e.data.output) || '').replace(/\s+$/, '') || '(вывода нет)');
          rcLine.appendChild(ui.badge(err(e), 'err'));
        }
        return false;
      }, { submit: 'Запустить' });
      runBox.appendChild(ui.card({ title: 'Запуск: ' + s.name, icon: 'terminal',
        actions: ui.btn('', () => ui.clear(runBox), 'ghost', { icon: 'close', title: 'Закрыть' }) },
      f, rcLine, out));
      runBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // --- правка и новый скрипт ---
    const openEdit = async (s) => {
      ui.clear(runBox);
      ui.clear(editBox);
      const isNew = !s;
      const name = el('input', { type: 'text', id: 'scr-name', class: 'inp', spellcheck: 'false', placeholder: 'my_script.sh', value: isNew ? '' : s.name });
      if (!isNew) name.readOnly = true;
      const ta = el('textarea', { rows: 16, spellcheck: 'false', id: 'scr-body', class: 'inp',
        style: { width: '100%', boxSizing: 'border-box', fontFamily: 'var(--mono)', tabSize: 4 } });
      ta.value = isNew ? TEMPLATE : '';
      const e = el('div', { class: 'form-err', role: 'alert', hidden: true });
      const c = ui.card({ title: isNew ? 'Новый скрипт' : 'Правка: ' + s.name, icon: 'edit',
        actions: ui.btn('', () => ui.clear(editBox), 'ghost', { icon: 'close', title: 'Закрыть' }) },
      el('label', { for: 'scr-name', class: 'f-l' }, 'Имя файла'),
      name,
      el('small', { class: 'hint' }, 'Латиница, цифры, «_», «-», «.»; в конце .sh'),
      el('label', { for: 'scr-body', class: 'f-l' }, 'Текст скрипта'),
      ta,
      e,
      ui.row(
        ui.btn('Сохранить', async () => {
          e.hidden = true;
          const n = name.value.trim();
          if (!NAME_RE.test(n)) { e.textContent = 'Неверное имя. Пример: my_script.sh'; e.hidden = false; name.focus(); return; }
          if (isNew && scripts.some((x) => x.name === n) &&
            !(await ui.confirm('Скрипт ' + n + ' уже есть. Заменить его?', { danger: true, ok: 'Заменить' }))) return;
          const text = ta.value.replace(/\r\n/g, '\n');
          await ctx.mod('scripts', 'save', { name: n, content_b64: b64(text.endsWith('\n') ? text : text + '\n') });
          ui.toast('Скрипт сохранен', 'ok');
          ui.clear(editBox);
          await load();
        }, 'primary'),
        ui.btn('Отмена', () => ui.clear(editBox))));
      editBox.appendChild(c);
      editBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (!isNew) {
        ta.disabled = true;
        try {
          const d = await ctx.mod('scripts', 'read', { name: s.name });
          ta.value = String((d && d.content) || '');
        } catch (x) {
          ui.toast('Не удалось прочитать скрипт. ' + err(x), 'err');
        }
        ta.disabled = false;
        ta.focus();
      } else {
        name.focus();
      }
    };

    const draw = () => {
      ui.clear(listBox);
      listBox.appendChild(ui.table([
        { key: 'name', title: 'Скрипт', render: (s) => el('code', null, s.name) },
        { key: 'size', title: 'Размер', render: (s) => M.fmt.bytes(s.size) },
        { key: 'mtime', title: 'Изменен', render: (s) => when(s.mtime) },
        { key: 'autorun', title: 'При загрузке', render: (s) => {
          const sw = ui.switchInput(String(s.autorun) === '1', async (ev) => {
            const v = ev.target.checked;
            ev.target.disabled = true;
            try {
              await ctx.mod('scripts', 'autorun', { name: s.name, enable: v ? 1 : 0 });
              s.autorun = v ? '1' : '0';
              ui.toast(v ? s.name + ' будет запускаться при загрузке' : 'Автозапуск ' + s.name + ' выключен', 'ok');
            } catch (e) {
              ev.target.checked = !v;
              ui.toast(err(e), 'err');
            }
            ev.target.disabled = false;
          });
          sw.firstChild.setAttribute('aria-label', 'Запускать ' + s.name + ' при загрузке');
          return sw;
        } },
        { key: 'x', title: '', render: (s) => ui.row(
          ui.btn('', () => openRun(s), 'ghost', { icon: 'terminal', title: 'Запустить' }),
          ui.btn('', () => openEdit(s), 'ghost', { icon: 'edit', title: 'Изменить' }),
          ui.btn('', async () => {
            if (!(await ui.confirm('Удалить скрипт ' + s.name + '? Вернуть его будет нельзя.', { danger: true, ok: 'Удалить' }))) return;
            await ctx.mod('scripts', 'delete', { name: s.name });
            ui.toast('Скрипт удален', 'ok');
            await load();
          }, 'ghost', { icon: 'trash', title: 'Удалить' })) },
      ], scripts, { empty: 'Скриптов нет. Создайте первый.' }));
    };

    const load = async () => {
      try {
        const d = await ctx.mod('scripts');
        scripts = M.arr(d && d.scripts && d.scripts.script).filter((x) => x && typeof x === 'object');
        draw();
      } catch (e) {
        ui.clear(listBox);
        listBox.appendChild(ui.notice('Не удалось получить список скриптов. ' + err(e), 'err'));
      }
    };

    root.appendChild(ui.card({ title: 'Скрипты', icon: 'list', actions: ui.btn('Новый скрипт', () => openEdit(null), 'primary', { icon: 'plus' }) },
      ui.notice('Скрипты выполняются от root. Ошибка в скрипте может нарушить работу роутера. ' +
        'Скрипт с автозапуском выполняется через минуту после каждой загрузки.', 'warn'),
      el('p', { class: 'hint' }, 'Каталог /online/scripts. Эти же скрипты видны в меню на экране роутера.'),
      listBox));
    root.appendChild(runBox);
    root.appendChild(editBox);
    await load();
  },
});
