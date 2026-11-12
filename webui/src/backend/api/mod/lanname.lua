-- Имя роутера в сети: homeurl = DeviceName.DomainName
-- (InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.). Работает в процессе web через dm;
-- помощник нужен только для проверки: что отвечает DNS роутера и пускает ли веб с этим именем.
-- Вызов: POST /api/vsim/config-vsim, module=lanname, action=show | set (device_name, domain_name).

local L = dofile('/app/html/api/mod/_lib.inc')
local dmm = dm or require('dm')
local DOMAIN = 'InternetGatewayDevice.LANDevice.1.LANHostConfigManagement.'

local function read_names()
    local err, v = dmm.GetParameterValues(DOMAIN, {'DeviceName', 'DomainName'})
    if err ~= 0 or type(v) ~= 'table' or type(v[DOMAIN]) ~= 'table' then
        return nil, nil, err
    end
    return tostring(v[DOMAIN]['DeviceName'] or ''), tostring(v[DOMAIN]['DomainName'] or '')
end

local function homeurl(dev, dom)
    if dom ~= '' then return dev .. '.' .. dom end
    return dev
end

-- метка DNS: a-z, 0-9, дефис не по краям, 1–63 символа
local function label_ok(s)
    if #s < 1 or #s > 63 then return false end
    if not string.find(s, '^[a-z0-9%-]+$') then return false end
    if string.sub(s, 1, 1) == '-' or string.sub(s, -1) == '-' then return false end
    return true
end

-- nil или текст ошибки
local function check(dev, dom)
    if not label_ok(dev) then
        return 'device_name: одна метка из букв a-z, цифр и дефиса (не в начале и не в конце), 1–63 символа'
    end
    if dom ~= '' then
        for lab in string.gmatch(dom .. '.', '([^.]*)%.') do
            if not label_ok(lab) then
                return 'domain_name: метки через точку, в метке буквы a-z, цифры и дефис (не в начале и не в конце), 1–63 символа'
            end
        end
        local last = string.match(dom, '([^.]+)$')
        if last == 'local' then
            return 'domain_name: окончание .local занято mDNS (Bonjour, Avahi): телефоны и компьютеры ищут такие имена '
                .. 'без DNS роутера, и имя не откроется. Возьмите, например, lan или home.arpa'
        end
    end
    if #homeurl(dev, dom) > 253 then
        return 'имя целиком длиннее 253 символов'
    end
    return nil
end

local function show_fragment(dev, dom)
    local url = homeurl(dev, dom)
    local s = L.x('device_name', dev) .. L.x('domain_name', dom) .. L.x('homeurl', url)
    -- проверка через помощника: DNS роутера (127.0.0.1) и ответ веба на Host: <имя>
    local code, body = L.call('lanname.resolve', {name = url})
    if code == 0 then
        s = s .. body
    else
        s = s .. L.x('check_error', string.match(body or '', '^([^\n]*)') or '')
    end
    return s
end

local d = type(data) == 'table' and data or {}
local action = d['action']

if action == 'show' then
    local dev, dom, err = read_names()
    if not dev then
        L.print_error(9004, 'Не удалось прочитать имя роутера (код ' .. tostring(err) .. ')')
    else
        L.print_ok(show_fragment(dev, dom))
    end
elseif action == 'set' then
    local dev = type(d['device_name']) == 'string' and string.lower(L.unent(d['device_name'])) or ''
    local dom = type(d['domain_name']) == 'string' and string.lower(L.unent(d['domain_name'])) or ''
    dom = string.gsub(dom, '^%.+', '')
    dom = string.gsub(dom, '%.+$', '')
    local bad = check(dev, dom)
    if bad then
        L.print_error(9003, 'Неверное значение: ' .. bad)
    else
        local param = {
            {key = DOMAIN .. 'DeviceName', value = dev},
            {key = DOMAIN .. 'DomainName', value = dom},
        }
        local err, needreboot, paramerror = dmm.SetParameterValues(param)
        if err ~= 0 or paramerror ~= nil then
            local detail = ''
            if type(paramerror) == 'table' then
                for k, v in pairs(paramerror) do detail = detail .. tostring(k) .. '=' .. tostring(v) .. ' ' end
            end
            L.print_error(9004, 'Роутер не принял имя (код ' .. tostring(err) .. ')', detail)
        else
            local ndev, ndom = read_names()
            local s = show_fragment(ndev or dev, ndom or dom)
            if needreboot ~= nil and needreboot ~= 0 and needreboot ~= false then
                s = s .. L.x('reboot_needed', 1)
            else
                s = s .. L.x('reboot_needed', 0)
            end
            L.print_ok(s)
        end
    end
else
    L.print_error(9009, 'Неизвестное действие: ' .. tostring(action))
end
L.mute_post_response()
