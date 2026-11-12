"""e5785_proxy.py: мост 127.0.0.1:<порт> -> роутер по IPv6 через USB-интерфейс.

Запуск на компьютере: python3 e5785_proxy.py [локальный_порт] [удаленный_порт]
По умолчанию 8080 -> 80 (веб-интерфейс). Для SSH: 2222 -> 22.
Интерфейс: переменная E5785_IFACE, иначе первый wwx* (USB-сеть роутера).
Адрес роутера ищется сам: ping ff02::1 на интерфейсе, первый чужой ответивший.
Остановить: Ctrl-C.
"""
import asyncio
import glob
import os
import re
import subprocess
import sys

def find_iface():
    if os.environ.get("E5785_IFACE"):
        return os.environ["E5785_IFACE"]
    found = sorted(glob.glob("/sys/class/net/wwx*"))
    if not found:
        sys.exit("нет интерфейса wwx*: задайте E5785_IFACE")
    return os.path.basename(found[0])


IFACE = find_iface()
LPORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
RPORT = int(sys.argv[2]) if len(sys.argv) > 2 else 80
router = None


def discover():
    own = subprocess.run(["ip", "-6", "addr", "show", "dev", IFACE],
                         capture_output=True, text=True).stdout
    own = set(re.findall(r"inet6 (fe80::[0-9a-f:]+)", own))
    out = subprocess.run(["ping", "-6", "-c", "2", "-W", "2", f"ff02::1%{IFACE}"],
                         capture_output=True, text=True).stdout
    for addr in re.findall(r"from (fe80::[0-9a-f:]+)%", out):
        if addr not in own:
            return f"{addr}%{IFACE}"
    return None


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def connect():
    global router
    for attempt in range(2):
        if router is None:
            router = await asyncio.to_thread(discover)
            print("роутер:", router, flush=True)
            if router is None:
                return None
        try:
            return await asyncio.wait_for(asyncio.open_connection(router, RPORT), 5)
        except Exception as e:
            print("нет связи с", router, "-", e, flush=True)
            router = None
    return None


async def handle(cr, cw):
    conn = await connect()
    if conn is None:
        cw.close()
        return
    rr, rw = conn
    await asyncio.gather(pipe(cr, rw), pipe(rr, cw))


async def main():
    srv = await asyncio.start_server(handle, "127.0.0.1", LPORT)
    print(f"мост: http://127.0.0.1:{LPORT} -> роутер на {IFACE}, порт {RPORT}", flush=True)
    async with srv:
        await srv.serve_forever()


asyncio.run(main())
