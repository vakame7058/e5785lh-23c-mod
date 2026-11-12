"""Минимальный клиент fastboot для Balong (VID 12d1, PID 36dd) на pyusb.
Использование:
  fbcli.py cmd "<команда>" [--out файл] [--timeout сек]   послать одну команду, показать INFO/OKAY/FAIL/DATA
  fbcli.py dl <файл>                                       download: (только загрузка в RAM загрузчика)
Только по USB 12d1:36dd; на посторонние устройства не ходит.
"""
import argparse, struct, sys, time
import usb.core, usb.util

VID, PID = 0x12D1, 0x36DD

def open_dev():
    dev = usb.core.find(idVendor=VID, idProduct=PID)
    if dev is None:
        sys.exit("12d1:36dd не найден")
    try:
        if dev.is_kernel_driver_active(0):
            dev.detach_kernel_driver(0)
    except Exception:
        pass
    usb.util.claim_interface(dev, 0)
    return dev

def send(dev, data, timeout=5000):
    dev.write(0x01, data, timeout)

def recv(dev, timeout=5000, size=4096):
    return bytes(dev.read(0x81, size, timeout))

def command(dev, cmd, timeout=10.0, out=None):
    """Послать команду, собрать ответы. DATA<hex8> -> принять столько байт."""
    send(dev, cmd.encode())
    end = time.time() + timeout
    log = []
    raw = bytearray()
    while time.time() < end:
        try:
            r = recv(dev, 2000)
        except usb.core.USBTimeoutError:
            continue
        tag = r[:4]
        if tag == b"INFO":
            log.append("INFO " + r[4:].decode("latin1"))
        elif tag in (b"OKAY", b"FAIL"):
            log.append(tag.decode() + " " + r[4:].decode("latin1"))
            return log, None
        elif tag == b"DATA":
            n = int(r[4:12], 16)
            log.append(f"DATA {n}")
            buf = bytearray()
            while len(buf) < n and time.time() < end:
                try:
                    buf += recv(dev, 3000, 65536)
                except usb.core.USBTimeoutError:
                    continue
            log.append(f"получено {len(buf)} из {n}")
            # хвост OKAY/FAIL
            try:
                t = recv(dev, 3000)
                log.append(t[:4].decode("latin1") + " " + t[4:].decode("latin1"))
            except usb.core.USBTimeoutError:
                log.append("(нет завершающего OKAY)")
            return log, bytes(buf)
        else:
            raw.extend(r)
            if len(log) < 6 or not log[-1].startswith("? "):
                log.append(f"? {len(r)} Б: {r[:32].hex()}")
            end = max(end, time.time() + 3)   # данные идут, не обрываем
    log.append(f"таймаут (сырых байт: {len(raw)})")
    return log, (bytes(raw) if raw else None)

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    c = sub.add_parser("cmd"); c.add_argument("text"); c.add_argument("--out"); c.add_argument("--timeout", type=float, default=10)
    d = sub.add_parser("dl"); d.add_argument("path")
    a = ap.parse_args()
    dev = open_dev()
    if a.mode == "cmd":
        log, data = command(dev, a.text, a.timeout)
        print("\n".join(log))
        if data is not None and a.out:
            open(a.out, "wb").write(data)
            print("записано", len(data), "->", a.out)
    else:
        blob = open(a.path, "rb").read()
        log, _ = command(dev, f"download:{len(blob):08x}", 5)
        print("\n".join(log))
        if log and log[0].startswith("DATA"):
            pass
    usb.util.dispose_resources(dev)

if __name__ == "__main__":
    main()
