-- POST /api/mod/battery (поля — docs/API.md)
dofile('/app/html/api/mod/_lib.inc').post('battery', {
    set = {'nobattery'},
})
