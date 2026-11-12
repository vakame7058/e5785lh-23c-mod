// M.ui — строительные блоки страниц (см. CORE.md).

const isNode = (x) => x instanceof Node;
const PROPS = { value: 1, checked: 1, disabled: 1, selected: 1, hidden: 1, readOnly: 1, multiple: 1, indeterminate: 1 };

const el = (tag, attrs, ...children) => {
  const e = document.createElement(tag);
  if (attrs && (isNode(attrs) || typeof attrs !== 'object' || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) {
        if (PROPS[k]) e[k] = false;
        return;
      }
      if (k === 'class' || k === 'className') e.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS[k]) e[k] = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    });
  }
  add(e, children);
  return e;
};
const add = (e, children) => {
  children.forEach((c) => {
    if (c === undefined || c === null || c === false || c === true) return;
    if (Array.isArray(c)) add(e, c);
    else e.appendChild(isNode(c) ? c : document.createTextNode(String(c)));
  });
  return e;
};
const clear = (e) => { while (e.firstChild) e.removeChild(e.firstChild); return e; };
const show = (v) => (v === undefined || v === null || v === '' ? '—' : v);

// Ошибка → текст
const errMsg = (e) => (e && e.message) || String(e || 'Ошибка');

// --- уведомления ---
let toastBox = null;
const toast = (text, kind) => {
  if (!toastBox || !toastBox.isConnected) {
    toastBox = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastBox);
  }
  const icon = { ok: 'check', err: 'alert', warn: 'alert' }[kind] || 'info';
  const t = el('div', { class: 'toast toast-' + (kind || 'info') }, M.icon(icon, 18), el('span', null, text));
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 200); };
  t.addEventListener('click', close);
  toastBox.appendChild(t);
  setTimeout(close, kind === 'err' ? 7000 : 3500);
  return t;
};

// --- модальное окно ---
const modal = (title, content, buttons, opts) => {
  opts = opts || {};
  const prev = document.activeElement;
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  const back = el('div', { class: 'modal-back' }, box);
  const close = (v) => {
    back.classList.add('out');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => back.remove(), 150);
    if (prev && prev.focus) try { prev.focus(); } catch (e) { /* нет фокуса */ }
    if (opts.onClose) opts.onClose(v);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(false); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (ev) => { if (ev.target === back && !opts.sticky) close(false); });
  if (title) box.appendChild(el('h2', { class: 'modal-h' }, title));
  box.appendChild(el('div', { class: 'modal-b' }, content));
  const foot = el('div', { class: 'modal-f' });
  (buttons || [{ label: 'Закрыть', value: false }]).forEach((b) => {
    const node = isNode(b) ? b : el('button', {
      type: 'button',
      class: 'btn ' + (b.kind ? 'btn-' + b.kind : ''),
      onclick: async () => {
        if (b.onClick) {
          try { if ((await b.onClick()) === false) return; } catch (e) { toast(errMsg(e), 'err'); return; }
        }
        close(b.value);
      },
    }, b.label);
    foot.appendChild(node);
  });
  box.appendChild(foot);
  document.body.appendChild(back);
  const f = box.querySelector('input,select,textarea') || foot.querySelector('.btn-primary,.btn-danger-fill') || foot.lastChild;
  if (f) setTimeout(() => f.focus(), 30);
  return { el: box, close };
};

const confirm = (text, opts) => new Promise((resolve) => {
  opts = opts || {};
  modal(opts.title || 'Подтверждение', el('p', { class: 'confirm-text' }, text), [
    { label: opts.cancel || 'Отмена', value: false },
    // яркая красная заливка — только здесь, в окне подтверждения опасного действия
    { label: opts.ok || 'Да', value: true, kind: opts.danger ? 'danger-fill' : 'primary' },
  ], { onClose: (v) => resolve(!!v) });
});

