-- POST /api/mod/radio (поля — docs/API.md)
dofile('/app/html/api/mod/_lib.inc').post('radio', {
    set = {'mode', 'bands'},
})
