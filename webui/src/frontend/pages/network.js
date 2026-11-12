// Мобильная сеть: данные и роуминг, режим сети и диапазоны, выбор оператора, точки доступа (APN)
const { el } = M.ui;

const MODES = [
  ['00', 'Авто (4G, 3G, 2G)'], ['03', 'Только 4G'], ['0302', '4G и 3G'], ['02', 'Только 3G'], ['0201', '3G и 2G'], ['01', 'Только 2G'],
];
// Диапазоны E5785Lh-23c: биты маски LTEBand (B1 = бит 0 … B38 = бит 37)
const LTE_BANDS = [
  [1, '2100'], [3, '1800'], [7, '2600'], [8, '900'], [20, '800'], [28, '700'], [32, '1500'], [38, '2600 TDD'],
];
const LTE_ALL = '7FFFFFFFFFFFFFFF';
// GSM и UMTS: маски NetworkBand как в стоке и модах
const GU_BANDS = [
  ['GSM 900', '300'], ['GSM 1800', '80'], ['GSM 850', '80000'], ['GSM 1900', '200000'],
  ['UMTS B1 (2100)', '400000'], ['UMTS B8 (900)', '2000000000000'],
];
const GU_ALL = '3FFFFFFF';
const RAT = { 0: '2G', 2: '3G', 7: '4G' };
const PLMN_STATE = { 0: ['неизвестно', 'muted'], 1: ['доступна', 'info'], 2: ['текущая', 'ok'], 3: ['запрещена', 'err'] };
const AUTH = [['0', 'Авто'], ['1', 'PAP'], ['2', 'CHAP']];
const IPTYPE = [['0', 'IPv4'], ['1', 'IPv6'], ['2', 'IPv4 и IPv6']];

const big = (h) => { try { return BigInt('0x' + (String(h || '0').replace(/^0x/i, '') || '0')); } catch (e) { return BigInt(0); } };
const hexU = (b) => b.toString(16).toUpperCase();

// Группа флажков диапазонов с флажком «Все»
const bandGroup = (title, items, maskHex, allHex) => {
  const all = big(allHex);
  const mask = big(maskHex);
  const itemMask = items.reduce((a, it) => a | it.bit, BigInt(0));
  const isAll = mask === all || (mask & itemMask) === itemMask;
  const allBox = el('input', { type: 'checkbox', checked: isAll });
  const boxes = items.map((it) => el('input', { type: 'checkbox', checked: isAll || (mask & it.bit) !== BigInt(0), disabled: isAll }));
  allBox.addEventListener('change', () => boxes.forEach((b) => { b.disabled = allBox.checked; b.checked = true; }));
  const node = el('fieldset', { class: 'bands' },
    el('legend', null, title),
    el('label', { class: 'chk chk-all' }, allBox, el('span', null, 'Все')),
    el('div', { class: 'bands-l' }, items.map((it, i) => el('label', { class: 'chk' }, boxes[i], el('span', null, it.label)))));
  node.value = () => {
    if (allBox.checked) return allHex;
    const m = items.reduce((a, it, i) => (boxes[i].checked ? a | it.bit : a), BigInt(0));
    return m === BigInt(0) ? '' : hexU(m);
  };
  node.summary = () => (allBox.checked ? 'все' : items.filter((it, i) => boxes[i].checked).map((it) => it.short || it.label).join(', ') || 'нет');
  return node;
};