// --- кнопки ---
const btn = (label, onClick, kind, opts) => {
  opts = opts || {};
  const b = el('button', {
    type: opts.type || 'button',
    class: ['btn', kind ? 'btn-' + kind : '', opts.icon && !label ? 'btn-icon' : '', opts.class],
    title: opts.title || null,
    'aria-label': opts.title || null,
    disabled: !!opts.disabled,
  }, opts.icon ? M.icon(opts.icon, 18) : null, label ? el('span', null, label) : null);
  if (onClick) {
    b.addEventListener('click', async (ev) => {
      if (b.classList.contains('busy')) return;
      b.classList.add('busy');
      b.disabled = true;
      try { await onClick(ev, b); } catch (e) { toast(errMsg(e), 'err'); } finally {
        b.classList.remove('busy');
        b.disabled = false;
      }
    });
  }
  return b;
};

// --- переключатель ---
const switchInput = (value, onInput) => {
  const inp = el('input', { type: 'checkbox', class: 'sw-in', checked: !!value, role: 'switch' });
  if (onInput) inp.addEventListener('change', onInput);
  return el('span', { class: 'sw' }, inp, el('span', { class: 'sw-t' }));
};
const toggle = (label, value, onChange, opts) => {
  opts = opts || {};
  const sw = switchInput(value);
  const inp = sw.firstChild;
  const row = el('label', { class: 'toggle-row' + (opts.class ? ' ' + opts.class : '') },
    el('span', { class: 'toggle-l' }, label, opts.hint ? el('small', { class: 'hint' }, opts.hint) : null), sw);
  inp.addEventListener('change', async () => {
    const v = inp.checked;
    if (!onChange) return;
    inp.disabled = true;
    row.classList.add('busy');
    try {
      const r = await onChange(v);
      if (r === false) inp.checked = !v;
    } catch (e) {
      inp.checked = !v;
      toast(errMsg(e), 'err');
    } finally {
      inp.disabled = !!opts.disabled;
      row.classList.remove('busy');
    }
  });
  if (opts.disabled) inp.disabled = true;
  row.set = (v) => { inp.checked = !!v; };
  row.disable = (d) => { inp.disabled = !!d; };
  Object.defineProperty(row, 'value', { get: () => inp.checked });
  return row;
};

// Переключатель для заголовка карточки (вкл/выкл службы, туннеля): onChange(новое) — асинхронно; пока идет —
// крутилка на месте переключателя; вернул false или бросил — откат, текст ошибки в toast. .set(v), .busy(b)
const headSwitch = (value, onChange, opts) => {
  opts = opts || {};
  const sw = switchInput(value);
  const inp = sw.firstChild;
  inp.setAttribute('aria-label', opts.label || 'Включено');
  if (opts.title) sw.title = opts.title;
  const box = el('span', { class: 'head-sw' }, sw);
  const busy = (b) => { box.classList.toggle('busy', !!b); inp.disabled = !!b || !!opts.disabled; };
  inp.addEventListener('change', async () => {
    const v = inp.checked;
    busy(true);
    try {
      if ((await onChange(v)) === false) inp.checked = !v;
    } catch (e) {
      inp.checked = !v;
      toast(errMsg(e), 'err');
    } finally { busy(false); }
  });
  if (opts.disabled) inp.disabled = true;
  box.set = (v) => { inp.checked = !!v; };
  box.busy = busy;
  return box;
};

// Ссылка вместо тупика: действие требует флага помощника — включается в «Системе» → «Опасные настройки»
const dangerLink = (text) => el('a', { href: '#/system?focus=danger', class: 'danger-link' }, text || 'Включить в «Системе» → «Опасные настройки»');

