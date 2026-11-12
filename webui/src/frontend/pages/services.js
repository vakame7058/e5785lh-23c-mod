// Службы: обход блокировок (tpws, zapret2), DNS (блокировка рекламы, шифрование DNS).
// Вызовы мода (docs/API.md): M.mod('svc') — список; M.mod('svc', start|stop|enable|disable|status, {name}).

// Пояснения к известным пакетам; для неизвестных — поле desc из ответа роутера.
const KNOWN = [
  {
    match: /^tpws/,
    title: 'Обход блокировок: tpws',
    about: 'Перехватывает соединения устройств с сайтами и слегка меняет начало запроса, ' +
      'чтобы фильтр оператора его не узнал. Работает для сайтов по HTTP и HTTPS.',
    warn: 'Некоторые сайты могут открываться медленнее или с ошибкой. Если так — остановите службу.',
  },
  {
    match: /^(zapret|nfqws)/,
    title: 'Обход блокировок: zapret2',
    about: 'Добавляет к соединению служебные пакеты, которые сбивают фильтр оператора. ' +
      'Помогает там, где не справляется tpws, в том числе для видео и звонков по UDP.',
    warn: 'Обычно хватает одного способа обхода: включайте tpws или zapret2, а не оба сразу. ' +
      'Если включено аппаратное ускорение (SPE), служба может не срабатывать — см. «Улучшения».',
  },
  {
    match: /^(dns|adblock|dnsmasq)/,
    title: 'DNS: блокировка рекламы',
    about: 'Роутер сам отвечает устройствам на запросы адресов сайтов и не дает адресов рекламных и следящих серверов. ' +
      'Работает на всех устройствах сети без настройки.',
    warn: 'Если какой-то сайт или приложение перестали работать, остановите службу и проверьте снова.',
  },
  {
    match: /^(dot|stubby|doh)/,
    title: 'DNS: шифрование запросов',
    about: 'Запросы адресов сайтов уходят к DNS-серверу в зашифрованном виде (DNS поверх TLS). ' +
      'Оператор не видит, какие сайты вы открываете, и не может подменить ответ.',
    warn: 'Без доступа к серверу DNS сайты перестанут открываться. Если так — остановите службу.',
  },
];
const known = (name) => KNOWN.find((k) => k.match.test(String(name || '').toLowerCase()));