M.page({
  id: 'network', title: 'Мобильная сеть', group: 'Сеть', icon: 'network', order: 10,
  async render(box, ctx) {
    const ui = ctx.ui;
    const api = ctx.api;
    const [dataSw, conn, mode, reg, plmn0] = await Promise.all([
      api.get('api/dialup/mobile-dataswitch').catch(() => null),
      api.get('api/dialup/connection').catch(() => null),
      api.get('api/net/net-mode').catch((e) => ({ _err: e })),
      api.get('api/net/register').catch(() => null),
      api.get('api/net/current-plmn').catch(() => null),
    ]);
    // имя сети: своим запросом current-plmn (опрос шапки мог еще не прийти), FullName → ShortName → Spn → Numeric
    let plmn = plmn0 || M.state.plmn || {};
    const netName = () => plmn.FullName || plmn.ShortName || plmn.Spn || (plmn.Numeric ? 'код ' + plmn.Numeric : '') || '—';

    // --- подключение ---
    const connCard = ui.card({ title: 'Подключение', icon: 'globe' },
      dataSw ? ui.toggle('Мобильные данные', dataSw.dataswitch === '1', async (v) => {
        if (!v && !(await ui.confirm('Выключить мобильные данные? Интернет через роутер пропадет.', { ok: 'Выключить', danger: true }))) return false;
        await api.post('api/dialup/mobile-dataswitch', { dataswitch: v ? 1 : 0 });
      }, { hint: 'Передача данных через сотовую сеть' }) : ui.notice('Переключатель данных недоступен.', 'warn'),
      conn ? ui.toggle('Данные в роуминге', conn.RoamAutoConnectEnable === '1', async (v) => {
        if (v && !(await ui.confirm('Разрешить передачу данных в роуминге? Оператор может брать за это отдельную плату.', { ok: 'Разрешить' }))) return false;
        await api.post('api/dialup/connection', Object.assign({}, conn, { RoamAutoConnectEnable: v ? 1 : 0 }));
        conn.RoamAutoConnectEnable = v ? '1' : '0';
      }, { hint: 'Подключаться к интернету в чужой сети' }) : null,
      conn ? ui.kv([['MTU', conn.MTU], ['Отключать при простое', conn.MaxIdelTime && conn.MaxIdelTime !== '0' && conn.ConnectMode === '1' ? M.fmt.duration(conn.MaxIdelTime) : 'нет']]) : null);

    // --- режим и диапазоны ---
    let modeCard;
    if (mode._err) {
      modeCard = ui.card({ title: 'Режим сети', icon: 'antenna' }, ui.notice('Не удалось прочитать режим: ' + mode._err.message, 'err'));
    } else {
      const sel = el('select', { class: 'inp', id: 'net-mode' }, MODES.map((m) => el('option', { value: m[0] }, m[1])));
      if (!MODES.some((m) => m[0] === mode.NetworkMode)) sel.appendChild(el('option', { value: mode.NetworkMode }, 'Другой (' + mode.NetworkMode + ')'));
      sel.value = mode.NetworkMode;
      const lte = bandGroup('Диапазоны 4G (LTE)',
        LTE_BANDS.map(([b, f]) => ({ bit: BigInt(1) << BigInt(b - 1), label: 'B' + b + ' · ' + f, short: 'B' + b })), mode.LTEBand, LTE_ALL);
      const gu = bandGroup('Диапазоны 2G и 3G', GU_BANDS.map(([l, h]) => ({ bit: big(h), label: l })), mode.NetworkBand, GU_ALL);
      const err = el('div', { class: 'form-err', hidden: true });
      const save = ui.btn('Применить', async () => {
        err.hidden = true;
        const lv = lte.value();
        const gv = gu.value();
        const m = sel.value;
        if (m !== '01' && m !== '02' && m !== '0201' && !lv) { err.textContent = 'Выберите хотя бы один диапазон 4G или «Все».'; err.hidden = false; return; }
        if (m !== '03' && !gv) { err.textContent = 'Выберите хотя бы один диапазон 2G/3G или «Все».'; err.hidden = false; return; }
        const text = 'Режим: ' + (MODES.find((x) => x[0] === m) || [m, m])[1] + '\nДиапазоны 4G: ' + lte.summary() + '\nДиапазоны 2G и 3G: ' + gu.summary() +
          '\n\nМодем переподключится к сети, связь пропадет на время переподключения. Если выбрать диапазоны, которых нет у оператора рядом, связи не будет.';
        if (!(await ui.confirm(text, { title: 'Применить настройки сети?', ok: 'Применить', danger: true }))) return;
        await api.post('api/net/net-mode', { NetworkMode: m, NetworkBand: gv || GU_ALL, LTEBand: lv || LTE_ALL }, { timeout: 60000 });
        ui.toast('Настройки сети применены', 'ok');
      }, 'primary');
      modeCard = ui.card({ title: 'Режим сети и диапазоны', icon: 'antenna' },
        el('div', { class: 'f-row' }, el('label', { class: 'f-l', for: 'net-mode' }, 'Режим'), sel),
        lte, gu, err, el('div', { class: 'form-a' }, save),
        el('small', { class: 'hint' }, 'Сейчас: 4G ' + (mode.LTEBand === LTE_ALL ? 'все' : '0x' + mode.LTEBand) + ', 2G/3G ' + (mode.NetworkBand === GU_ALL ? 'все' : '0x' + mode.NetworkBand)));
    }

    // --- выбор оператора ---
    const regBox = el('div', { class: 'stack' });
    const listBox = el('div');
    const renderReg = (r) => {
      ui.clear(regBox);
      const manual = r && r.Mode === '1';
      regBox.appendChild(ui.kv([['Выбор сети', manual ? 'вручную' : 'автоматически'], ['Сеть', netName()]]));
      // действия карточки — в заголовке справа
      if (regCard) {
        regCard.setActions([
          manual ? ui.btn('Выбирать автоматически', async () => {
            await api.post('api/net/register', { Mode: 0, Plmn: '', Rat: '' }, { timeout: 150000 });
            ui.toast('Модем выбирает сеть сам', 'ok');
            regLast = await api.get('api/net/register').catch(() => ({ Mode: '0' }));
            renderReg(regLast);
          }, 'ghost') : null,
          ui.btn('Найти сети', search, 'ghost', { icon: 'search' }),
        ]);
      }
    };
    let regCard = null;
    async function search() {
      if (!(await ui.confirm('Поиск сетей занимает до 3 минут. Пока он идет, интернета через роутер не будет.', { ok: 'Искать' }))) return;
      ui.clear(listBox).appendChild(ui.spinner('Ищу сети, это до 3 минут…'));
      let r;
      try { r = await api.get('api/net/plmn-list', { timeout: 240000 }); } catch (e) {
        ui.clear(listBox).appendChild(ui.notice('Поиск не удался: ' + e.message, 'err'));
        return;
      }
      const nets = M.arr(r.Networks && r.Networks.Network);
      ui.clear(listBox).appendChild(ui.table([
        { key: 'FullName', title: 'Оператор', render: (n) => n.FullName || n.ShortName || n.Numeric },
        { key: 'Rat', title: 'Сеть', render: (n) => RAT[n.Rat] || n.Rat },
        { key: 'State', title: 'Состояние', render: (n) => { const s = PLMN_STATE[n.State] || [n.State, 'muted']; return ui.badge(s[0], s[1]); } },
        { key: '_', title: '', render: (n) => (n.State === '3' ? '' : ui.btn('Выбрать', async () => {
          if (!(await ui.confirm('Подключиться к сети ' + (n.FullName || n.Numeric) + ' (' + (RAT[n.Rat] || n.Rat) + ')? Модем перестанет выбирать сеть сам.', { ok: 'Подключиться' }))) return;
          await api.post('api/net/register', { Mode: 1, Plmn: n.Numeric, Rat: n.Rat }, { timeout: 150000 });
          ui.toast('Сеть выбрана', 'ok');
          regLast = { Mode: '1' };
          renderReg(regLast);
        }, '', { class: 'btn-sm' })) },
      ], nets, { empty: 'Сети не найдены' }));
    }
    renderReg(reg);
    let regLast = reg;
    ctx.onLeave(M.on('status', () => {
      const p = M.state.plmn;
      if (p && (p.FullName || p.ShortName || p.Numeric) && netName() !== (p.FullName || p.ShortName || p.Spn || 'код ' + p.Numeric)) { plmn = p; renderReg(regLast); }
    }));
    regCard = ui.card({ title: 'Оператор', icon: 'sim' }, regBox, ui.simNumber(ctx), listBox);
    renderReg(regLast);

    // --- APN ---
    const apnBox = el('div');
    const apnCard = ui.card({ title: 'Точки доступа (APN)', icon: 'link', actions: [ui.btn('Добавить', () => editApn(null), 'ghost', { icon: 'plus', class: 'btn-sm' })] }, apnBox);
    let profiles = [];
    let current = '';
    const loadApn = async () => {
      try {
        const r = await api.get('api/dialup/profiles');
        profiles = M.arr(r.Profiles && r.Profiles.Profile);
        current = r.CurrentProfile;
      } catch (e) {
        ui.clear(apnBox).appendChild(ui.notice('Не удалось прочитать профили: ' + e.message, 'err'));
        return;
      }
      ui.clear(apnBox).appendChild(ui.table([
        { key: 'Name', title: 'Имя', render: (p) => [p.Name, p.Index === current ? ' ' : '', p.Index === current ? ui.badge('используется', 'ok') : ''] },
        { key: 'ApnName', title: 'APN', render: (p) => p.ApnName || 'авто' },
        { key: '_', title: '', render: (p) => el('div', { class: 'row row-end' },
          p.Index !== current ? ui.btn('Выбрать', () => setDefault(p), '', { class: 'btn-sm', title: 'Использовать этот профиль' }) : null,
          p.ReadOnly === '0' ? ui.btn('', () => editApn(p), 'ghost', { icon: 'edit', title: 'Изменить', class: 'btn-sm' }) : null,
          p.ReadOnly === '0' ? ui.btn('', () => delApn(p), 'ghost', { icon: 'trash', title: 'Удалить', class: 'btn-sm' }) : null) },
      ], profiles, { empty: 'Профилей нет' }));
    };
    const setDefault = async (p) => {
      if (!(await ui.confirm('Использовать профиль «' + p.Name + '»? Мобильное подключение переподключится.', { ok: 'Использовать' }))) return;
      await api.post('api/dialup/profiles', { Delete: 0, SetDefault: p.Index, Modify: 0 }, { encrypt: true });
      ui.toast('Профиль выбран', 'ok');
      await loadApn();
    };
    const delApn = async (p) => {
      if (!(await ui.confirm('Удалить профиль «' + p.Name + '»?', { ok: 'Удалить', danger: true }))) return;
      let def = 0;
      if (p.Index === current) { const other = profiles.find((x) => x.Index !== p.Index); def = other ? other.Index : 0; }
      await api.post('api/dialup/profiles', { Delete: p.Index, SetDefault: def, Modify: 0 }, { encrypt: true });
      ui.toast('Профиль удален', 'ok');
      await loadApn();
    };
    const editApn = (p) => {
      const isNew = !p;
      const f = ui.form([
        { name: 'Name', label: 'Имя профиля', value: p ? p.Name : '', required: true, maxlength: 64 },
        { name: 'ApnName', label: 'APN', value: p ? p.ApnName : '', hint: 'Пусто — роутер возьмет APN от оператора', maxlength: 64 },
        { name: 'Username', label: 'Пользователь', value: p ? p.Username : '', maxlength: 64 },
        { name: 'Password', label: 'Пароль', type: 'password', value: '', hint: isNew ? '' : 'Пусто — не менять', maxlength: 64 },
        { name: 'AuthMode', label: 'Проверка', type: 'select', options: AUTH, value: p ? p.AuthMode : '0' },
        { name: 'iptype', label: 'Тип IP', type: 'select', options: IPTYPE, value: p && p.iptype !== undefined && p.iptype !== '' ? p.iptype : '2' },
      ], null, { submit: false });
      ui.modal(isNew ? 'Новый профиль' : 'Профиль «' + p.Name + '»', f, [
        { label: 'Отмена', value: false },
        { label: 'Сохранить', kind: 'primary', onClick: async () => {
          const v = f.values();
          if (!v.Name) { f.error('Укажите имя профиля.'); return false; }
          const prof = {
            Index: isNew ? '' : p.Index, IsValid: 1, Name: v.Name, ApnIsStatic: v.ApnName ? 1 : 0, ApnName: v.ApnName,
            DialupNum: p ? p.DialupNum || '*99#' : '*99#', Username: v.Username, Password: v.Password, AuthMode: v.AuthMode,
            IpIsStatic: p ? p.IpIsStatic || '' : '', IpAddress: p ? p.IpAddress || '' : '', DnsIsStatic: p ? p.DnsIsStatic || '' : '',
            PrimaryDns: p ? p.PrimaryDns || '' : '', SecondaryDns: p ? p.SecondaryDns || '' : '', ReadOnly: 0, iptype: v.iptype,
          };
          if (!isNew && !v.Password) delete prof.Password;
          await api.post('api/dialup/profiles', {
            Delete: 0, SetDefault: isNew ? (profiles.length ? 0 : 1) : p.Index, Modify: isNew ? 1 : 2, Profile: prof,
          }, { encrypt: true });
          ui.toast('Профиль сохранен', 'ok');
          await loadApn();
          return true;
        } },
      ]);
    };
    loadApn();

    // слева стопкой подключение, оператор и APN, справа режим сети и диапазоны (на телефоне — одна колонка)
    box.appendChild(ui.stacks([connCard, regCard, apnCard], [modeCard]));
  },
});