// --- карточка ---
// Действия карточки — справа в строке заголовка, компактные. Главное (btn-primary) видно всегда, остальные
// на телефоне сворачиваются в «…». card.setActions([...]) — заменить действия (состояние поменялось).
const cardMenu = (btn, items) => {
  const list = el('div', { class: 'menu', role: 'menu' }, items.map((b) => el('button', {
    type: 'button', role: 'menuitem', class: 'menu-i' + (b.classList.contains('btn-danger') ? ' danger' : ''),
    disabled: b.disabled, onclick: () => { close(); b.click(); },
  }, (b.textContent || b.title || '').trim())));
  const back = el('div', { class: 'menu-back', onclick: (ev) => { if (ev.target === back) close(); } }, list);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  const r = btn.getBoundingClientRect();
  list.style.top = Math.round(r.bottom + 4) + 'px';
  list.style.right = Math.round(window.innerWidth - r.right) + 'px';
  document.body.appendChild(back);
  const f = list.querySelector('.menu-i:not([disabled])');
  if (f) f.focus();
};
const fillActions = (box, actions) => {
  clear(box);
  const acts = [].concat(actions || []).filter((a) => a && isNode(a));
  acts.forEach((a) => {
    if (a.classList && a.classList.contains('btn')) a.classList.add('btn-sm');
    // в «…» уходят только кнопки (значок состояния остается на месте)
    if (acts.length > 1 && a.classList && a.classList.contains('btn') && !a.classList.contains('btn-primary')) a.classList.add('act-2nd');
  });
  add(box, acts);
  // act-menu — действие только в «…» (редкое: «Проверить состояние»); act-2nd — в «…» на телефоне
  const second = acts.filter((a) => a.classList && (a.classList.contains('act-2nd') || a.classList.contains('act-menu')));
  if (second.length) {
    const always = second.some((a) => a.classList.contains('act-menu'));
    const more = el('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon card-more' + (always ? ' always' : ''), title: 'Еще действия', 'aria-label': 'Еще действия' }, M.icon('more', 18));
    more.addEventListener('click', () => cardMenu(more, second));
    box.appendChild(more);
  }
};
const card = (title, ...children) => {
  let head = null;
  let actBox = null;
  if (title) {
    const t = typeof title === 'object' && !isNode(title) ? title : { title };
    actBox = el('div', { class: 'card-a' });
    if (t.actions) fillActions(actBox, t.actions);
    head = el('div', { class: 'card-h' },
      t.icon ? M.icon(t.icon, 18) : null,
      el('h2', null, t.title),
      t.sub ? el('span', { class: 'card-sub' }, t.sub) : null,
      actBox);
  }
  const c = el('section', { class: 'card' }, head, el('div', { class: 'card-b' }, children));
  c.setActions = (actions) => { if (actBox) fillActions(actBox, actions); };
  return c;
};

// --- пары «название — значение» ---
const kv = (rows) => {
  const dl = el('dl', { class: 'kv' });
  dl.update = (r) => {
    clear(dl);
    const list = Array.isArray(r) ? r : Object.keys(r || {}).map((k) => [k, r[k]]);
    list.forEach((row) => {
      if (!row) return;
      dl.appendChild(el('div', { class: 'kv-r' }, el('dt', null, row[0]), el('dd', null, show(row[1]),
        row[2] ? el('small', { class: 'hint' }, row[2]) : null)));
    });
    return dl;
  };
  return dl.update(rows);
};

// --- таблица (на узком экране — карточки строк) ---
const table = (columns, rows, opts) => {
  opts = opts || {};
  const cols = columns.map((c) => (typeof c === 'string' ? { key: c, title: c } : c));
  const wrap = el('div', { class: 'tbl-wrap' + (opts.class ? ' ' + opts.class : '') });
  wrap.update = (list) => {
    clear(wrap);
    list = M.arr(list);
    if (!list.length) {
      wrap.appendChild(empty(opts.empty || 'Нет данных'));
      return wrap;
    }
    const thead = el('thead', null, el('tr', null, cols.map((c) => el('th', { class: c.cls || null, style: c.width ? { width: c.width } : null }, c.title))));
    const tbody = el('tbody', null, list.map((r, i) => {
      const tr = el('tr', { class: opts.rowClass ? opts.rowClass(r) : null },
        cols.map((c) => el('td', { 'data-label': c.title, class: c.cls || null }, show(c.render ? c.render(r, i) : r[c.key]))));
      if (opts.onRow) { tr.classList.add('clickable'); tr.addEventListener('click', () => opts.onRow(r, i)); }
      return tr;
    }));
    wrap.appendChild(el('table', { class: 'tbl' }, thead, tbody));
    return wrap;
  };
  return wrap.update(rows);
};

