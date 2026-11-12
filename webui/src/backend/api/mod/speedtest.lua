-- POST /api/mod/speedtest (поля — docs/API.md)
dofile('/app/html/api/mod/_lib.inc').post('speedtest', {
    run = {'server', 'url', 'timeout_s', 'via', 'direction', 'streams'},
    servers = {},
})
