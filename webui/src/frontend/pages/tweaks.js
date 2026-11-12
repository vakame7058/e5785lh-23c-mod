// Улучшения: исправление TTL, аппаратное ускорение SPE, режим сети, работа без батареи.
// Вызовы мода (docs/API.md): M.mod('helper'), M.mod('ttl'), M.mod('spe'), M.mod('radio'), M.mod('battery').

const MODES = [
  ['00', 'Авто (4G, 3G, 2G)'],
  ['03', 'Только 4G'],
  ['0302', '4G и 3G'],
  ['0301', '4G и 2G'],
  ['02', 'Только 3G'],
  ['0201', '3G и 2G'],
  ['01', 'Только 2G'],
];

const modErr = (e) => {
  if (!e) return 'Ошибка.';
  if (e.code === '9001') return 'Помощник мода на роутере не отвечает.';
  if (e.code === '9008') return 'Сейчас запрещено: помощник мода не разрешает менять настройки модема.';
  return e.message;
};

M.page({
  id: 'tweaks',
  title: 'Улучшения',
  group: 'Улучшения',
  icon: 'tools',
  order: 410,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;

    const top = el('div');
    root.appendChild(top);
    let helper = null;
    try {
      helper = await ctx.mod('helper');
    } catch (e) {
      top.appendChild(ui.notice('Помощник мода на роутере не отвечает: настройки на этой странице недоступны. ' +
        'Перезагрузите роутер; если не поможет — переустановите веб-интерфейс.', 'err'));
    }
    const modemWrite = helper && String(helper.modem_write) === '1';
    const nvWrite = helper && String(helper.nv_write) === '1';

    // каждая карточка грузится сама и не ломает соседние
    const block = (title, loader) => {
      const body = el('div', null, ui.spinner());
      const c = ui.card(title, body);
      c.reload = async () => {
        try {
          const nodes = await loader(c);
          ui.clear(body);
          ui.add(body, [nodes]);
        } catch (e) {
          ui.clear(body);
          body.appendChild(ui.notice('Не удалось загрузить. ' + modErr(e), 'err'));
        }
      };
      return c;
    };

    // --- TTL ---
    const ttl = block({ title: 'Исправление TTL', icon: 'shield' }, async (c) => {
      const d = await ctx.mod('ttl');
      const on = String(d.enabled) === '1';
      const active = String(d.active) === '1';
      return [
        el('p', { class: 'muted' }, 'Роутер выставляет TTL ' + (d.value || 64) + ' всем пакетам, уходящим к оператору. ' +
          'Так оператор не отличает раздачу интернета от телефона. Нужно на тарифах «только для смартфона», ' +
          'где за раздачу снижают скорость или берут плату.'),
        ui.toggle('Исправлять TTL', on, async (v) => {
          await ctx.mod('ttl', 'set', { enable: v ? 1 : 0 });
          ui.toast(v ? 'Исправление TTL включено' : 'Исправление TTL выключено', 'ok');
          c.reload();
        }),
        ui.kv([['Правила сейчас', active ? 'действуют' : 'не действуют',
          on && !active ? 'Правила не стоят, хотя исправление включено. Выключите и включите его снова.' : '']]),
      ];
    });

    // --- SPE ---
    const spe = block({ title: 'Аппаратное ускорение (SPE)', icon: 'chart' }, async (c) => {
      const d = await ctx.mod('spe');
      const enabled = String(d.disabled) !== '1';
      return [
        el('p', { class: 'muted' }, 'Ускорение пропускает часть пакетов мимо правил брандмауэра. ' +
          'Из-за этого могут не работать исправление TTL и обход блокировок. ' +
          'Если они не помогают — выключите ускорение. Скорость при этом может стать ниже.'),
        ui.toggle('Ускорение включено', enabled, async (v) => {
          await ctx.mod('spe', 'set', { disable: v ? 0 : 1 });
          ui.toast(v ? 'Ускорение включено' : 'Ускорение выключено', 'ok');
          c.reload();
        }),
      ];
    });

    // --- режим сети: меняется на «Мобильной сети» (стоковый API, без флагов помощника) ---
    const radio = ui.card({ title: 'Режим сети', icon: 'signal' },
      el('p', { class: 'muted' }, 'Режим сети (2G, 3G, 4G) и диапазоны меняются на странице «Мобильная сеть».'),
      el('a', { href: '#/network' }, 'Открыть «Мобильная сеть» → «Режим сети и диапазоны»'));
    radio.reload = async () => {};

    // --- без батареи ---
    const bat = block({ title: 'Работа без батареи', icon: 'battery' }, async (c) => {
      const d = await ctx.mod('battery');
      const on = String(d.nobattery) === '1';
      return [
        el('p', { class: 'muted' }, 'Для работы от USB без аккумулятора, например на постоянном питании. ' +
          'Без этого режима роутер без батареи может выключаться или не загружаться.'),
        ui.toggle('Режим без батареи', on, async (v) => {
          const ok = await ui.confirm(v
            ? 'Включить режим без батареи? После этого выключите роутер, выньте батарею и включите его от USB.'
            : 'Выключить режим без батареи? После этого вставьте батарею и перезагрузите роутер.',
          { ok: v ? 'Включить' : 'Выключить', danger: true });
          if (!ok) return false;
          try {
            await ctx.mod('battery', 'set', { nobattery: v ? 1 : 0 });
          } catch (e) {
            throw new Error(modErr(e));
          }
          ui.toast(v ? 'Режим включен. Выключите роутер, выньте батарею и включите его от USB.' : 'Режим выключен. Вставьте батарею и перезагрузите роутер.', 'ok');
          c.reload();
        }, { disabled: !nvWrite }),
        nvWrite ? null : el('small', { class: 'hint' }, 'Нужна запись в память модема (NV). ', ui.dangerLink()),
      ];
    });

    root.appendChild(ui.grid(ttl, spe, radio, bat));
    await Promise.all([ttl.reload(), spe.reload(), radio.reload(), bat.reload()]);
  },
});
