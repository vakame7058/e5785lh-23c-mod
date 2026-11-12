// Пространство M и общие мелочи: события, хранилище, форматирование.
const M = window.M = window.M || {};
M.version = '0.1';
M.pages = [];          // зарегистрированные страницы (M.page)
M.state = { loggedIn: false, user: '', features: {}, status: {} };

// --- события: M.on('status', fn) / M.emit('status', data) ---
const handlers = {};
M.on = (name, fn) => {
  (handlers[name] = handlers[name] || []).push(fn);
  return () => M.off(name, fn);
};
M.off = (name, fn) => {
  const a = handlers[name];
  if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
};
M.emit = (name, data) => {
  (handlers[name] || []).slice().forEach((fn) => {
    try { fn(data); } catch (e) { console.warn('M.emit', name, e); }
  });
};

// --- localStorage с try/catch (приватный режим, запрет сайта) ---
M.store = {
  get(key, def) {
    try {
      const v = localStorage.getItem('m.' + key);
      return v === null ? def : JSON.parse(v);
    } catch (e) { return def; }
  },
  set(key, val) {
    try { localStorage.setItem('m.' + key, JSON.stringify(val)); } catch (e) { /* нет хранилища */ }
  },
  del(key) {
    try { localStorage.removeItem('m.' + key); } catch (e) { /* нет хранилища */ }
  },
};

// Всегда массив: в XML стока один элемент списка приходит объектом, а не массивом.
M.arr = (x) => (x === undefined || x === null || x === '' ? [] : Array.isArray(x) ? x : [x]);

M.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

M.int = (x, def) => {
  const n = parseInt(x, 10);
  return isNaN(n) ? (def === undefined ? 0 : def) : n;
};
M.num = (x) => {
  if (x === undefined || x === null) return NaN;
  const m = String(x).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};

// --- форматирование чисел для людей ---
const nf = (v, d) => {
  const s = v.toFixed(d);
  return s.replace('.', ',');
};
M.fmt = {
  bytes(n) {
    n = Number(n) || 0;
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return nf(n, i === 0 || n >= 100 ? 0 : n >= 10 ? 1 : 2) + ' ' + u[i];
  },
  // байт/с → бит/с
  speed(bytesPerSec) {
    let n = (Number(bytesPerSec) || 0) * 8;
    const u = ['бит/с', 'Кбит/с', 'Мбит/с', 'Гбит/с'];
    let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return nf(n, i === 0 || n >= 100 ? 0 : 1) + ' ' + u[i];
  },
  duration(sec) {
    sec = Math.max(0, M.int(sec));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d) return d + ' д ' + h + ' ч';
    if (h) return h + ' ч ' + m + ' мин';
    if (m) return m + ' мин ' + s + ' с';
    return s + ' с';
  },
  // '-95dBm' → '−95 дБм'
  db(x, unit) {
    const v = M.num(x);
    if (isNaN(v)) return '—';
    return String(v).replace('-', '−').replace('.', ',') + ' ' + (unit || 'дБ');
  },
  num(v, d) {
    v = Number(v);
    if (!isFinite(v)) return '—';
    return nf(v, d || 0);
  },
  mac(x) { return String(x || '').toUpperCase(); },
};

// Текст для HTML/XML (экранирование)
M.esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
