// Оболочка: тема, раскладка, меню, маршрутизатор по hash (#/sms?x=1), шапка с состоянием, запуск.
const { el, clear } = M.ui;

// --- регистрация страниц ---
M.page = (p) => {
  if (!p || !p.id || typeof p.render !== 'function') { console.warn('M.page: нужен id и render', p); return; }
  const i = M.pages.findIndex((x) => x.id === p.id);
  const page = Object.assign({ order: 100, group: '', icon: 'dot', menu: true, public: false }, p);
  if (i >= 0) M.pages[i] = page; else M.pages.push(page);
  if (M._menuBuilt) buildMenu();
};

// Порядок групп меню: по наименьшему order страницы в группе

// --- тема: auto | light | dark ---
const THEMES = ['auto', 'light', 'dark'];
const THEME_NAME = { auto: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: темная' };
const applyTheme = (t) => {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  const dark = t === 'dark' || (t !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = el('meta', { name: 'theme-color' }); document.head.appendChild(meta); }
  meta.content = dark ? '#16181d' : '#f6f7f9';
};
M.theme = {
  get: () => {
    let t = 'auto';
    try { t = localStorage.getItem('m.theme') || 'auto'; } catch (e) { /* нет хранилища */ }
    return THEMES.indexOf(t) >= 0 ? t : 'auto';
  },
  set(t) {
    // в localStorage храним строку без JSON — ее читает ранний скрипт в index.html
    try { if (t === 'auto') localStorage.removeItem('m.theme'); else localStorage.setItem('m.theme', t); } catch (e) { /* нет хранилища */ }
    applyTheme(t);
    M.emit('theme', t);
  },
  next() { const t = M.theme.get(); M.theme.set(THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]); },
};
if (window.matchMedia) {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const f = () => applyTheme(M.theme.get());
  if (mq.addEventListener) mq.addEventListener('change', f); else if (mq.addListener) mq.addListener(f);
}

// --- раскладка ---
const L = {};
const buildLayout = () => {
  const root = document.getElementById('app');
  clear(root);
  L.nav = el('nav', { class: 'nav', 'aria-label': 'Разделы' });
  // тема — кнопкой в шапке: боковое меню целиком помещается на экран 800 px
  L.themeBtn = el('button', { type: 'button', class: 'top-btn', onclick: () => M.theme.next() });
  L.side = el('aside', { class: 'side', id: 'side' },
    el('div', { class: 'brand' }, M.icon('router', 22), el('div', null, el('b', null, 'E5785'), el('small', null, 'панель роутера'))),
    L.nav);
  L.burger = el('button', { type: 'button', class: 'top-btn burger', 'aria-label': 'Меню', 'aria-controls': 'side', onclick: () => setDrawer(!L.app.classList.contains('drawer')) }, M.icon('menu'));
  L.title = el('h1', { class: 'top-title' }, '');
  L.op = el('span', { class: 'st-op' });
  L.net = el('span', { class: 'st-net' });
  L.sig = el('span', { class: 'st-sig', title: 'Сигнал' });
  L.bat = el('span', { class: 'st-bat' });
  L.cpu = el('span', { class: 'st-cpu', title: 'Загрузка процессора', hidden: true });
  L.logout = el('button', { type: 'button', class: 'top-btn', title: 'Выйти', 'aria-label': 'Выйти', onclick: doLogout }, M.icon('logout'));
  L.status = el('div', { class: 'st' }, L.cpu, L.op, L.net, L.sig, L.bat);
  L.top = el('header', { class: 'top' }, L.burger, L.title, L.status, L.themeBtn, L.logout);
  L.progress = el('div', { class: 'progress', hidden: true });
  L.banner = el('div', { class: 'banner', hidden: true });
  L.view = el('main', { class: 'view', id: 'view', tabindex: '-1' });
  L.scrim = el('div', { class: 'scrim', onclick: () => setDrawer(false) });
  L.app = el('div', { class: 'app' }, L.side, el('div', { class: 'main' }, L.top, L.progress, L.banner, L.view), L.scrim);
  root.appendChild(L.app);
  updateThemeBtn();
};
const updateThemeBtn = () => {
  const t = M.theme.get();
  clear(L.themeBtn);
  L.themeBtn.appendChild(M.icon(t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'auto', 18));
  L.themeBtn.title = THEME_NAME[t] + '. Нажмите, чтобы сменить';
  L.themeBtn.setAttribute('aria-label', THEME_NAME[t]);
};
M.on('theme', () => { if (L.themeBtn) updateThemeBtn(); });
const setDrawer = (open) => {
  L.app.classList.toggle('drawer', !!open);
  L.burger.setAttribute('aria-expanded', open ? 'true' : 'false');
};

