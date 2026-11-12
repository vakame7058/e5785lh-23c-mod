-- POST /api/mod/msisdn (поля — docs/API.md); show — через помощника (_lib.get)
dofile('/app/html/api/mod/_lib.inc').post('msisdn', {
    set = {'number', 'source'},
    parse = {'text_b64'},
    query = {},
    sms = {},
})
