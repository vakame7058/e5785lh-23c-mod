// Связь со стоковым API (XML) и своими /api/mod/*. Логика как в официальном WebUI (js/main.js):
// токены CSRF одноразовые: POST берет первый из очереди, новые приходят в заголовках ответа.

// --- коды ошибок → текст для человека ---
// Только общие коды. Коды разделов (SMS 113018, USSD 111019/111020 …) у стока значат разное —
// их переводит страница: opts.errors = {113018: 'текст'} в M.api.get/post.
const ERR = {
  net: 'Нет связи с роутером. Проверьте подключение к его сети.',
  timeout: 'Роутер не ответил вовремя. Повторите попытку.',
  parse: 'Роутер прислал непонятный ответ.',
  100001: 'Неизвестная ошибка роутера.',
  100002: 'Роутер не поддерживает эту функцию.',
  100003: 'Нет прав. Войдите в интерфейс.',
  100004: 'Роутер занят. Повторите через несколько секунд.',
  100005: 'Роутер отклонил данные: неверный формат.',
  100006: 'Неверные параметры запроса.',
  100008: 'Неизвестная ошибка роутера.',
  100009: 'Ошибка записи настроек.',
  103002: 'SIM-карта не готова.',
  103015: 'SIM-карта заблокирована.',
  108001: 'Неверное имя пользователя.',
  108002: 'Неверный пароль.',
  108003: 'Этот пользователь уже вошел с другого устройства или разблокирован экран роутера.',
  108006: 'Неверное имя пользователя или пароль.',
  108007: 'Слишком много неудачных попыток. Вход временно закрыт, повторите позже.',
  108009: 'Пользователь уже вошел.',
  108010: 'Слишком много попыток входа. Повторите позже.',
  108011: 'Этому пользователю вход запрещен.',
  120001: 'Идет голосовой вызов, роутер занят.',
  125001: 'Неверный токен запроса. Обновите страницу.',
  125002: 'Сессия закончилась. Войдите снова.',
  125003: 'Сессия закончилась. Войдите снова.',
};

class ApiError extends Error {
  constructor(code, message, data) {
    code = String(code);
    super(message || ERR[code] || ('Ошибка роутера, код ' + code + '.'));
    this.name = 'ApiError';
    this.code = code;
    this.data = data || {};   // прочие поля из <error> (count, waittime …)
  }
}
M.ApiError = ApiError;
M.errText = (code) => ERR[String(code)] || ('Ошибка роутера, код ' + code + '.');
M.errors = ERR;   // страницы могут дополнять: M.errors[кодN] = 'текст'

// --- XML ↔ объект ---
const nodeToObj = (node) => {
  const kids = Array.prototype.filter.call(node.childNodes, (n) => n.nodeType === 1);
  if (!kids.length) return node.textContent;
  const obj = {};
  kids.forEach((k) => {
    const v = nodeToObj(k);
    const name = k.tagName;
    if (Object.prototype.hasOwnProperty.call(obj, name)) {
      // значение узла — строка или объект, поэтому массив здесь только от повтора
      if (!Array.isArray(obj[name])) obj[name] = [obj[name]];
      obj[name].push(v);
    } else {
      obj[name] = v;
    }
  });
  return obj;
};

M.xml = {
  parse(text) {
    // как сток: вычищаем управляющие символы, на которых падает разбор (SMS, USSD)
    const clean = String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');
    const doc = new DOMParser().parseFromString(clean, 'text/xml');
    const root = doc.documentElement;
    if (!root || root.getElementsByTagName('parsererror').length || root.tagName === 'parsererror') {
      return { type: 'unknown' };
    }
    if (root.tagName === 'error') {
      const o = nodeToObj(root);
      return { type: 'error', code: (o && o.code) || '', message: (o && o.message) || '', data: o };
    }
    return { type: root.tagName, data: nodeToObj(root) };
  },
  // объект → XML. Булевы → 1/0, массивы → повторяющиеся элементы, null/undefined пропускаются.
  build(obj, root) {
    const enc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    const rec = (name, v) => {
      if (v === undefined || v === null) return '';
      if (Array.isArray(v)) return v.map((x) => rec(name, x)).join('');
      if (typeof v === 'boolean') return '<' + name + '>' + (v ? 1 : 0) + '</' + name + '>';
      if (typeof v === 'object') {
        return '<' + name + '>' + Object.keys(v).map((k) => rec(k, v[k])).join('') + '</' + name + '>';
      }
      return '<' + name + '>' + enc(v) + '</' + name + '>';
    };
    return '<?xml version="1.0" encoding="UTF-8"?>' + rec(root || 'request', obj);
  },
};

