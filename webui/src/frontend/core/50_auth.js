// Вход SCRAM, выход, состояние входа, автовыход по бездействию (как у стока: api/time/timeout, минуты).

const auth = {
  idleMs: 5 * 60000,
  _last: Date.now(),
  _timer: 0,

  // GET api/user/state-login → true/false
  async check() {
    const d = await M.api.get('api/user/state-login');
    M.state.loginInfo = d || {};
    M.state.oaep = !d || d.rsapadingtype === undefined || d.rsapadingtype === '1';
    const ok = d && String(d.State) === '0';
    M.state.loggedIn = !!ok;
    M.state.user = ok ? (d.Username || d.username || '') : '';
    return !!ok;
  },

  async login(username, password) {
    const S = M.crypto.scram;
    // как login() стока: сначала свежий токен
    M.api.tokens.length = 0;
    M.api.readMetaTokens();
    if (!M.api.tokens.length) await M.api.fetchToken();
    const first = S.nonce();
    const ch = await M.api.post('api/user/challenge_login', { username, firstnonce: first, mode: 1 });
    const salt = ch.salt;
    const iter = ch.iterations;
    const sn = ch.servernonce;
    if (!salt || !sn) throw new M.ApiError('parse');
    const authMsg = first + ',' + sn + ',' + sn;
    const p = S.proofs(password, salt, iter, authMsg);
    const req = { clientproof: p.clientProof, finalnonce: sn };
    if (String(ch.newType) === '1') {
      // роутер переводит пароль на новые соль и число итераций
      const nsp = S.salted(password, ch.newSalt, ch.newIterations);
      const H = M.crypto.hex;
      const newStoredKey = H(S.storedKey(S.clientKey(nsp)));
      const newServerKey = H(S.serverKey(nsp));
      req.hashOldNewPwd = M.crypto.sha256hex(newStoredKey + newServerKey + p.clientProof);
      req.newStoredKey = newStoredKey;
      req.newServerKey = newServerKey;
    }
    const fin = await M.api.post('api/user/authentication_login', req);
    const dev = window.M_DEV_MOCK && fin.serversignature === 'mock';
    if (!dev && fin.serversignature !== p.serverProof) {
      await auth.logout(true);
      throw new M.ApiError('sig', 'Роутер не подтвердил пароль: подпись ответа не совпала. Вход отменен.');
    }
    if (fin.rsan) {
      const sig = M.crypto.hex(S.signature(M.crypto.unhex(fin.rsan), M.crypto.unhex(p.serverKey)));
      if (dev || sig === fin.rsapubkeysignature) M.api._key = { n: fin.rsan, e: fin.rsae };
    }
    const ok = await auth.check();
    if (!ok) throw new M.ApiError('login', 'Роутер не открыл вход. Повторите попытку.');
    if (!M.state.user) M.state.user = username;
    auth.touch();
    await auth.loadTimeout();
    M.emit('login');
    return true;
  },

  async logout(quiet) {
    try { await M.api.post('api/user/logout', { Logout: 1 }); } catch (e) { if (!quiet) console.warn('logout:', e.message); }
    try { sessionStorage.clear(); } catch (e) { /* нет хранилища */ }
    M.state.loggedIn = false;
    M.state.user = '';
    M.api._key = null;
    M.emit('logout');
  },

  async loadTimeout() {
    try {
      const d = await M.api.get('api/time/timeout');
      const m = M.int(d.timeout, 5);
      auth.idleMs = Math.max(1, m) * 60000;
    } catch (e) { auth.idleMs = 5 * 60000; }
  },

  touch() { auth._last = Date.now(); },

  // Проверка бездействия раз в 15 с. M.keepAwake(true) — не выходить (режим наведения антенны).
  startIdle() {
    if (auth._timer) return;
    auth._timer = setInterval(async () => {
      if (!M.state.loggedIn || M._keepAwake || M.quiet) { auth.touch(); return; }
      if (Date.now() - auth._last > auth.idleMs) {
        await auth.logout(true);
        M.go('login', { reason: 'idle' });
      }
    }, 15000);
  },
};
M.auth = auth;
M._keepAwake = false;
M.keepAwake = (v) => { M._keepAwake = !!v; auth.touch(); };

['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => {
  window.addEventListener(ev, () => auth.touch(), { passive: true, capture: true });
});
M.on('activity', () => auth.touch());

// Сессия пропала (таймаут стока, вход с другого устройства) — мягко на экран входа
let lostBusy = false;
M.on('session-lost', async () => {
  if (lostBusy || !M.state.loggedIn) return;
  lostBusy = true;
  try {
    let still = false;
    try { still = await auth.check(); } catch (e) { still = false; }
    if (!still) {
      M.state.loggedIn = false;
      M.emit('logout');
      M.go('login', { reason: 'expired', next: M.currentHash && M.currentHash() });
    }
  } finally { lostBusy = false; }
});
