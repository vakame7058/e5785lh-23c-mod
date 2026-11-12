-- POST /api/mod/ttl (поля — docs/API.md)
dofile('/app/html/api/mod/_lib.inc').post('ttl', {
    set = {'enable'},
})