// Свой DNS-сервер: те же правила, что в svc.sh пакета dns (valid_custom, do_set_custom)
const isIpv4 = (v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(v) && v.split('.').every((x) => Number(x) <= 255);
const customAddrError = (v) => {
  if (!v) return 'Введите адрес сервера.';
  if (isIpv4(v)) return '';
  const m = /^https:\/\/([A-Za-z0-9.-]+)(:\d{1,5})?(\/[A-Za-z0-9._-]+)*\/dns-query$/.exec(v) || /^tls:\/\/([A-Za-z0-9.-]+)(:\d{1,5})?$/.exec(v);
  if (!m) return 'Нужен адрес вида https://имя/dns-query, tls://имя или IPv4.';
  if (/^[0-9.]+$/.test(m[1])) return 'Для https:// и tls:// укажите имя сервера, а не адрес: по нему проверяется сертификат.';
  return '';
};

M.page({
  id: 'services',
  title: 'Службы',
  group: 'Улучшения',
  icon: 'globe',
  order: 420,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;
    const list = el('div', null, ui.spinner());

    const svcErr = (e) => {
      if (!e) return 'Ошибка.';
      if (e.code === '9001') return 'Помощник мода на роутере не отвечает.';
      if (e.code === '9007') return 'Нет подключения к интернету: служба не может работать без сети.';
      if (e.code === '9004') return 'Команда завершилась с ошибкой. Подробности — ниже.';
      return e.message;
    };

    // Выбор DNS-сервера и блокировка рекламы (пакет dns). Выбор не включает службу: запоминается и применится при включении.
    let operatorName = '';
    const dnsSettings = (s, presets, redraw, showOut) => {
      const running = String(s.running) === '1';
      const box = el('div', { class: 'stack' });
      // ответ действий — те же поля, что в show (docs/API.md, svc): второй запрос не нужен
      const dnsCall = async (action, args) => {
        let r;
        try { r = await ctx.mod('svc', action, args); } catch (e) {
          if (e.data && e.data.output) showOut(e.data.output);
          // отказ пакета — его текст как есть
          if (e.code === '9004') throw new Error((e.data && e.data.message) || e.message);
          if (e.code === '9003') throw new Error('Недопустимые символы в значении.');
          throw new Error(svcErr(e));
        }
        if (r && typeof r === 'object') Object.keys(r).forEach((k) => { if (k !== 'output') s[k] = r[k]; });
        return r;
      };
      const active = (presets.find((p) => String(p.active) === '1') || {}).id || s.preset || (presets[0] && presets[0].id);
      // custom_addr: у https:// путь может быть скрыт «…» (в нем бывает личный ключ): такой адрес только показывается,
      // для повторного сохранения его не подставить
      const savedAddr = String(s.custom_addr || '');
      const masked = savedAddr.includes('…');
      const after = (text) => ui.toast(running ? text : 'Запомнено. Заработает, когда служба будет включена.', 'ok');

      if (running) { const line = ui.dnsUpstreamLine(s); if (line) box.appendChild(line); }
      const failedText = ui.dnsFailedText(s);
      if (failedText) box.appendChild(ui.notice(failedText + '.', 'warn'));
      else if (!running) {
        box.appendChild(ui.notice('Сейчас устройства спрашивают DNS оператора. ' +
          (/tele2|теле2|^t2\b|^т2\b/i.test(operatorName) ? 'Tele2 подменяет часть адресов.' : 'Оператор может подменять часть адресов.') +
          ' Включите службу, чтобы работал выбранный сервер.', 'warn'));
      }
      const form = ui.form([{ name: 'preset', label: 'Сервер', type: 'select', value: active,
        options: presets.map((p) => [String(p.id), String(p.label || p.id) + (p.id === 'auto' ? ', рекомендуется' : '')]),
        hint: running ? '' : 'Выбор запомнится и применится при включении службы.' }], null, { submit: false });
      box.appendChild(form);
      const sel = form.field('preset');

      // свой сервер: адрес и предупреждение про IPv4
      const customBox = el('div', { class: 'stack', hidden: active !== 'custom' });
      const warn4 = el('div');
      const drawWarn = (v) => {
        ui.clear(warn4);
        if (isIpv4(String(v || '').trim())) warn4.appendChild(ui.notice('Этот адрес без шифрования: оператор может подменять ответы.', 'warn'));
      };
      const customForm = ui.form([{ name: 'addr', label: 'Адрес сервера', value: masked ? '' : savedAddr, placeholder: masked ? savedAddr : 'https://имя/dns-query', autocomplete: 'off',
        hint: (masked ? 'Адрес сохранен, часть пути скрыта. Чтобы сменить, введите новый полностью. ' : '') + 'https://имя/dns-query, tls://имя или IPv4.', validate: (v) => customAddrError(String(v || '').trim()) }], async (v) => {
        const addr = String(v.addr || '').trim();
        await dnsCall('dns_custom', { addr });
        await dnsCall('dns_preset', { id: 'custom' });
        after('Свой сервер сохранен');
        redraw();
        return false;
      }, { submit: 'Сохранить адрес' });
      customForm.field('addr').addEventListener('input', (ev) => drawWarn(ev.target.value));
      drawWarn(savedAddr);
      customBox.appendChild(customForm);
      customBox.appendChild(warn4);
      box.appendChild(customBox);

      sel.addEventListener('change', async () => {
        const id = sel.value;
        customBox.hidden = id !== 'custom';
        // без адреса свой сервер не выбрать: сначала адрес, выбор уйдет вместе с ним
        if (id === 'custom' && !savedAddr) { customForm.field('addr').focus(); return; }
        sel.disabled = true;
        try {
          await dnsCall('dns_preset', { id });
          after('Сервер выбран');
          redraw();
        } catch (e) {
          sel.value = active;
          customBox.hidden = active !== 'custom';
          sel.disabled = false;
          ui.toast(e.message, 'err');
        }
      });

      box.appendChild(el('small', { class: 'hint' }, 'Обычного DNS вроде 8.8.8.8 в списке нет: оператор перехватывает такие запросы. Поэтому здесь только шифрованные варианты.'));
      box.appendChild(ui.toggle('Блокировка рекламы', String(s.adblock) === '1', async (v) => {
        await dnsCall('dns_adblock', { on: v ? 1 : 0 });
        s.adblock = v ? '1' : '0';
        after(v ? 'Блокировка рекламы включена' : 'Блокировка рекламы выключена');
      }, { hint: 'Роутер не отдает устройствам адреса рекламных и следящих серверов.' }));
      return box;
    };

    const lastOut = {};   // вывод последней команды по имени службы: переживает перерисовку карточки
    // Карточка службы: в заголовке название, значок состояния и переключатель вкл/выкл (крутилка на время
    // запуска, откат при ошибке); технический id — только в подсказке; «Проверить» — в «…»
    const drawOne = (s) => {
      const k = known(s.name);
      const out = ui.pre('');
      out.hidden = true;
      const showOut = (text) => {
        lastOut[s.name] = String(text || '').trim() || 'Пусто';
        out.set(lastOut[s.name]);
        out.hidden = false;
      };
      if (lastOut[s.name]) { out.set(lastOut[s.name]); out.hidden = false; }
      const running = String(s.running) === '1';
      const enabled = String(s.enabled) === '1';
      // presets есть только у пакета dns, который умеет выбирать сервер
      const presets = M.arr(s.presets && s.presets.dns_preset).filter((x) => x && typeof x === 'object' && x.id);
      const title = presets.length ? 'DNS и блокировка рекламы' : (k && k.title) || s.desc || s.name;

      const call = async (action, args, opts) => {
        let r;
        try { r = await ctx.mod('svc', action, args || { name: s.name }, opts); } catch (e) {
          if (e.data && e.data.output) showOut(e.data.output);
          throw new Error(svcErr(e));
        }
        if (r && typeof r === 'object') {
          if (r.running !== undefined) s.running = r.running;
          if (r.enabled !== undefined) s.enabled = r.enabled;
          if (r.output) showOut(r.output);
        }
        return r;
      };
      const redraw = () => { card.replaceWith(drawOne(s)); };

      const sw = ui.headSwitch(running, async (v) => {
        if (v && k && /^Обход/.test(k.title) && !(await ui.confirm('Запустить «' + k.title + '»? ' +
          'Служба меняет обработку трафика всех устройств сети. ' + (k.warn || ''), { ok: 'Запустить' }))) return false;
        // DNS: включить — автозапуск и запуск, выключить — остановка и снятие автозапуска: одной остановки мало
        if (presets.length) {
          const r = await call(v ? 'dns_enable' : 'dns_disable', {}, { timeout: ui.DNS_ENABLE_MS });
          if (r && typeof r === 'object') Object.keys(r).forEach((key) => { if (key !== 'output') s[key] = r[key]; });
          if (v) ui.dnsWarnReset();
        } else await call(v ? 'start' : 'stop');
        if (v && String(s.running) !== '1') throw new Error('Служба не запустилась. Подробности — под описанием.');
        ui.toast(v ? 'Служба запущена' : 'Служба остановлена', 'ok');
        redraw();
      }, { label: running ? 'Остановить ' + title : 'Запустить ' + title, title: running ? 'Остановить' : 'Запустить' });
      const recheck = ui.btn('Проверить состояние', async () => { await call('status'); redraw(); }, 'ghost', { class: 'act-menu' });

      const box = el('div', { class: 'stack' });
      const about = presets.length ? 'Роутер сам отвечает устройствам на запросы адресов сайтов и узнает адреса у выбранного сервера. Работает на всех устройствах сети без настройки.'
        : (k && k.about) || (s.desc && s.desc !== title ? s.desc : '');
      if (about) box.appendChild(el('p', { class: 'muted' }, about));
      if (presets.length) box.appendChild(dnsSettings(s, presets, redraw, showOut));
      if (k && k.warn) box.appendChild(el('details', { class: 'more' }, el('summary', null, 'Подробнее'), el('p', { class: 'hint' }, k.warn)));
      box.appendChild(ui.toggle('Запускать при загрузке роутера', enabled, async (v) => {
        await call(v ? 'enable' : 'disable');
        ui.toast(v ? 'Служба будет запускаться при загрузке' : 'Автозапуск выключен', 'ok');
      }));
      box.appendChild(out);
      const card = ui.card({ title, icon: 'globe',
        actions: [running ? ui.badge('работает', 'ok') : ui.badge('остановлена', 'muted'), recheck, sw] }, box);
      const h2 = card.querySelector('.card-h h2');
      if (h2) h2.title = s.name;   // технический id — только в подсказке
      return card;
    };

    root.appendChild(ui.notice('Службы меняют обработку трафика всех устройств сети. ' +
      'Если после включения перестали открываться сайты — остановите службу, которую включили последней.', 'warn'));
    root.appendChild(list);

    try {
      const [d, plmn] = await Promise.all([ctx.mod('svc'), ctx.api.get('api/net/current-plmn').catch(() => null)]);
      operatorName = String((plmn && (plmn.FullName || plmn.ShortName)) || '');
      const items = M.arr(d && d.services && d.services.service).filter((x) => x && typeof x === 'object');
      ui.clear(list);
      if (!items.length) {
        list.appendChild(ui.empty('Службы не установлены. Их ставит установщик веб-интерфейса вместе с пакетами.'));
        return;
      }
      list.appendChild(ui.grid(items.map(drawOne)));
    } catch (e) {
      ui.clear(list);
      list.appendChild(ui.notice('Не удалось получить список служб. ' + svcErr(e), 'err'));
    }
  },
});
