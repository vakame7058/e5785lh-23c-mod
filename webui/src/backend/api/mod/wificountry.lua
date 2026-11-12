-- POST /api/mod/wificountry (поля — docs/API.md)
dofile('/app/html/api/mod/_lib.inc').post('wificountry', {
    set = {'country'},
})
