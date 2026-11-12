-- POST /api/mod/helper (поля — docs/API.md): флаги помощника
dofile('/app/html/api/mod/_lib.inc').post('helper', {
    set = {'modem_write', 'nv_write'},
})