// --- форма ---
const normOptions = (o) => {
  if (!o) return [];
  if (!Array.isArray(o)) return Object.keys(o).map((k) => ({ value: k, label: o[k] }));
  return o.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] }
    : typeof x === 'object' ? x : { value: x, label: x }));
};
const fillSelect = (sel, options, value) => {
  clear(sel);
  normOptions(options).forEach((o) => sel.appendChild(el('option', { value: String(o.value), disabled: !!o.disabled }, o.label)));
  if (value !== undefined && value !== null) sel.value = String(value);
};

const form = (fields, onSubmit, opts) => {
  opts = opts || {};
  const f = el('form', { class: 'form' + (opts.class ? ' ' + opts.class : ''), novalidate: true, autocomplete: 'off' });
  const inputs = {};
  const rows = {};
  const errBox = el('div', { class: 'form-err', role: 'alert', hidden: true });

  fields.forEach((fd) => {
    if (isNode(fd)) { f.appendChild(fd); return; }
    const id = 'f-' + Math.random().toString(36).slice(2, 9);
    const t = fd.type || 'text';
    let inp;
    let control;
    const common = { id, name: fd.name, disabled: !!fd.disabled, required: !!fd.required, placeholder: fd.placeholder || null };
    if (t === 'select') {
      inp = el('select', common);
      fillSelect(inp, fd.options, fd.value);
      control = inp;
    } else if (t === 'checkbox') {
      // галка с подписью справа; подпись поля (label) не нужна — текст в fd.text
      inp = el('input', { type: 'checkbox', id, name: fd.name, checked: !!fd.value, disabled: !!fd.disabled });
      control = el('label', { class: 'chk', for: id }, inp, el('span', null, fd.text || fd.label || ''));
    } else if (t === 'toggle') {
      control = switchInput(fd.value);
      inp = control.firstChild;
      inp.id = id;
      inp.name = fd.name;
      inp.disabled = !!fd.disabled;
    } else if (t === 'textarea') {
      inp = el('textarea', Object.assign(common, { rows: fd.rows || 4, maxlength: fd.maxlength || null }));
      inp.value = fd.value === undefined || fd.value === null ? '' : fd.value;
      control = inp;
    } else if (t === 'static') {
      inp = el('div', { class: 'static', id }, show(fd.value));
      control = inp;
    } else {
      inp = el('input', Object.assign(common, {
        type: t === 'password' ? 'password' : t === 'number' ? 'text' : t,
        inputmode: t === 'number' ? 'numeric' : null,
        min: fd.min, max: fd.max, step: fd.step,
        maxlength: fd.maxlength || null, pattern: fd.pattern || null,
        autocomplete: fd.autocomplete || (t === 'password' ? 'new-password' : 'off'),
        spellcheck: 'false',
      }));
      inp.value = fd.value === undefined || fd.value === null ? '' : fd.value;
      control = inp;
      if (t === 'password') {
        const eye = el('button', { type: 'button', class: 'pw-eye', title: 'Показать пароль', 'aria-label': 'Показать пароль' }, M.icon('eye', 18));
        eye.addEventListener('click', () => {
          const s = inp.type === 'password';
          inp.type = s ? 'text' : 'password';
          eye.replaceChild(M.icon(s ? 'eyeoff' : 'eye', 18), eye.firstChild);
        });
        control = el('div', { class: 'pw' }, inp, eye);
      }
    }
    if (fd.attrs) Object.keys(fd.attrs).forEach((k) => inp.setAttribute(k, fd.attrs[k]));
    inputs[fd.name] = { el: inp, fd };
    const err = el('div', { class: 'f-err', hidden: true });
    const hint = fd.hint ? el('small', { class: 'hint' }, fd.hint) : null;
    // у переключателя подсказка под названием слева, сам переключатель справа
    // у галки подпись — сам текст рядом с ней, отдельной колонки подписи нет
    const row = t === 'checkbox'
      ? el('div', { class: 'f-row f-checkbox f-wide' }, el('div', { class: 'f-c' }, control, hint, err))
      : el('div', { class: ['f-row', 'f-' + t, fd.wide ? 'f-wide' : ''] },
        el('label', { class: 'f-l', for: id }, fd.label || '', t === 'toggle' ? hint : null),
        el('div', { class: 'f-c' }, control, t === 'toggle' ? null : hint, err));
    row.err = err;
    rows[fd.name] = row;
    f.appendChild(row);
  });

  const values = () => {
    const v = {};
    Object.keys(inputs).forEach((k) => {
      const { el: inp, fd } = inputs[k];
      if (fd.type === 'static') return;
      if (fd.type === 'toggle' || fd.type === 'checkbox') v[k] = inp.checked;
      else v[k] = fd.type === 'password' ? inp.value : String(inp.value).trim();
    });
    return v;
  };
  const refreshVisibility = () => {
    const v = values();
    Object.keys(inputs).forEach((k) => {
      const fd = inputs[k].fd;
      if (fd.show) rows[k].hidden = !fd.show(v);
    });
  };
  f.addEventListener('input', refreshVisibility);
  f.addEventListener('change', refreshVisibility);
  refreshVisibility();

  const validate = (v) => {
    let ok = true;
    Object.keys(inputs).forEach((k) => {
      const { fd } = inputs[k];
      const row = rows[k];
      if (row.hidden) return;
      let msg = '';
      const val = v[k];
      if (fd.required && (val === '' || val === undefined)) msg = 'Заполните поле.';
      else if (fd.type === 'number' && val !== '') {
        const n = Number(val);
        if (!/^-?\d+(\.\d+)?$/.test(val)) msg = 'Нужно число.';
        else if (fd.min !== undefined && n < fd.min) msg = 'Не меньше ' + fd.min + '.';
        else if (fd.max !== undefined && n > fd.max) msg = 'Не больше ' + fd.max + '.';
      }
      if (!msg && fd.validate) msg = fd.validate(val, v) || '';
      row.err.textContent = msg;
      row.err.hidden = !msg;
      row.classList.toggle('invalid', !!msg);
      if (msg) ok = false;
    });
    return ok;
  };

  const actions = el('div', { class: 'form-a' });
  // основная кнопка — одна на экран: форма просит ее явно ({primary: true}), иначе кнопка вторичная
  const submitBtn = el('button', { type: 'submit', class: opts.primary ? 'btn btn-primary' : 'btn' }, opts.submit || 'Сохранить');
  if (onSubmit && opts.submit !== false) actions.appendChild(submitBtn);
  if (opts.actions) add(actions, [opts.actions]);
  f.appendChild(errBox);
  if (actions.childNodes.length) f.appendChild(actions);

  f.busy = (b) => {
    submitBtn.disabled = !!b;
    submitBtn.classList.toggle('busy', !!b);
  };
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!onSubmit || submitBtn.disabled) return;
    errBox.hidden = true;
    const v = values();
    if (!validate(v)) return;
    f.busy(true);
    try {
      const r = await onSubmit(v, f);
      if (r !== false && !opts.silent) toast(opts.done || 'Сохранено', 'ok');
    } catch (e) {
      errBox.textContent = errMsg(e);
      errBox.hidden = false;
      toast(errMsg(e), 'err');
    } finally {
      f.busy(false);
    }
  });

  f.values = values;
  f.field = (name) => (inputs[name] ? inputs[name].el : null);
  f.row = (name) => rows[name] || null;
  f.set = (name, value) => {
    const i = inputs[name];
    if (!i) return;
    if (i.fd.type === 'toggle' || i.fd.type === 'checkbox') i.el.checked = !!value;
    else if (i.fd.type === 'static') i.el.textContent = show(value);
    else i.el.value = value === undefined || value === null ? '' : value;
    refreshVisibility();
  };
  f.setAll = (obj) => Object.keys(obj || {}).forEach((k) => f.set(k, obj[k]));
  f.setOptions = (name, options, value) => {
    const i = inputs[name];
    if (i && i.fd.type === 'select') fillSelect(i.el, options, value === undefined ? i.el.value : value);
  };
  f.error = (text) => { errBox.textContent = text || ''; errBox.hidden = !text; };
  return f;
};