// --- токены ---
const tokens = [];
const readMetaTokens = () => {
  tokens.length = 0;
  document.querySelectorAll('meta[name="csrf_token"]').forEach((m) => { if (m.content) tokens.push(m.content); });
};
const takeHeaderTokens = (res) => {
  const h = (n) => res.headers.get(n);
  const one = h('__RequestVerificationTokenone');
  if (one) {
    tokens.push(one.trim().substr(0, 32));
    const two = h('__RequestVerificationTokentwo');
    if (two) tokens.push(two.trim().substr(0, 32));
    return;
  }
  const t = h('__RequestVerificationToken');
  if (t) tokens.push(t.trim().split('#')[0].substr(0, 32));
};

const TIMEOUT = 30000;
const url = (path) => '/' + String(path).replace(/^\/+/, '');

const request = async (method, path, body, headers, timeout) => {
  const ctl = window.AbortController ? new AbortController() : null;
  const tm = ctl ? setTimeout(() => ctl.abort(), timeout || TIMEOUT) : 0;
  let res, text;
  try {
    res = await fetch(url(path), {
      method,
      body,
      headers: Object.assign({ '_ResponseSource': 'Broswer', 'X-Requested-With': 'XMLHttpRequest' }, headers || {}),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined,
    });
    text = await res.text();
  } catch (e) {
    throw new ApiError(e && e.name === 'AbortError' ? 'timeout' : 'net');
  } finally {
    if (tm) clearTimeout(tm);
  }
  return { res, text };
};

// 100003 «нет прав» приходит и после истечения сессии: обработчик session-lost сверяет state-login
const SESSION_CODES = { 100003: 1, 125002: 1, 125003: 1 };

// Ответ → данные или исключение
const handle = (path, res, text, errs) => {
  const r = M.xml.parse(text);
  if (r.type === 'error') {
    const err = new ApiError(r.code, (errs && errs[r.code]) || ERR[r.code] || r.message || '', r.data);
    if (SESSION_CODES[r.code]) M.emit('session-lost', { path, code: r.code });
    throw err;
  }
  if (r.type === 'unknown') {
    if (!res.ok) throw new ApiError(res.status === 404 ? 100002 : 'net', res.status === 404 ? '' : ('HTTP ' + res.status));
    throw new ApiError('parse');
  }
  return r.data;
};

const fetchToken = async () => {
  // как refreshToken() стока: token = параметр (32 символа) + сам токен
  try {
    const { res, text } = await request('GET', 'api/webserver/token');
    const d = handle('api/webserver/token', res, text);
    if (d && d.token) { tokens.push(String(d.token).substr(32)); return; }
  } catch (e) { /* ниже запасной путь */ }
  const { res, text } = await request('GET', 'api/webserver/SesTokInfo');
  const d = handle('api/webserver/SesTokInfo', res, text);
  if (d && d.TokInfo) tokens.push(String(d.TokInfo));
};

const RESET_TOKENS_ON = /api\/user\/(challenge_login|authentication_login|password_scram|login)$/;

let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

