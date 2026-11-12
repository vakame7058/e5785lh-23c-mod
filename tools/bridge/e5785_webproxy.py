"""e5785_webproxy.py: веб-интерфейс роутера в браузере через проброс ssh.

Запуск на компьютере: python3 e5785_webproxy.py [локальный_порт] [порт_проброса] [адрес_роутера]
По умолчанию 127.0.0.1:8090 -> 127.0.0.1:8081 (ssh -L на роутер), имя роутера 192.168.1.1.
Мост подменяет Host, Origin и Referer на имя роутера и переписывает редиректы обратно.
Каждый запрос идет в своем соединении (Connection: close). Остановить: Ctrl-C.
"""
import asyncio
import re
import sys

LPORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
UPORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8081
ROUTER = sys.argv[3] if len(sys.argv) > 3 else "192.168.1.1"
LOCAL = f"127.0.0.1:{LPORT}"


async def read_head(reader):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = await reader.read(65536)
        if not chunk:
            return data, b""
        data += chunk
    head, rest = data.split(b"\r\n\r\n", 1)
    return head, rest


def fix_request(head):
    lines = head.decode("latin1").split("\r\n")
    out = [lines[0]]
    for ln in lines[1:]:
        name = ln.split(":", 1)[0].strip().lower()
        if name == "host":
            ln = f"Host: {ROUTER}"
        elif name in ("origin", "referer"):
            ln = ln.replace(f"http://{LOCAL}", f"http://{ROUTER}")
        elif name in ("connection", "keep-alive", "proxy-connection"):
            continue
        out.append(ln)
    out.append("Connection: close")
    return "\r\n".join(out).encode("latin1") + b"\r\n\r\n"


def fix_response(head):
    text = head.decode("latin1")
    text = re.sub(rf"http://{re.escape(ROUTER)}(?=[/\r?:]|$)", f"http://{LOCAL}", text)
    return text.encode("latin1") + b"\r\n\r\n"


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def handle(cr, cw):
    try:
        head, rest = await read_head(cr)
        if not head:
            cw.close()
            return
        ur, uw = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", UPORT), 10)
        uw.write(fix_request(head) + rest)
        await uw.drain()
        up = asyncio.create_task(pipe(cr, uw))
        rhead, rrest = await read_head(ur)
        if rhead:
            cw.write(fix_response(rhead) + rrest)
            await cw.drain()
        await pipe(ur, cw)
        up.cancel()
    except Exception as e:
        print("ошибка:", e, flush=True)
        cw.close()


async def main():
    srv = await asyncio.start_server(handle, "127.0.0.1", LPORT)
    print(f"веб роутера: http://{LOCAL}/  (роутер {ROUTER} через 127.0.0.1:{UPORT})", flush=True)
    async with srv:
        await srv.serve_forever()


asyncio.run(main())