// --- мелочи ---
const spinner = (text) => el('div', { class: 'spinner-row' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), text ? el('span', null, text) : null);
const badge = (text, kind) => el('span', { class: 'badge badge-' + (kind || 'muted') }, text);
const empty = (text, icon) => el('div', { class: 'empty' }, M.icon(icon || 'info', 22), el('span', null, text));
const notice = (text, kind) => el('div', { class: 'notice notice-' + (kind || 'info') }, M.icon(kind === 'ok' ? 'check' : kind === 'info' || !kind ? 'info' : 'alert', 18), el('div', null, text));
const pre = (text, opts) => {
  const p = el('pre', { class: 'pre' + (opts && opts.class ? ' ' + opts.class : '') }, text || '');
  p.set = (t) => { p.textContent = t || ''; p.scrollTop = p.scrollHeight; };
  return p;
};
const grid = (...children) => el('div', { class: 'grid' }, children);
// строка действия: слева название и пояснение, справа компактная кнопка; на узкой карточке кнопка уходит под текст
const actionRow = (label, hint, button) => {
  if (button && button.classList) button.classList.add('btn-sm');
  return el('div', { class: 'act-row' },
    el('div', { class: 'act-row-t' }, el('div', { class: 'act-row-l' }, label), hint ? el('small', { class: 'hint' }, hint) : null),
    button);
};
const stats = (...children) => el('div', { class: 'stats' }, children);
// колонки-стопки с заданным составом: stacks([a, b, c], [d]) — на узком экране одна колонка, по порядку
const stacks = (...cols) => el('div', { class: 'stacks' }, cols.map((c) => el('div', { class: 'stack-col' }, c)));
// большая колонка 2/3 и малая 1/3 (от 1300 px); уже — одна колонка, элементы с классом stack-last уходят вниз
const stacks21 = (big, small) => {
  const s = stacks(big, small);
  s.classList.add('stacks-21');
  return s;
};
// две колонки содержимого внутри широкой карточки (от 1000 px ее ширины), уже — стопкой, правая ниже.
// Правая пуста — левая на всю ширину. opts.big — левая шире (3:2), для таблицы рядом с формой
const split = (left, right, opts) => el('div', { class: 'split' + (opts && opts.big ? ' split-32' : '') },
  el('div', { class: 'split-col' }, left), el('div', { class: 'split-col' }, right));
