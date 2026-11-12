// Стоковый интерфейс: ссылки на страницы веб-интерфейса прошивки (/html/<имя>.html) для редких функций.
// Список — по меню стока (config/global/config.xml) без того, чего нет на E5785Lh-23c (полный список функций прошивки,
// раздел «Не поддерживается на 23c»: SD-карта, проводной порт, мост, голос, Bluetooth, онлайн-обновление и др.).

const GROUPS = [
  ['Сообщения', [
    ['smsinbox', 'SMS', 'папки, отправка, удаление'],
    ['messagesettings', 'Настройки SMS', 'номер SMS-центра, отчеты о доставке, где хранить'],
    ['phonebook', 'Телефонная книга', 'контакты на роутере и на SIM-карте'],
    ['ussd', 'USSD', 'запросы оператору'],
  ]],
  ['Мобильная сеть', [
    ['mobileconnection', 'Мобильные данные', 'включение передачи данных, роуминг'],
    ['profilesmgr', 'Точки доступа (APN)', 'профили подключения к оператору'],
    ['mobilenetworksettings', 'Режим сети', '2G, 3G, 4G, выбор оператора'],
    ['pincodemanagement', 'PIN-код SIM-карты', 'включить, выключить, сменить PIN'],
    ['celllock', 'Список сот оператора', 'сброс списка разрешенных сот'],
    ['statistic', 'Статистика трафика', 'счетчики и месячный лимит'],
  ]],
  ['Wi-Fi и устройства', [
    ['wlanbasicsettings', 'Основные настройки Wi-Fi', 'имя сети, пароль, защита'],
    ['wlanadvanced', 'Дополнительные настройки Wi-Fi', 'канал, режим, ширина полосы'],
    ['wlanmacfilter', 'Фильтр Wi-Fi по MAC', 'запрет или разрешение устройств'],
    ['wps', 'WPS', 'подключение кнопкой'],
    ['devicemanagement', 'Подключенные устройства', 'список и блокировка'],
    ['parentalcontrol', 'Родительский контроль', 'доступ в интернет по расписанию'],
  ]],
  ['Безопасность и сеть', [
    ['dhcp', 'DHCP', 'адрес роутера, раздача адресов'],
    ['firewallswitch', 'Брандмауэр', 'включение фильтров'],
    ['lanipfilter', 'Фильтр IP-адресов', 'правила доступа по адресам и портам'],
    ['macfilter', 'Фильтр по MAC', 'общий фильтр устройств'],
    ['virtualserver', 'Проброс портов', 'виртуальные серверы'],
    ['specialapplication', 'Особые приложения', 'открытие портов по исходящему соединению'],
    ['dmzsettings', 'DMZ', 'все входящие соединения на одно устройство'],
    ['sipalgsettings', 'SIP ALG', 'IP-телефония через NAT'],
    ['upnp', 'UPnP', 'автоматическое открытие портов'],
    ['nat', 'Тип NAT', 'конусный или симметричный'],
    ['staticroute', 'Статические маршруты', 'маршруты к другим сетям'],
    ['vpnsettings', 'VPN прошивки', 'L2TP, PPTP, IPsec'],
  ]],
  ['Система', [
    ['deviceinformation', 'Сведения об устройстве', 'IMEI, версии, адреса'],
    ['modifypassword', 'Пароль веб-интерфейса', 'смена пароля'],
    ['configuration', 'Резервная копия настроек', 'сохранить и восстановить из файла'],
    ['systemsettings', 'Системные настройки', 'USB-модем, энергосбережение'],
    ['timesettings', 'Время', 'часовой пояс, серверы времени'],
    ['systemlog', 'Системный журнал', 'события прошивки'],
    ['diagnosis', 'Диагностика', 'ping и traceroute'],
    ['reboot', 'Перезагрузка', ''],
    ['restore', 'Сброс настроек', 'возврат к заводским'],
    ['quicksetup', 'Мастер настройки', 'первоначальная настройка'],
  ]],
];

M.page({
  id: 'stock',
  title: 'Стоковый интерфейс',
  group: 'Система',
  icon: 'link',
  order: 590,
  render: async (root, ctx) => {
    const ui = ctx.ui || M.ui;
    const el = ui.el;
    const q = el('input', { type: 'search', id: 'stock-q', class: 'inp inp-inline', placeholder: 'Поиск по названию', autocomplete: 'off',
      'aria-label': 'Поиск страницы' });
    const box = el('div');

    const draw = () => {
      const s = q.value.trim().toLowerCase();
      ui.clear(box);
      let n = 0;
      const cards = GROUPS.map(([g, items]) => {
        const list = items.filter((i) => !s || (i[1] + ' ' + i[2]).toLowerCase().indexOf(s) >= 0);
        n += list.length;
        if (!list.length) return null;
        return ui.card(g, el('ul', { class: 'link-list' }, list.map((i) => el('li', null,
          el('a', { href: '/html/' + i[0] + '.html', target: '_blank', rel: 'noopener' }, i[1]),
          i[2] ? el('small', { class: 'hint' }, i[2]) : null))));
      }).filter(Boolean);
      if (!n) box.appendChild(ui.empty('Ничего не найдено.'));
      else box.appendChild(ui.grid(cards));
    };
    q.addEventListener('input', draw);

    root.appendChild(ui.card({ title: 'Стоковый интерфейс', icon: 'link',
      actions: [el('a', { href: '/html/home.html', target: '_blank', rel: 'noopener', class: 'btn btn-ghost' }, 'Открыть главную стока')] },
      el('p', { class: 'muted' }, 'Веб-интерфейс самой прошивки. Здесь собраны его страницы для функций, ' +
        'которых нет в этом интерфейсе. Страницы открываются в новой вкладке; войти там, возможно, придется еще раз.'),
      ui.notice('Не меняйте одну настройку одновременно здесь и в стоковом интерфейсе: сохранится то, что записано последним.', 'info'),
      q));
    root.appendChild(box);
    draw();
  },
});
