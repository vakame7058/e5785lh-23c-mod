-- POST /api/mod/svc (поля — docs/API.md)
dofile('/app/html/api/mod/_lib.inc').post('svc', {
    start = {'name'},
    stop = {'name'},
    enable = {'name'},
    disable = {'name'},
    status = {'name'},
    dns_preset = {'id'},
    dns_custom = {'addr'},
    dns_adblock = {'on'},
    dns_enable = {},
    dns_disable = {},
})
