-- POST /api/mod/at (поля — docs/API.md)
dofile('/app/html/api/mod/_lib.inc').post('at', {
    send = {'cmd'},
})
