// Экран входа (публичная страница, без меню)
const { el } = M.ui;

const REASON = {
  idle: 'Вы долго не пользовались интерфейсом, вход закрыт. Войдите снова.',
  expired: 'Сессия закончилась. Войдите снова.',
};

M.page({
  id: 'login', title: 'Вход', public: true, menu: false, order: 0,
  async render(box, ctx) {
    const reason = REASON[ctx.params.reason];
    const err = el('div', { class: 'form-err', role: 'alert', hidden: true });
    const user = el('input', { id: 'l-user', name: 'username', autocomplete: 'username', value: M.store.get('user', 'admin'), required: true, spellcheck: 'false', autocapitalize: 'off' });
    const pass = el('input', { id: 'l-pass', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const eye = el('button', { type: 'button', class: 'pw-eye', title: 'Показать пароль', 'aria-label': 'Показать пароль' }, M.icon('eye', 18));
    eye.addEventListener('click', () => {
      const s = pass.type === 'password';
      pass.type = s ? 'text' : 'password';
      eye.replaceChild(M.icon(s ? 'eyeoff' : 'eye', 18), eye.firstChild);
    });
    const submit = el('button', { type: 'submit', class: 'btn btn-primary login-btn' }, 'Войти');
    const theme = el('button', { type: 'button', class: 'btn btn-ghost btn-icon', title: 'Сменить тему', 'aria-label': 'Сменить тему', onclick: () => { M.theme.next(); setThemeIcon(); } });
    const setThemeIcon = () => {
      const t = M.theme.get();
      M.ui.clear(theme).appendChild(M.icon(t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'auto', 18));
    };
    setThemeIcon();

    const form = el('form', { class: 'form login-form', novalidate: true },
      el('div', { class: 'f-row' }, el('label', { class: 'f-l', for: 'l-user' }, 'Имя пользователя'), user),
      el('div', { class: 'f-row' }, el('label', { class: 'f-l', for: 'l-pass' }, 'Пароль'), el('div', { class: 'pw' }, pass, eye)),
      err,
      submit);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      const u = user.value.trim();
      if (!u) { user.focus(); return; }
      if (!pass.value) { pass.focus(); return; }
      submit.disabled = true;
      submit.classList.add('busy');
      try {
        await M.auth.login(u, pass.value);
        M.store.set('user', u);
        const next = ctx.params.next;
        if (next && next.indexOf('/login') !== 1) location.hash = next.charAt(0) === '#' ? next : '#' + next;
        else M.go(M.defaultPage);
      } catch (e) {
        let msg = M.ui.errMsg(e);
        if (e.code === '108007' && e.data && e.data.waittime) msg += ' Ждать: ' + e.data.waittime + ' мин.';
        err.textContent = msg;
        err.hidden = false;
        pass.value = '';
        pass.focus();
      } finally {
        submit.disabled = false;
        submit.classList.remove('busy');
      }
    });

    box.appendChild(el('div', { class: 'login-wrap' },
      el('div', { class: 'login-card' },
        el('div', { class: 'login-top' },
          el('div', { class: 'login-logo' }, M.icon('router', 28)),
          el('div', { class: 'login-t' }, el('h1', null, 'Роутер E5785'), el('div', { class: 'muted' }, 'Войдите, чтобы открыть настройки')),
          theme),
        reason ? M.ui.notice(reason, 'warn') : null,
        form),
      el('p', { class: 'login-foot muted' }, 'Пароль тот же, что для стокового интерфейса. ',
        el('a', { href: '/html/index.html' }, 'Стоковый интерфейс'))));
    setTimeout(() => (user.value ? pass : user).focus(), 50);
  },
});
