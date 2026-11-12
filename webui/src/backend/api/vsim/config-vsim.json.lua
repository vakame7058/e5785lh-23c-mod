-- GET /api/vsim/config-vsim — состояние помощника (как POST module=helper action=show).
-- Почему этот путь — см. config-vsim.lua.
dofile('/app/html/api/mod/_lib.inc').get('helper')
