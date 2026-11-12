-- POST /api/mod/logs (поля — docs/API.md)
dofile('/app/html/api/mod/_lib.inc').post('logs', {
    get = {'id', 'lines'},
})
