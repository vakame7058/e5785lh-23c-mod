-- POST /api/mod/scripts (поля — docs/API.md)
dofile('/app/html/api/mod/_lib.inc').post('scripts', {
    run = {'name', 'args', 'timeout_s', 'bg'},
    result = {'job'},
    read = {'name'},
    save = {'name', 'content_b64'},
    delete = {'name'},
    autorun = {'name', 'enable'},
})