const subhead = (text) => el('h3', { class: 'sub-h' }, text);
const row = (...children) => el('div', { class: 'row' }, children);
const stat = (label, value, sub, opts) => {
  opts = opts || {};
  const v = el('div', { class: 'stat-v' }, show(value));
  const s = el('div', { class: 'stat-s' }, sub || '');
  const n = el('div', { class: 'stat' + (opts.class ? ' ' + opts.class : '') },
    el('div', { class: 'stat-l' }, opts.icon ? M.icon(opts.icon, 16) : null, label), v, s);
  n.set = (val, sb) => { v.textContent = show(val); if (sb !== undefined) s.textContent = sb; };
  return n;
};

// meter(значение, мин, макс, подпись, {fmt, good, bad}) — полоса; цвет по порогам good/bad (больше — лучше,
// если good > bad). .set(v) обновляет.
const meter = (value, min, max, label, opts) => {
  opts = opts || {};
  const bar = el('div', { class: 'meter-f' });
  const val = el('span', { class: 'meter-v' });
  const n = el('div', { class: 'meter' },
    el('div', { class: 'meter-h' }, el('span', { class: 'meter-l' }, label || ''), val),
    el('div', { class: 'meter-t' }, bar));
  n.set = (v) => {
    const x = Number(v);
    const ok = v !== '' && v !== null && v !== undefined && isFinite(x);
    const p = ok ? Math.max(0, Math.min(1, (x - min) / (max - min))) : 0;
    bar.style.width = (p * 100).toFixed(1) + '%';
    val.textContent = ok ? (opts.fmt ? opts.fmt(x) : String(x)) : '—';
    let lvl = 'neutral';
    if (!ok) lvl = 'none';
    else if (opts.good !== undefined && opts.bad !== undefined) {
      const hi = opts.good > opts.bad;
      if (hi ? x >= opts.good : x <= opts.good) lvl = 'good';
      else if (hi ? x <= opts.bad : x >= opts.bad) lvl = 'bad';
    }
    n.dataset.level = lvl;
  };
  n.set(value);
  return n;
};

