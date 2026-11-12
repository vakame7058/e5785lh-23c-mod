-- POST /api/mod/cell (поля — docs/API.md)
dofile('/app/html/api/mod/_lib.inc').post('cell', {
    set = {'pci', 'earfcn'},
    clear = {},
})
