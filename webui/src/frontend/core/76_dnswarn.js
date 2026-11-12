// Предупреждение «VPN включен, а служба DNS выключена» (карточка VPN и «Сводка»).
// M.ui.dnsWarn(ctx) → {el, update({vpnUp, dnsTunnel})}. Через туннель DNS не подменяется: тогда предупреждения нет.
// Включает службу только по кнопке. Скрытие крестиком запоминается в браузере, пока служба снова не заработает.
const HIDE_KEY = 'mod.dnswarn.hidden';
const hidden = () => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch (e) { return false; } };
const setHidden = (v) => { try { if (v) localStorage.setItem(HIDE_KEY, '1'); else localStorage.removeItem(HIDE_KEY); } catch (e) { /* только на этот показ */ } };
M.ui.dnsWarnReset = () => setHidden(false);
// dns_enable ждет запуска службы до 100 с
M.ui.DNS_ENABLE_MS = 110000;
// Служба должна работать, но не запустилась (running=0, enabled=1, user_off=0): это не то же, что «выключил пользователь»
M.ui.dnsFailedText = (s) => {
  if (!s || String(s.running) === '1' || String(s.enabled) !== '1' || String(s.user_off) !== '0') return '';
  return 'DNS не запустился' + (s.last_error ? ': ' + s.last_error : '') + '. Устройства сейчас спрашивают DNS оператора';
};
// Куда идут запросы работающей службы: dns_upstream, dns_fallback; preset — строки нет
M.ui.dnsUpstreamLine = (s) => {
  const up = String((s && s.dns_upstream) || '');
  if (up === 'operator') return M.ui.el('div', { class: 'imp-warn', role: 'status' }, M.icon('alert', 18), M.ui.el('span', { class: 'imp-warn-t' }, 'DNS оператора: заблокированные сайты не откроются'));
  if (up === 'backup' || String(s && s.dns_fallback) === '1') return M.ui.el('div', { class: 'muted' }, 'DNS: работает запасной сервер');
  return null;
};

M.ui.dnsWarn = (ctx) => {
  const ui = M.ui;
  const el = ui.el;
  const box = el('div', { class: 'stack' });
  let vpn = { vpnUp: false, dnsTunnel: false };
  let dns = null;      // служба dns из svc show; null — пакета нет или ответа еще нет
  let hideNow = false; // крестик, если браузер не дал запомнить

  const draw = () => {
    ui.clear(box);
    if (!dns) return;
    if (String(dns.running) === '1') {
      setHidden(false);
      hideNow = false;
      if (!vpn.dnsTunnel) { const l = M.ui.dnsUpstreamLine(dns); if (l) box.appendChild(l); }
      return;
    }
    const failed = M.ui.dnsFailedText(dns);
    if (vpn.dnsTunnel || (!failed && !vpn.vpnUp)) return;
    // скрыть можно, только если службу выключил сам пользователь (user_off=1)
    const userOff = String(dns.user_off) === '1';
    if (userOff && (hideNow || hidden())) return;
    box.appendChild(el('div', { class: 'imp-warn', role: 'status' },
      M.icon('alert', 18),
      el('span', { class: 'imp-warn-t' }, failed || 'Заблокированные сайты не откроются: DNS оператора подменяет адреса'),
      ui.btn('Включить DNS', async () => {
        const r = await ctx.mod('svc', 'dns_enable', {}, { timeout: M.ui.DNS_ENABLE_MS });
        if (r && typeof r === 'object') Object.keys(r).forEach((k) => { if (k !== 'output') dns[k] = r[k]; });
        draw();
        if (String(dns.running) !== '1') throw new Error('Служба DNS не запустилась. Подробности — на странице «Службы».');
        ui.toast('Служба DNS включена', 'ok');
      }, '', { class: 'btn-sm' }),
      userOff ? ui.btn('', () => { hideNow = true; setHidden(true); draw(); }, 'ghost', { icon: 'close', title: 'Скрыть предупреждение', class: 'btn-sm' }) : null));
  };
  const load = async () => {
    try {
      const d = await ctx.mod('svc');
      dns = M.arr(d && d.services && d.services.service).find((x) => x && x.name === 'dns') || null;
    } catch (e) { dns = null; }   // предупреждение не важнее самой страницы
    draw();
  };
  let loaded = false;
  return {
    el: box,
    update: (v) => {
      const changed = v.vpnUp !== vpn.vpnUp;
      vpn = v;
      if (!loaded || changed) { loaded = true; load(); } else draw();
    },
  };
};