const buildMenu = () => {
  if (!L.nav) return;
  M._menuBuilt = true;
  clear(L.nav);
  const vis = M.pages.filter((p) => p.menu && !p.public && (!p.visible || p.visible()));
  const groups = {};
  vis.forEach((p) => { const g = p.group || ''; (groups[g] = groups[g] || []).push(p); });
  const keys = Object.keys(groups).sort((a, b) => {
    const ma = Math.min(...groups[a].map((p) => p.order));
    const mb = Math.min(...groups[b].map((p) => p.order));
    return a === '' ? -1 : b === '' ? 1 : ma - mb;
  });
  keys.forEach((g) => {
    const items = groups[g].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ru'));
    const ul = el('ul', null, items.map((p) => el('li', null,
      el('a', { href: '#/' + p.id, class: 'nav-a', 'data-id': p.id }, M.icon(p.icon || 'dot', 18), el('span', null, p.title)))));
    L.nav.appendChild(el('div', { class: 'nav-g' }, g ? el('div', { class: 'nav-h' }, g) : null, ul));
  });
  markActive();
};
const markActive = () => {
  if (!L.nav) return;
  const id = M.cur && M.cur.page ? M.cur.page.id : '';
  L.nav.querySelectorAll('.nav-a').forEach((a) => {
    const on = a.dataset.id === id;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
};

// --- маршрутизатор ---
const parseHash = () => {
  const h = decodeURIComponent((location.hash || '').replace(/^#\/?/, ''));
  const q = h.indexOf('?');
  const path = q >= 0 ? h.slice(0, q) : h;
  const params = {};
  if (q >= 0) {
    h.slice(q + 1).split('&').forEach((kv) => {
      if (!kv) return;
      const i = kv.indexOf('=');
      params[i >= 0 ? kv.slice(0, i) : kv] = i >= 0 ? kv.slice(i + 1) : '';
    });
  }
  const parts = path.split('/').filter(Boolean);
  return { id: parts[0] || '', rest: parts.slice(1), params };
};
const makeHash = (id, params) => {
  const q = Object.keys(params || {}).filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => k + '=' + encodeURIComponent(params[k])).join('&');
  return '#/' + id + (q ? '?' + q : '');
};
M.currentHash = () => (location.hash || '').replace(/^#/, '');
M.go = (id, params) => {
  const h = makeHash(id, params);
  if (location.hash === h) route(); else location.hash = h;
};
M.defaultPage = 'home';

const leave = () => {
  const c = M.cur;
  if (!c) return;
  c.scope.dead = true;
  c.scope.cleanups.splice(0).forEach((f) => { try { f(); } catch (e) { console.warn('cleanup', e); } });
  if (c.page.destroy) { try { c.page.destroy(); } catch (e) { console.warn('destroy', e); } }
  M.keepAwake(false);
  M.cur = null;
};

let routeSeq = 0;
const route = async () => {
  const seq = ++routeSeq;
  const r = parseHash();
  let id = r.id || (M.state.loggedIn ? M.defaultPage : 'login');
  let page = M.pages.find((p) => p.id === id);
  if (page && !page.public && !M.state.loggedIn) {
    M.go('login', { next: M.currentHash() });
    return;
  }
  if (id === 'login' && M.state.loggedIn) { M.go(M.defaultPage); return; }
  leave();
  setDrawer(false);
  document.body.classList.toggle('is-public', !!(page && page.public));
  const scope = { cleanups: [], dead: false };
  const view = L.view;
  clear(view);
  const box = el('div', { class: 'page page-' + id });
  view.appendChild(box);
  const title = page ? page.title : 'Нет такой страницы';
  L.title.textContent = title;
  document.title = title + ' — роутер';
  M.cur = { page: page || { id }, scope, params: r.params, rest: r.rest };
  markActive();
  try { view.scrollTop = 0; window.scrollTo(0, 0); } catch (e) { /* без прокрутки */ }
  if (!page) {
    box.appendChild(M.ui.empty('Раздел «' + id + '» не найден.', 'alert'));
    return;
  }
  const ui = Object.assign({}, M.ui, { poll: M.ui._makePoll(scope) });
  const ctx = {
    api: M.api, mod: M.mod, ui, params: r.params, rest: r.rest, scope,
    onLeave: (f) => scope.cleanups.push(f),
    setTitle: (t) => { if (!scope.dead) { L.title.textContent = t; document.title = t + ' — роутер'; } },
    go: M.go,
  };
  L.progress.hidden = false;
  try {
    await page.render(box, ctx);
  } catch (e) {
    if (seq !== routeSeq || scope.dead) return;
    if (e && (e.code === '125002' || e.code === '125003')) return;   // уйдет на вход
    console.warn('render', id, e);
    box.appendChild(el('div', { class: 'page-err' },
      M.ui.notice('Страница не открылась: ' + M.ui.errMsg(e), 'err'),
      M.ui.btn('Повторить', () => route(), 'primary', { icon: 'refresh' })));
  } finally {
    if (seq === routeSeq) L.progress.hidden = true;
  }
};
M.route = route;
M.ui.poll = (fn, ms, opts) => M.ui._makePoll(M.cur ? M.cur.scope : null)(fn, ms, opts);

// --- состояние в шапке ---
const NETTYPE = {
  0: '', 1: '2G', 2: '2G', 3: '2G', 4: '3G', 5: '3G', 6: '3G', 7: '3G', 8: '3G', 9: '3G+', 10: '3G', 11: '3G', 12: '3G',
  13: '2G', 17: '3G+', 18: '3G+', 19: '4G', 41: '3G', 44: '3G', 45: '3G+', 46: '3G+', 61: '2G', 62: '2G', 63: '2G',
  64: '3G', 65: '3G+', 101: '4G', 1011: '4G+', 111: '5G',
};
M.netType = (st) => {
  const ex = st && st.CurrentNetworkTypeEx;
  const t = ex && ex !== '0' ? NETTYPE[ex] : NETTYPE[st && st.CurrentNetworkType];
  return t || '';
};
const sigBars = (n, max) => {
  const s = el('span', { class: 'bars', 'data-n': n });
  for (let i = 1; i <= (max || 5); i++) s.appendChild(el('i', { class: i <= n ? 'on' : '' }));
  return s;
};
M.ui.bars = sigBars;

let statusBanner = '';
const renderStatus = () => {
  const st = M.state.status || {};
  const plmn = M.state.plmn || {};
  const noSim = st.SimStatus !== undefined && st.SimStatus !== '1';
  const name = noSim ? 'Нет SIM' : (plmn.FullName || plmn.ShortName || plmn.Spn || (st.SignalIcon > 0 ? '' : 'Нет сети'));
  L.op.textContent = name || '';
  // без переходов на «нет SIM»/«нет сигнала», как у стока: только сообщение над страницей
  const simMsg = noSim ? 'SIM-карта не найдена или не готова. Мобильный интернет недоступен.' : '';
  if (simMsg !== statusBanner) { statusBanner = simMsg; M.banner(simMsg, 'warn'); }
  L.net.textContent = M.netType(st);
  L.net.hidden = !L.net.textContent;
  clear(L.sig).appendChild(sigBars(M.int(st.SignalIcon), M.int(st.maxsignal, 5)));
  clear(L.bat);
  if (st.BatteryPercent !== undefined && st.BatteryStatus !== '2') {
    const p = M.int(st.BatteryPercent);
    const charging = st.BatteryStatus === '1';
    L.bat.className = 'st-bat' + (p <= 15 && !charging ? ' low' : '');
    L.bat.title = charging ? 'Заряжается' : 'Батарея';
    L.bat.appendChild(M.icon(charging ? 'charging' : 'battery', 18));
    L.bat.appendChild(el('span', null, p + '%'));
  }
};

let statusPoll = null;
const startStatus = () => {
  if (statusPoll) return;
  let n = 0;
  statusPoll = M.ui._makePoll(null)(async () => {
    if (!M.state.loggedIn) return;
    const st = await M.api.get('api/monitoring/status');
    M.state.status = st || {};
    if (n++ % 3 === 0) {
      try { M.state.plmn = await M.api.get('api/net/current-plmn'); } catch (e) { M.state.plmn = {}; }
    }
    renderStatus();
    M.emit('status', M.state.status);
  }, 5000);
};
const stopStatus = () => { if (statusPoll) { statusPoll.stop(); statusPoll = null; } };

async function doLogout() {
  if (!(await M.ui.confirm('Выйти из интерфейса роутера?', { ok: 'Выйти' }))) return;
  await M.auth.logout();
  M.go('login');
}

M.on('login', () => {
  document.body.classList.add('is-auth');
  buildMenu();
  startStatus();
  M.auth.startIdle();
});
M.on('logout', () => {
  document.body.classList.remove('is-auth');
  stopStatus();
  M.state.status = {};
  M.state.plmn = {};
  // после выхода — на экран входа (кто вызывает M.go('login', {...}) сам, перекроет этот переход)
  if (!(M.cur && M.cur.page && M.cur.page.public)) setTimeout(() => { if (!M.state.loggedIn && parseHash().id !== 'login') M.go('login'); }, 0);
});

// загрузка ЦП в шапке — без своего опроса: только когда страница (сводка) сама читает sysinfo
let cpuHide = 0;
M.on('sysinfo', (d) => {
  if (!L.cpu) return;
  L.cpu.hidden = d.cpu === null;
  if (d.cpu !== null) L.cpu.textContent = 'ЦП ' + Math.round(d.cpu) + '%';
  clearTimeout(cpuHide);
  cpuHide = setTimeout(() => { L.cpu.hidden = true; }, 12000);
});

// баннер вверху страницы: M.banner('текст', 'warn') / M.banner('')
M.banner = (text, kind) => {
  if (!L.banner) return;
  clear(L.banner);
  L.banner.hidden = !text;
  L.banner.className = 'banner banner-' + (kind || 'info');
  if (text) L.banner.appendChild(M.ui.notice(text, kind));
};

// --- запуск ---
const boot = async () => {
  applyTheme(M.theme.get());
  buildLayout();
  buildMenu();
  window.addEventListener('hashchange', route);
  try {
    try {
      M.state.features = await M.api.get('api/global/module-switch');
    } catch (e) { M.state.features = {}; }
    const ok = await M.auth.check();
    if (ok) {
      await M.auth.loadTimeout();
      M.emit('login');
    }
  } catch (e) {
    console.warn('boot', e);
    M.state.loggedIn = false;
    M.banner('Нет связи с роутером: ' + M.ui.errMsg(e), 'err');
  }
  route();
};
M.boot = boot;
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else setTimeout(boot, 0);
