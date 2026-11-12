-- POST /api/mod/vpn (поля — docs/API.md)
dofile('/app/html/api/mod/_lib.inc').post('vpn', {
    start = {'type'},
    stop = {'type'},
    autostart = {'type', 'enable'},
    config = {'type', 'name'},
    save = {'type', 'name', 'content_b64'},
    setconf = {'type', 'name', 'label', 'conf_b64'},
    profile_use = {'type', 'name'},
    profile_delete = {'type', 'name'},
    profile_label = {'type', 'name', 'label'},
    dns = {'type', 'on'},
    split = {'on'},
    split_update = {'list_b64'},
    split_direct = {'op', 'addr'},
    split_vpn = {'op', 'addr'},
    failover = {'on', 'primary'},
})