// --- опрос: fn сразу и каждые ms, без наложения; пауза, пока вкладка скрыта; стоп при уходе со страницы ---
const makePoll = (scope) => (fn, ms, opts) => {
  opts = opts || {};
  let stopped = false;
  let timer = 0;
  let running = false;
  const tick = async () => {
    timer = 0;
    if (stopped) return;
    if (document.hidden && !opts.hidden) { timer = setTimeout(tick, 1000); return; }
    // M.quiet — идет замер скорости: опросы страницы и шапки ждут, ЦП роутера нужен замеру
    if (M.quiet) { timer = setTimeout(tick, 1000); return; }
    running = true;
    try { await fn(); } catch (e) {
      if (opts.onError) opts.onError(e);
      else if (!(e && (e.code === '125002' || e.code === '125003'))) console.warn('poll:', errMsg(e));
    }
    running = false;
    if (!stopped) timer = setTimeout(tick, p.ms);
  };
  const p = {
    ms,
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = 0; },
    now() { if (!stopped && !running) { if (timer) clearTimeout(timer); tick(); } },
    setInterval(v) { p.ms = v; p.now(); },
  };
  if (scope && scope.dead) { stopped = true; return p; }
  if (scope) scope.cleanups.push(() => p.stop());
  tick();
  return p;
};

// вкладки: tabs([[id, текст], …] или [{id, label}], onChange(id), активная) → полоса кнопок; .set(id), .value
const tabs = (items, onChange, active) => {
  const list = items.map((x) => (Array.isArray(x) ? { id: x[0], label: x[1] } : x));
  const bar = el('div', { class: 'tabs', role: 'tablist' });
  const btns = list.map((t) => el('button', { type: 'button', class: 'tab', role: 'tab', 'data-id': t.id,
    onclick: () => { if (bar.value !== t.id) { bar.set(t.id); if (onChange) onChange(t.id); } } },
  t.icon ? M.icon(t.icon, 16) : null, t.label, t.badge !== undefined && t.badge !== '' ? el('span', { class: 'tab-n' }, t.badge) : null));
  add(bar, btns);
  bar.set = (id) => {
    bar.value = id;
    btns.forEach((b) => { const on = b.dataset.id === String(id); b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  };
  bar.set(active !== undefined ? active : (list[0] && list[0].id));
  return bar;
};

M.ui = { el, add, clear, tabs, stats, stacks, subhead, headSwitch, dangerLink, card, kv, table, form, btn, toggle, toast, confirm, modal, spinner, badge, meter, empty,
  notice, pre, grid, stacks21, split, actionRow, row, stat, icon: M.icon, errMsg, switchInput, poll: makePoll(null), _makePoll: makePoll };