const api = {
  tokens,
  async get(path, opts) {
    opts = opts || {};
    const { res, text } = await request('GET', path, undefined, opts.headers, opts.timeout);
    if (text && text.indexOf('<code>125001</code>') >= 0 && !opts._retry) {
      await fetchToken();
      return api.get(path, Object.assign({}, opts, { _retry: 1 }));
    }
    return handle(path, res, text, opts.errors);
  },
  // obj — объект (будет <request>…</request>) или готовая строка XML.
  // opts.encrypt — массив полей с секретами (или true): тело шифруется RSA целиком, как enc:true у стока,
  // если роутер это включил (module-switch encrypt_enabled=1).
  post(path, obj, opts) {
    opts = opts || {};
    return serial(async () => {
      let body = typeof obj === 'string' ? obj : M.xml.build(obj === undefined ? {} : obj, 'request');
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
      const wantEnc = opts.encrypt === true || (Array.isArray(opts.encrypt) && opts.encrypt.length) || opts.enc;
      if (wantEnc && M.state.features.encrypt_enabled === '1') {
        const key = await api.publicKey();
        body = M.crypto.rsaEncryptBody(key.n, key.e, body);
        headers['Content-Type'] += ';enc';
      } else if (opts.enp && M.state.features.encrypt_enabled === '1') {
        // поля по отдельности, как enp у стока (пароль Wi-Fi): значение = RSA(текст с экранированием XML)
        if (Array.isArray(opts.enp) && typeof obj === 'object') {
          const key = await api.publicKey();
          const encObj = (o) => {
            if (Array.isArray(o)) return o.map(encObj);
            if (!o || typeof o !== 'object') return o;
            const r = {};
            Object.keys(o).forEach((k) => {
              const v = o[k];
              if (opts.enp.indexOf(k) >= 0 && v !== undefined && v !== null && typeof v !== 'object') {
                r[k] = M.crypto.rsaEncryptBody(key.n, key.e, M.esc(v));
              } else r[k] = encObj(v);
            });
            return r;
          };
          body = M.xml.build(encObj(obj), 'request');
        }
        headers['Content-Type'] += ';enp';
      }
      for (let attempt = 0; ; attempt++) {
        if (!tokens.length) await fetchToken();
        headers.__RequestVerificationToken = tokens.shift() || '';
        const { res, text } = await request('POST', path, body, headers, opts.timeout);
        if (RESET_TOKENS_ON.test(path)) tokens.length = 0;
        takeHeaderTokens(res);
        // неверный токен: сток повторяет запрос с новым токеном. 125003 на своих вызовах — тоже неверный токен
        // (API.md); если сессии нет, повтор снова даст ошибку, и ее разберет session-lost
        if (attempt < 1 && text && /<code>12500[13]<\/code>/.test(text)) { tokens.length = 0; await fetchToken(); continue; }
        const data = handle(path, res, text, opts.errors);
        M.emit('activity');
        return data;
      }
    });
  },
  // true, если ответ «OK»
  ok: (d) => typeof d === 'string' && d.trim().toUpperCase() === 'OK',
  // Открытый ключ RSA: после входа — из ответа входа, иначе api/webserver/publickey
  _key: null,
  async publicKey() {
    if (api._key && api._key.n) return api._key;
    const d = await api.get('api/webserver/publickey');
    api._key = { n: d.encpubkeyn, e: d.encpubkeye };
    return api._key;
  },
  readMetaTokens,
  fetchToken,
  // Секреты, которые сток отдает только шифрованными (пароль Wi-Fi): POST api/user/pwd {module, nonce},
  // ответ — XML в AES-CBC. Возвращает объект как M.api.get.
  async secrets(module) {
    const C = M.crypto;
    const nonce = C.scram.nonce();
    const salt = C.scram.nonce();
    const key = await api.publicKey();
    const d = await api.post('api/user/pwd', { module: module || 'wlan', nonce: C.rsaEncryptBody(key.n, key.e, nonce + salt) });
    const salted = C.hex(C.pbkdf2(nonce, C.unhex(salt), M.int(d.iter, 100), 32));
    const sig = C.hex(C.hmac256(C.unhex(salted.substring(48, 64)), C.unhex(d.pwd)));
    if (sig !== d.hash) throw new ApiError('sig', 'Ответ роутера с паролем не прошел проверку.');
    const plain = new TextDecoder().decode(C.aesCbcDecrypt(C.unhex(d.pwd), C.unhex(salted.substring(0, 32)), C.unhex(salted.substring(32, 48))));
    const r = M.xml.parse(plain.substring(plain.indexOf('<response>')));
    if (r.type !== 'response') throw new ApiError('parse');
    return r.data;
  },
};
M.api = api;

// Свои функции. Веб роутера пускает только пути из подписанного списка
// (WebApp/common/webauth/restfulconfig_common.xml), поэтому все свои вызовы идут одним POST
// на незанятый путь из этого списка: api/vsim/config-vsim (виртуальной SIM на 23c нет).
// M.mod('cell') — состояние (action=show); M.mod('cell', 'lock', {pci: 1}) — действие.
M.MOD_PATH = 'api/vsim/config-vsim';
M.mod = (name, action, args, opts) => {
  const body = Object.assign({ module: name, action: action === undefined ? 'show' : action }, args || {});
  return api.post(M.MOD_PATH, body, opts);
};

readMetaTokens();
