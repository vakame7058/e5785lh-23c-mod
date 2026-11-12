-- Общая часть обработчиков /api/mod/*: вызов root-помощника и ответ в XML.
-- Подключение: dofile('/app/html/api/mod/_lib.inc').get('<имя>')
--              dofile('/app/html/api/mod/_lib.inc').post('<имя>', {<действие> = {<поля>}, ...})
-- Файл без окончания .lua: веб-сервер его не отдает и не выполняет как обработчик.

local M = {}

local BB = '/system/bin/busyboxx'
local SECRET_FILE = '/online/mod/helper/secret'
local QUEUE = '/var/modq/'
local CLIENT = '/online/mod/helper/hc'

local MSG = {
    [9001] = 'Помощник не запущен или не отвечает',
    [9002] = 'Действие запрещено',
    [9003] = 'Неверный запрос',
    [9005] = 'Помощник не ответил вовремя',
    [9009] = 'Неизвестное действие',
}

-- сколько секунд ждать помощника, по действию
local TIMEOUT = {
    ['signal.show'] = 60,
    ['cell.show'] = 45,
    ['scripts.run'] = 75,
    ['svc.show'] = 60,
    ['svc.start'] = 75, ['svc.stop'] = 75, ['svc.enable'] = 75, ['svc.disable'] = 75, ['svc.status'] = 75,
    ['vpn.start'] = 75, ['vpn.stop'] = 75, ['vpn.save'] = 75, ['vpn.setconf'] = 75, ['vpn.autostart'] = 75, ['vpn.dns'] = 45,
    ['vpn.profile_use'] = 75, ['vpn.profile_delete'] = 45, ['vpn.profile_label'] = 45,
    ['vpn.split'] = 75, ['vpn.split_update'] = 75, ['vpn.split_direct'] = 45, ['vpn.split_vpn'] = 45, ['vpn.failover'] = 45,
    ['lanname.resolve'] = 20,
    ['svc.dns_preset'] = 45, ['svc.dns_custom'] = 45, ['svc.dns_adblock'] = 45, ['svc.dns_enable'] = 100, ['svc.dns_disable'] = 100,
    ['msisdn.show'] = 20, ['msisdn.set'] = 20, ['msisdn.sms'] = 30,
}
local TIMEOUT_DEFAULT = 30

local MAX_FIELD = 512          -- простое поле
local MAX_B64 = 360000         -- поле *_b64

local sysm = sys or require('sys')

-- ---------- текст ----------

-- только допустимые в XML 1.0 символы и правильный UTF-8
local function utf8fix(s)
    s = string.gsub(s, '[%z\1-\8\11\12\14-\31\127]', '')
    if not string.find(s, '[\128-\255]') then
        return s
    end
    local out, n, i = {}, #s, 1
    while i <= n do
        local j = string.find(s, '[\128-\255]', i)
        if not j then
            out[#out + 1] = string.sub(s, i)
            break
        end
        if j > i then
            out[#out + 1] = string.sub(s, i, j - 1)
        end
        local c = string.byte(s, j)
        local len = 0
        if c >= 0xC2 and c <= 0xDF then len = 2
        elseif c >= 0xE0 and c <= 0xEF then len = 3
        elseif c >= 0xF0 and c <= 0xF4 then len = 4 end
        local ok = len > 0 and j + len - 1 <= n
        if ok then
            for k = j + 1, j + len - 1 do
                local d = string.byte(s, k)
                if d < 0x80 or d > 0xBF then ok = false; break end
            end
        end
        if ok then
            out[#out + 1] = string.sub(s, j, j + len - 1)
            i = j + len
        else
            out[#out + 1] = '?'
            i = j + 1
        end
    end
    return table.concat(out)
end

local function xesc(s)
    s = utf8fix(tostring(s or ''))
    s = string.gsub(s, '&', '&amp;')
    s = string.gsub(s, '<', '&lt;')
    s = string.gsub(s, '>', '&gt;')
    return s
end

-- сущности XML в простых полях запроса (если разборщик их не раскрыл)
local function unent(s)
    if not string.find(s, '&', 1, true) then
        return s
    end
    s = string.gsub(s, '&#[xX](%x+);', function(h)
        local n = tonumber(h, 16)
        if n and n < 128 then return string.char(n) end
    end)
    s = string.gsub(s, '&#(%d+);', function(d)
        local n = tonumber(d)
        if n and n < 128 then return string.char(n) end
    end)
    s = string.gsub(s, '&lt;', '<')
    s = string.gsub(s, '&gt;', '>')
    s = string.gsub(s, '&quot;', '"')
    s = string.gsub(s, '&apos;', "'")
    s = string.gsub(s, '&amp;', '&')
    return s
end

local function urlenc(s)
    return (string.gsub(s, '[^%w%-%._~]', function(c)
        return string.format('%%%02X', string.byte(c))
    end))
end

-- ---------- ответы ----------

local HEAD = '<?xml version="1.0" encoding="UTF-8"?>'

local function error_xml(code, message, output)
    local s = HEAD .. '<error><code>' .. tostring(code) .. '</code><message>'
        .. xesc(message or MSG[code] or '') .. '</message>'
    if output and output ~= '' then
        s = s .. '<output>' .. xesc(output) .. '</output>'
    end
    return s .. '</error>'
end

-- POST: do_post.lua после обработчика печатает utils.response(); один раз его глушим
local function mute_post_response()
    local ok, utils = pcall(require, 'utils')
    if ok and type(utils) == 'table' and type(utils.response) == 'function' then
        local orig = utils.response
        utils.response = function() utils.response = orig end
    end
end

-- ---------- вызов помощника ----------

local function readline(path)
    local f = io.open(path, 'r')
    if not f then return nil end
    local s = f:read('*l')
    f:close()
    return s
end

-- Путь web → root: процесс web (uid 1000) и его дочерние без группы inet не могут открыть
-- TCP-сокет, поэтому запрос кладется файлом в очередь /var/modq, а ответ читает клиент hc
-- (см. /online/mod/helper/qd).
-- Возвращает код (0 — успех) и тело: XML-фрагмент или "сообщение\nвывод".
function M.call(action, args, payload)
    local secret = readline(SECRET_FILE)
    if not secret or secret == '' then
        return 9001, MSG[9001]
    end
    local q = 'a=' .. urlenc(action)
    if args then
        for k, v in pairs(args) do
            q = q .. '&' .. k .. '=' .. urlenc(v)
        end
    end
    local id = 'l' .. tostring(os.time()) .. '_' .. tostring(math.random(100000, 999999))
    local f = io.open(QUEUE .. id .. '.req', 'wb')
    if not f then
        return 9001, MSG[9001] .. ': нет очереди ' .. QUEUE
    end
    f:write(q .. '\n' .. secret .. '\n' .. (payload or ''))
    f:close()
    local t = TIMEOUT[action] or TIMEOUT_DEFAULT
    local p = io.popen(BB .. ' sh ' .. CLIENT .. ' ' .. id .. ' ' .. t .. ' 2>/dev/null')
    local resp = p and p:read('*a') or ''
    if p then p:close() end
    local _, he = string.find(resp, '\r\n\r\n', 1, true)
    if he then
        resp = string.sub(resp, he + 1)
    end
    local code, rest = string.match(resp, '^S (%d+)\n?(.*)$')
    if not code then
        return 9001, MSG[9001]
    end
    return tonumber(code), rest
end

local function reply(code, body)
    if code == 0 then
        return HEAD .. '<response>' .. utf8fix(body) .. '</response>'
    end
    local msg, output = string.match(body or '', '^([^\n]*)\n?(.*)$')
    return error_xml(code, msg, output)
end

-- ---------- для обработчиков, которые работают сами (без помощника) ----------

M.xesc = xesc
M.unent = unent
M.error_xml = error_xml
M.mute_post_response = mute_post_response

-- ответ: XML-фрагмент в <response> или ошибка
function M.print_ok(fragment)
    sysm.print(HEAD .. '<response>' .. utf8fix(fragment) .. '</response>')
end

function M.print_error(code, message, output)
    sysm.print(error_xml(code, message, output))
end

-- <имя>значение</имя>
function M.x(name, value)
    return '<' .. name .. '>' .. xesc(value) .. '</' .. name .. '>'
end

-- ---------- точки входа ----------

function M.get(name)
    local code, body = M.call(name .. '.show')
    sysm.print(reply(code, body))
end

-- spec: {действие = {поле, ...}}; поле с окончанием _b64 уходит телом запроса
function M.post(name, spec)
    local d = data
    local s
    if type(d) ~= 'table' then
        s = error_xml(9003, 'Неверный запрос: нет тела <request>')
    else
        local action = d['action']
        if type(action) ~= 'string' or not string.find(action, '^[a-z_]+$') or not spec[action] then
            s = error_xml(9009, 'Неизвестное действие: ' .. tostring(action))
        else
            local args, payload, bad = {}, nil, nil
            for _, k in ipairs(spec[action]) do
                local v = d[k]
                if type(v) == 'number' then v = tostring(v) end
                if type(v) == 'string' then
                    if string.find(k, '_b64$') then
                        if #v > MAX_B64 then bad = k break end
                        payload = string.gsub(v, '%s', '')
                    else
                        v = unent(v)
                        if #v > MAX_FIELD then bad = k break end
                        args[k] = v
                    end
                end
            end
            if bad then
                s = error_xml(9003, 'Неверное значение: ' .. bad .. ' (слишком длинное)')
            else
                s = reply(M.call(name .. '.' .. action, args, payload))
            end
        end
    end
    sysm.print(s)
    mute_post_response()
end

return M
