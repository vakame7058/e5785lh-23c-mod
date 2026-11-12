// Система: сведения об устройстве, перезагрузка, сброс, резервная копия, пароль, время, журналы, прошивка.
// Стоковые вызовы как в offweb (deviceinformation.js, reboot.js, restore.js, configuration.js,
// modifypassword.js, timesettings.js, systemlog.js): api/device/information, api/device/control,
// api/user/password_scram (тело шифруется RSA, как enc:true у стока), api/sntp/timeinfo, api/sntp/sntpswitch,
// api/log/loginfo. Мода (docs/API.md): M.mod('sysinfo'), M.mod('logs').

const CTRL_REBOOT = 1;
const CTRL_RESET = 2;
const CTRL_BACKUP = 3;        // после ответа OK копия лежит по адресу /nvram.bak
const CTRL_OFF = 4;           // выключение 

const kb = (n) => M.fmt.bytes(M.int(n) * 1024);
const BAT_STATUS = { Charging: 'заряжается', Discharging: 'разряжается', Full: 'заряжена', 'Not charging': 'не заряжается' };

// Ждем, пока роутер снова ответит, и перезагружаем страницу
const waitBack = async (ui, text) => {
  const box = ui.el('div', null, ui.spinner(text), ui.el('p', { class: 'hint' }, 'Страница обновится сама, когда роутер ответит.'));
  ui.modal('Подождите', box, [], { sticky: true });
  await M.sleep(25000);
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('/api/webserver/SesTokInfo', { cache: 'no-store' });
      if (r.ok) { location.reload(); return; }
    } catch (e) { /* роутер еще не поднялся */ }
    await M.sleep(3000);
  }
  ui.clear(box);
  box.appendChild(ui.notice('Роутер не ответил за 3 минуты. Проверьте подключение к его Wi-Fi и обновите страницу.', 'warn'));
};

