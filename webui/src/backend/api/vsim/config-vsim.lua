-- POST /api/vsim/config-vsim — единая точка входа своих вызовов (поля — docs/API.md).
-- Веб роутера выполняет только пути из подписанного списка
-- /app/webroot/WebApp/common/webauth/restfulconfig_common.xml. Пути /api/mod/* в нем нет,
-- а vsim/config-vsim есть (доступ только после входа), и виртуальной SIM на 23c нет.
-- Поле module выбирает обработчик из /app/html/api/mod/; action=show — состояние (как GET),
-- остальные действия — как POST /api/mod/<module>.
local DIR = '/app/html/api/mod/'
local NAMES = {
    helper = 1, sysinfo = 1, signal = 1, cell = 1, ttl = 1, spe = 1, scripts = 1, at = 1,
    wificountry = 1, speedtest = 1, vpn = 1, svc = 1, logs = 1, radio = 1, battery = 1,
    lanname = 1, msisdn = 1,
}
-- модули, которые сами обрабатывают и action=show (работают в процессе web через dm)
local SELF = { lanname = 1 }

-- do_post.lua после обработчика печатает utils.response(); один раз его глушим
local function mute_post_response()
    local ok, utils = pcall(require, 'utils')
    if ok and type(utils) == 'table' and type(utils.response) == 'function' then
        local orig = utils.response
        utils.response = function() utils.response = orig end
    end
end

local function fail(code, message)
    local s = sys or require('sys')
    s.print('<?xml version="1.0" encoding="UTF-8"?><error><code>' .. code .. '</code><message>'
        .. message .. '</message></error>')
    mute_post_response()
end

local name = type(data) == 'table' and data['module'] or nil
if type(name) ~= 'string' or not NAMES[name] then
    fail(9009, 'Неизвестный модуль')
elseif data['action'] == 'show' and not SELF[name] then
    dofile(DIR .. '_lib.inc').get(name)
    mute_post_response()
else
    local f = io.open(DIR .. name .. '.lua', 'r')
    if f then
        f:close()
        dofile(DIR .. name .. '.lua')
    else
        fail(9009, 'Неизвестное действие')
    end
end