M.page({
  id: 'system',
  title: 'Система',
  group: 'Система',
  icon: 'device',
  order: 510,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;

    // --- сведения ---
    const devKv = ui.kv([]);
    const sysKv = ui.kv([]);
    const diskBox = el('div');
    const devCard = ui.card({ title: 'Устройство', icon: 'router' }, devKv);
    const sysCard = ui.card({ title: 'Состояние', icon: 'chart' }, sysKv, diskBox);

    const loadDev = async () => {
      try {
        const d = await ctx.api.get('api/device/information');
        devKv.update([
          ['Модель', d.DeviceName],
          ['Версия прошивки', d.SoftwareVersion],
          ['Версия оборудования', d.HardwareVersion],
          ['Версия стокового веб-интерфейса', d.WebUIVersion],
          ['Серийный номер', d.SerialNumber],
          ['IMEI', d.Imei],
          ['IMSI', d.Imsi],
          ['ICCID SIM-карты', d.Iccid],
          d.Msisdn ? ['Номер телефона', d.Msisdn] : null,
          ['MAC-адрес Wi-Fi', d.MacAddress1 ? M.fmt.mac(d.MacAddress1) : ''],
          ['Адрес в сети оператора', d.WanIPAddress],
          d.WanIPv6Address ? ['IPv6 в сети оператора', d.WanIPv6Address] : null,
        ]);
      } catch (e) {
        ui.clear(devKv);
        devKv.appendChild(ui.notice('Не удалось получить сведения об устройстве. ' + e.message, 'err'));
      }
    };

    const loadSys = async () => {
      let d;
      try {
        d = await ctx.mod('sysinfo');
      } catch (e) {
        ui.clear(sysKv);
        sysKv.appendChild(ui.notice(e.code === '9001' ? 'Помощник мода на роутере не отвечает: подробное состояние недоступно.'
          : 'Не удалось получить состояние. ' + e.message, 'warn'));
        return;
      }
      const bat = String(d.bat_present) === '0' ? 'нет'
        : d.bat_percent !== undefined && d.bat_percent !== ''
          ? M.int(d.bat_percent) + '%' + (BAT_STATUS[d.bat_status] ? ', ' + BAT_STATUS[d.bat_status] : '') +
            (d.bat_voltage_mv ? ', ' + M.fmt.num(M.int(d.bat_voltage_mv) / 1000, 2) + ' В' : '') +
            (d.bat_temp_c !== undefined && d.bat_temp_c !== '' ? ', ' + M.int(d.bat_temp_c) + ' °C' : '')
          : '';
      sysKv.update([
        ['Работает без перезагрузки', M.fmt.duration(d.uptime_s)],
        ['Загрузка', [d.load1, d.load5, d.load15].filter((x) => x !== undefined).join(' · '),
          'Высокая загрузка (около 20) у этого роутера — норма: так считаются ожидающие задачи модема.'],
        ['Процессор', d.cpu_mhz ? M.int(d.cpu_mhz) + ' МГц' + (d.cpu_max_mhz ? ' из ' + M.int(d.cpu_max_mhz) : '') : ''],
        ['Память', d.mem_total_kb ? 'занято ' + kb(d.mem_used_kb) + ' из ' + kb(d.mem_total_kb) : '',
          d.mem_cached_kb ? 'Еще ' + kb(d.mem_cached_kb) + ' занимает кэш: система освобождает его по требованию.' : ''],
        ['Батарея', bat],
        ['Ядро Linux', d.kernel],
        ['Прошивка', d.fw_version],
        d.mod_version ? ['Мод', d.mod_version] : null,
        d.helper_version ? ['Помощник мода', d.helper_version] : null,
        ['Этот веб-интерфейс', M.version],
      ]);
      const disks = M.arr(d.disks && d.disks.disk).filter((x) => x && typeof x === 'object');
      ui.clear(diskBox);
      disks.forEach((k) => {
        const total = M.int(k.total_kb);
        const used = M.int(k.used_kb);
        diskBox.appendChild(ui.meter(total ? (used / total) * 100 : 0, 0, 100, k.mount + ' — занято ' + kb(used) + ' из ' + kb(total),
          { fmt: (v) => Math.round(v) + '%', good: 0, bad: 90 }));
      });
    };

    // --- питание и сброс ---
    const control = async (code) => ctx.api.post('api/device/control', { Control: code });
    // действия карточки — в заголовке справа; опасные — вторичные (красный текст), красная заливка только в подтверждении
    // каждое действие — своей строкой: название и пояснение слева, компактная кнопка справа
    const powerCard = ui.card({ title: 'Перезагрузка и сброс', icon: 'power' }, el('div', null,
      ui.actionRow('Перезагрузка', 'Занимает около минуты. Связь с устройствами на это время пропадет.',
        ui.btn('Перезагрузить', async () => {
          if (!(await ui.confirm('Перезагрузить роутер? Интернет пропадет примерно на минуту.', { ok: 'Перезагрузить' }))) return;
          await control(CTRL_REBOOT);
          waitBack(ui, 'Роутер перезагружается…');
        }, '', { icon: 'refresh' })),
      ui.actionRow('Сброс настроек', 'Возвращает настройки прошивки к заводским: Wi-Fi, пароль веб-интерфейса, точки доступа, ' +
        'брандмауэр. Мод и этот веб-интерфейс остаются.',
        ui.btn('Сбросить', async () => {
          if (!(await ui.confirm('Сбросить все настройки роутера к заводским? Сбросятся Wi-Fi, пароль веб-интерфейса, ' +
            'точки доступа, правила брандмауэра. Сохраните резервную копию заранее.', { danger: true, ok: 'Продолжить', title: 'Сброс настроек' }))) return;
          if (!(await ui.confirm('Точно сбросить? После сброса имя и пароль Wi-Fi станут заводскими, ' +
            'и к роутеру придется подключиться заново.', { danger: true, ok: 'Сбросить', title: 'Последнее подтверждение' }))) return;
          await control(CTRL_RESET);
          waitBack(ui, 'Роутер сбрасывает настройки и перезагружается…');
        }, 'danger', { icon: 'alert' })),
      ui.actionRow('Выключение', 'Включить роутер снова можно только кнопкой питания на корпусе.',
        ui.btn('Выключить', async () => {
          if (!(await ui.confirm('Выключить роутер? Включить его снова можно только кнопкой питания на корпусе.',
            { danger: true, ok: 'Выключить' }))) return;
          await control(CTRL_OFF);
          ui.modal('Роутер выключается', ui.el('p', null, 'Связь с роутером сейчас пропадет. Включите его кнопкой питания.'), []);
        }, '', { icon: 'power' }))));

    // --- резервная копия ---
    const backupCard = ui.card({ title: 'Резервная копия настроек', icon: 'download', actions: [
        ui.btn('Скачать копию', async () => {
          await control(CTRL_BACKUP);
          const a = el('a', { href: '/nvram.bak', download: 'e5785-nvram.bak' });
          document.body.appendChild(a);
          a.click();
          a.remove();
        }, '', { icon: 'download' }),
        el('a', { href: '/html/configuration.html', target: '_blank', rel: 'noopener', class: 'btn btn-ghost' }, 'Восстановить из файла')] },
      el('p', { class: 'muted' }, 'Файл с настройками роутера: Wi-Fi, сеть, брандмауэр. ' +
        'Пригодится после сброса. В файле есть пароли — храните его в надежном месте.'),
      el('small', { class: 'hint' }, 'Восстановление открывается в стоковом интерфейсе. После него роутер перезагрузится.'));

    // --- пароль ---
    const pwForm = ui.form([
      { name: 'cur', label: 'Текущий пароль', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'p1', label: 'Новый пароль', type: 'password', required: true,
        hint: 'Не короче 8 символов: латинские буквы, цифры, знаки. Без пробела в начале.',
        validate: (v, all) => {
          if (v.length < 8) return 'Не короче 8 символов.';
          if (/^[ \t]/.test(v)) return 'Пароль не может начинаться с пробела.';
          if (!/^[\x20-\x7e]+$/.test(v)) return 'Можно только латинские буквы, цифры и знаки.';
          if (v === all.cur) return 'Новый пароль совпадает с текущим.';
          return '';
        } },
      { name: 'p2', label: 'Новый пароль еще раз', type: 'password', required: true,
        validate: (v, all) => (v !== all.p1 ? 'Пароли не совпадают.' : '') },
    ], async (v) => {
      try {
        await ctx.api.post('api/user/password_scram',
          { username: M.state.user || 'admin', currentpassword: v.cur, newpassword: v.p1 },
          { encrypt: ['currentpassword', 'newpassword'] });
      } catch (e) {
        if (e.code === '108002') throw new Error('Текущий пароль неверный.');
        if (e.code === '125002') throw new Error('Три неверных попытки: роутер завершил сеанс. Войдите снова.');
        throw e;
      }
      ui.toast('Пароль изменен. Войдите с новым паролем.', 'ok');
      setTimeout(async () => {
        if (M.auth) { await M.auth.logout(true); M.go('login'); } else location.reload();
      }, 1500);
    }, { submit: 'Сменить пароль', silent: true });
    const pwCard = ui.card({ title: 'Пароль веб-интерфейса', icon: 'lock' }, pwForm,
      el('small', { class: 'hint' }, 'После смены пароля все, кто вошел в интерфейс, выйдут из него.'));

    // --- время ---
    const timeBox = el('div', null, ui.spinner());
    const timeCard = ui.card({ title: 'Время', icon: 'clock' }, timeBox);
    const loadTime = async () => {
      ui.clear(timeBox);
      let info = null;
      try { info = await ctx.api.get('api/sntp/timeinfo'); } catch (e) { info = null; }
      let sw = null;
      try { sw = await ctx.api.get('api/sntp/sntpswitch'); } catch (e) { sw = null; }
      if (!info && !sw) {
        timeBox.appendChild(el('p', { class: 'muted' }, 'Роутер берет время из сети оператора. ' +
          'Настройки времени в этой прошивке скрыты.'));
        timeBox.appendChild(ui.kv([['Время на этом компьютере', new Date().toLocaleString('ru-RU')]]));
        return;
      }
      if (info) {
        timeBox.appendChild(ui.kv([
          ['Время роутера', info.currentlocaltime],
          ['Часовой пояс', info.localtimezonename || info.currenttimezone],
          ['Синхронизация', /synchron/i.test(String(info.syncstatus)) && !/un/i.test(String(info.syncstatus)) ? 'выполнена' : String(info.syncstatus || '')],
          ['Серверы времени', [info.firstserver, info.secondserver].filter((x) => x && x !== 'None').join(', ')],
        ]));
      }
      if (sw) {
        timeBox.appendChild(ui.toggle('Сверять время с серверами в интернете (SNTP)', String(sw.SntpSwitch) === '1', async (v) => {
          await ctx.api.post('api/sntp/sntpswitch', { SntpSwitch: v ? 1 : 0 });
          ui.toast('Сохранено', 'ok');
        }));
      }
    };

    // --- журналы ---
    const logOut = ui.pre('');
    logOut.hidden = true;
    const logForm = ui.form([
      { name: 'id', label: 'Журнал', type: 'select', options: [['stock', 'Системный журнал прошивки']] },
      { name: 'lines', label: 'Строк', type: 'select', value: '200',
        options: [['100', '100'], ['200', '200'], ['500', '500'], ['2000', '2000']], show: (v) => v.id !== 'stock' },
    ], async (v) => {
      logOut.hidden = false;
      logOut.set('Загрузка…');
      let text = '';
      if (v.id === 'stock') {
        const d = await ctx.api.get('api/log/loginfo');
        text = String((d && d.LogContent) || '');
      } else {
        const d = await ctx.mod('logs', 'get', { id: v.id, lines: v.lines });
        text = String((d && d.output) || '');
      }
      logOut.set(text.replace(/\s+$/, '') || '(журнал пуст)');
      return false;
    }, {
      submit: 'Показать',
      actions: ui.btn('Скачать', () => {
        if (logOut.hidden || !logOut.textContent) { ui.toast('Сначала нажмите «Показать».', 'warn'); return; }
        const blob = new Blob([logOut.textContent + '\n'], { type: 'text/plain;charset=utf-8' });
        const a = el('a', { href: URL.createObjectURL(blob), download: 'e5785-' + logForm.values().id + '.log' });
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      }, 'ghost', { icon: 'download' }),
    });
    const logCard = ui.card({ title: 'Журналы', icon: 'list' }, logForm, logOut);
    const loadLogs = async () => {
      try {
        const d = await ctx.mod('logs');
        const list = M.arr(d && d.logs && d.logs.log).filter((x) => x && typeof x === 'object');
        logForm.setOptions('id', [['stock', 'Системный журнал прошивки']].concat(list.map((l) => [l.id, l.title || l.id])), 'stock');
      } catch (e) { /* остается только журнал прошивки */ }
    };

    // --- прошивка ---
    const fwCard = ui.card({ title: 'Обновление прошивки', icon: 'upload' },
      ui.notice('Обновление прошивки удалит мод и этот веб-интерфейс. Неподходящая прошивка может сделать роутер ' +
        'неработоспособным: восстановление — только разборкой и аварийной прошивкой. ' +
        'Подходят только прошивки для E5785Lh-23c (пакеты «E5785Lh-92a-23c»).', 'err'),
      el('a', { href: '/html/update.html', target: '_blank', rel: 'noopener', class: 'btn btn-danger' }, 'Открыть стоковую страницу обновления'));

    // --- опасные настройки: флаги помощника (docs/API.md, helper set {modem_write}/{nv_write}) ---
    const dangerBox = el('div', { class: 'stack' }, ui.spinner());
    const dangerCard = ui.card({ title: 'Опасные настройки', icon: 'alert' }, dangerBox);
    dangerCard.id = 'danger';
    const FLAGS = [
      { key: 'modem_write', label: 'Разрешить менять режим модема командами AT',
        hint: 'Запасная смена режима сети и AT-команды без «?» в консоли. Неверная команда может оставить роутер без связи до перезагрузки.',
        on: 'Разрешить командам AT менять режим модема? Неверная команда может оставить роутер без связи до перезагрузки. ' +
          'Опасные команды (смена IMEI, прошивка) заблокированы всегда.' },
      { key: 'nv_write', label: 'Разрешить запись в память модема (NV)',
        hint: 'Привязка к соте и режим без батареи. NV — постоянная память модема: ошибка в ней может лишить роутер связи даже после перезагрузки. IMEI не меняется в любом случае.',
        on: 'Разрешить запись в постоянную память модема (NV)? Ошибка в NV может лишить роутер связи даже после перезагрузки, ' +
          'исправлять придется вручную. IMEI все равно не меняется.' },
    ];
    const loadDanger = async () => {
      let h;
      try { h = await ctx.mod('helper'); } catch (e) {
        ui.clear(dangerBox).appendChild(ui.notice('Помощник мода не отвечает: флаги недоступны. ' + e.message, 'err'));
        return;
      }
      ui.clear(dangerBox);
      dangerBox.appendChild(el('p', { class: 'muted' }, 'Обычно выключено. Включайте на время нужного действия и выключайте после.'));
      FLAGS.forEach((fl) => {
        dangerBox.appendChild(ui.toggle(fl.label, String(h[fl.key]) === '1', async (v) => {
          if (v && !(await ui.confirm(fl.on, { title: 'Опасная настройка', ok: 'Разрешить', danger: true }))) return false;
          const r = await ctx.mod('helper', 'set', { [fl.key]: v ? 1 : 0 }, { errors: { 9003: 'Помощник не принял значение.' } });
          if (r && typeof r === 'object' && r[fl.key] !== undefined && String(r[fl.key]) !== (v ? '1' : '0')) throw new Error('Помощник не применил настройку.');
          ui.toast(v ? 'Разрешено' : 'Запрещено', 'ok');
        }, { hint: fl.hint }));
      });
    };

    root.appendChild(ui.grid(devCard, sysCard, powerCard, backupCard, pwCard, timeCard, logCard, dangerCard, fwCard));
    loadDanger().then(() => {
      if (ctx.params.focus === 'danger') { dangerCard.scrollIntoView({ block: 'center' }); dangerCard.classList.add('flash'); }
    });

    await Promise.all([loadDev(), loadTime(), loadLogs()]);
    ui.poll(loadSys, 10000);
  },
});
