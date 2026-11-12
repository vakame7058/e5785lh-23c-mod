#!/usr/bin/env python3
"""Картинки для README и темы на форуме: снимки со стендов и моков, без съемки вживую.

Запуск из корня комплекта:
    python3 packaging/mk_images.py [--webui КАТАЛОГ] [--only screens,panel,header]

screens  анимация из boot/anim, главный экран и переходы по меню: настоящие oled_*.c на компьютере
panel    страницы панели: настоящая сборка, мок API dev/server.py, тестовые данные, браузер Chromium
header   общая картинка для шапки: из снимков выше

Результат в docs/img. Дерево webui не меняется: сборка идет во временной копии.
Нужны: clang с ASan и UBSan, bwrap, busybox, Pillow, playwright с Chromium.
"""
import argparse
import base64
import http.client
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, "docs", "img")
SCALE = 3
SPEED_SHOTS, SPEED_STEP_MS = 14, 5000
SPEED_CLIP = {"x": 240, "y": 56, "width": 1040, "height": 804}
W = H = 128


def raw_to_image(path):
    """Кадр стенда: uint16 в памяти, байты RGB565 переставлены: старший первым."""
    d = open(path, "rb").read()
    im = Image.new("RGB", (W, H))
    px = im.load()
    for i in range(W * H):
        v = struct.unpack_from(">H", d, 2 * i)[0]
        px[i % W, i // W] = ((v >> 11) << 3, ((v >> 5) & 63) << 2, (v & 31) << 3)
    return im


def up(im, k=SCALE):
    return im.resize((im.width * k, im.height * k), Image.NEAREST)


def save_gif(path, frames, durations):
    pal = [f.convert("P", palette=Image.ADAPTIVE, colors=64) for f in frames]
    pal[0].save(path, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f"{os.path.basename(path)}: {os.path.getsize(path)} Б, кадров {len(frames)}")


def save_png(path, im, colors=None):
    if colors:
        im = im.convert("P", palette=Image.ADAPTIVE, colors=colors)
    im.save(path, optimize=True)
    print(f"{os.path.basename(path)}: {os.path.getsize(path)} Б")


def animation():
    d = os.path.join(ROOT, "boot", "anim")
    names = sorted(n for n in os.listdir(d) if re.fullmatch(r"poehali4_\d\d\.png", n))
    ms = [int(x) for x in open(os.path.join(d, "durations")).read().split()]
    frames = [up(Image.open(os.path.join(d, n)).convert("RGB")) for n in names]
    save_gif(os.path.join(IMG, "boot_anim.gif"), frames, ms)


def stand_cflags(src):
    return ["-std=gnu11", "-g", "-O1", "-D_GNU_SOURCE", f"-I{src}", "-include", "stdint.h", "-include", "stdio.h",
            "-include", "string.h", "-include", "errno.h", "-include", "unistd.h", "-w"]


def home_frames(tmp):
    """Главный экран: home_test рисует кадры настоящим oled_home_paint.c."""
    t = os.path.join(ROOT, "oled-menu", "test", "home")
    src = os.path.join(ROOT, "oled-menu", "src")
    out = os.path.join(tmp, "home")
    os.makedirs(out, exist_ok=True)
    subprocess.run(["clang", *stand_cflags(src), os.path.join(t, "home_test.c"), os.path.join(t, "stubs.c"),
                    *[os.path.join(src, f) for f in ("oled_home.c", "oled_home_paint.c", "oled_text.c", "oled_paint.c")],
                    "-o", os.path.join(out, "home_test"), "-lpthread"], check=True)
    subprocess.run([os.path.join(out, "home_test"), out], check=True, stdout=subprocess.DEVNULL, cwd=out)
    return out


def menu_frames(tmp):
    """Переходы по меню: стенд test/dns, настоящие oled_widgets.c, dns_menu.sh и svc.sh; кадры .raw."""
    run = os.path.join(ROOT, "oled-menu", "test", "dns", "run.sh")
    out = os.path.join(ROOT, "oled-menu", "test", "out", "dns", "png")
    scenario = ["s00", "m", "s01", "m", "s02", "m", "s03", "m", "s04", "p", "s05", "m", "s06", "m", "s07", "m", "s08"]
    subprocess.run(["bash", run, *scenario], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    dst = os.path.join(tmp, "menu")
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(out, dst)
    shutil.rmtree(os.path.join(ROOT, "oled-menu", "test", "out"), ignore_errors=True)
    return dst


def split_frames(tmp):
    """Страница профилей VPN с переключателем «РФ напрямую»: настоящие oled_widgets.c и vpn_menu.sh, svc.sh - заглушка."""
    t = os.path.join(ROOT, "oled-menu", "test")
    src = os.path.join(ROOT, "oled-menu", "src")
    out = os.path.join(tmp, "split")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    svc = os.path.join(out, "svc.sh")
    shutil.copy(os.path.join(t, "vpn", "svc.sh"), svc)
    subprocess.run(["clang", *stand_cflags(src), "-DOLED_CFG_OVERRIDE_DIR=\"/app/hijacks/oled_cfg\"", "-DNATIVE_MENU_ITEM=13",
                    os.path.join(t, "menu", "menu_test.c"), os.path.join(t, "menu", "stubs7.c"),
                    *[os.path.join(src, f) for f in ("oled_widgets.c", "oled_paint.c", "oled_text.c", "oled_orbit.c", "oled_home.c", "oled_home_paint.c")],
                    "-o", os.path.join(out, "menu_test"), "-ldl", "-lpthread"], check=True)
    env = dict(os.environ, HIJ_B=shutil.which("busybox"))
    subprocess.run([os.path.join(out, "menu_test"), src, svc, out, "mmmmp", "s1", "mm", "s2", "p", "s3", "mmm", "s4"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    return [raw_to_image(os.path.join(out, f"{i}.raw")) for i in (1, 2, 3, 4)]


def screens(tmp):
    os.makedirs(IMG, exist_ok=True)
    animation()
    home = home_frames(tmp)
    h = up(raw_to_image(os.path.join(home, "02_megafon.raw")))
    save_png(os.path.join(IMG, "home.png"), h, colors=128)
    menu = menu_frames(tmp)
    names = [f"{i:02d}" for i in range(9)]
    frames = [h] + [up(raw_to_image(os.path.join(menu, n + ".raw"))) for n in names]
    dur = [1800] + [700, 700, 700, 700, 1200, 1800, 900, 900, 1600]
    save_gif(os.path.join(IMG, "menu_walk.gif"), frames, dur)
    fr = split_frames(tmp)
    k = 2
    sheet = Image.new("RGB", (len(fr) * (W * k + 8) - 8, H * k), (64, 64, 64))
    for i, f in enumerate(fr):
        sheet.paste(up(f, k), (i * (W * k + 8), 0))
    save_png(os.path.join(IMG, "menu_split.png"), sheet, colors=64)
    # сырье для шапки
    shutil.copy(os.path.join(IMG, "home.png"), os.path.join(tmp, "home3x.png"))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


PATTERNS = [
    (re.compile(r"\b\d{15}\b"), "15 цифр"),
    (re.compile(r"\+7[ \d-]{10,}"), "номер"),
    (re.compile(r"\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b", re.I), "MAC"),
    (re.compile(r"\b89\d{17,18}\b"), "ICCID"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "адрес"),
]


# Имена своей сети и подписи профилей в файл не пишутся: шаблон задается переменной E5785_SCAN_PRIVATE.
if os.environ.get("E5785_SCAN_PRIVATE"):
    PATTERNS.append((re.compile(os.environ["E5785_SCAN_PRIVATE"], re.I), "свой шаблон"))


def scan_text(name, text):
    """Печатает все, что похоже на личные данные: это повод посмотреть глазами, а не приговор."""
    for rx, what in PATTERNS:
        found = sorted(set(rx.findall(text)))
        if found:
            print(f"  {name}: {what}: {found[:12]}")


def panel(tmp, webui):
    from playwright.sync_api import sync_playwright

    fe = os.path.join(tmp, "frontend")
    shutil.rmtree(fe, ignore_errors=True)
    shutil.copytree(os.path.join(webui, "src", "frontend"), fe)
    subprocess.run([sys.executable, "build.py"], cwd=fe, check=True, stdout=subprocess.DEVNULL)
    port = free_port()
    srv = subprocess.Popen([sys.executable, "dev/server.py", "--port", str(port), "--open"], cwd=fe,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                c = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                c.request("GET", "/")
                c.getresponse().read()
                break
            except OSError:
                time.sleep(0.1)
        with sync_playwright() as p:
            b = p.chromium.launch()
            ctx = b.new_context(viewport={"width": 1280, "height": 860}, color_scheme="dark", device_scale_factor=1)
            page = ctx.new_page()
            page.goto(f"http://127.0.0.1:{port}/")
            page.wait_for_load_state("networkidle")
            # вход на моке: сервер на 127.0.0.1 принимает тестовый пароль
            page.locator('input[type="password"]').fill("admin")
            page.get_by_role("button", name="Войти").click()
            page.wait_for_timeout(1500)
            for name, h, wait in (("panel_home", "home", 7000), ("panel_vpn", "vpn", 1500), ("panel_services", "services", 1500)):
                page.goto(f"http://127.0.0.1:{port}/#/{h}")
                page.wait_for_timeout(wait)
                path = os.path.join(tmp, name + ".png")
                page.screenshot(path=path)
                save_png(os.path.join(IMG, name + ".png"), Image.open(path).convert("RGB"), colors=96)
                scan_text(name, page.inner_text("body"))
                if h == "vpn":
                    # карточка раздельного режима ниже края страницы
                    page.get_by_text("Российские сайты напрямую").first.evaluate("e => e.scrollIntoView({block: 'center'})")
                    page.wait_for_timeout(400)
                    path = os.path.join(tmp, "panel_vpn_split.png")
                    page.screenshot(path=path)
                    save_png(os.path.join(IMG, "panel_vpn_split.png"), Image.open(path).convert("RGB"), colors=96)
            page.goto(f"http://127.0.0.1:{port}/#/speedtest")
            page.wait_for_timeout(1000)
            page.get_by_role("button", name="Начать замер").click()
            frames = []
            for i in range(SPEED_SHOTS):
                page.wait_for_timeout(SPEED_STEP_MS)
                path = os.path.join(tmp, f"speed_{i:02d}.png")
                page.screenshot(path=path, clip=SPEED_CLIP)
                frames.append(Image.open(path).convert("RGB"))
            scan_text("panel_speed", page.inner_text("body"))
            save_png(os.path.join(IMG, "panel_speed.png"), frames[-1], colors=96)
            small = [f.resize((780, 603), Image.LANCZOS) for f in frames]
            save_gif(os.path.join(IMG, "panel_speed.gif"), small, [1000] * (len(small) - 1) + [3000])
            b.close()
    finally:
        srv.terminate()
        srv.wait(5)


HEADER_HTML = """<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Geist; src: url("%(sans)s") format("woff2"); font-weight: 100 900; }
@font-face { font-family: GeistMono; src: url("%(mono)s") format("woff2"); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
body { width: 1280px; height: 640px; background: #000; color: #ededed; font-family: Geist, sans-serif; position: relative; overflow: hidden; }
.t { position: absolute; left: 48px; top: 40px; font-size: 40px; font-weight: 600; letter-spacing: -0.03em; }
.s { position: absolute; left: 48px; top: 94px; font-size: 18px; color: #a1a1a1; }
.dev { position: absolute; left: 48px; top: 152px; width: 402px; height: 402px; border: 1px solid #333; border-radius: 10px; padding: 8px; background: #0a0a0a; }
.dev img { display: block; width: 384px; height: 384px; image-rendering: pixelated; border-radius: 3px; }
.pan { position: absolute; left: 490px; top: 72px; width: 750px; height: 500px; border: 1px solid #333; border-radius: 10px; overflow: hidden; }
.pan img { display: block; width: 750px; }
.c { position: absolute; left: 48px; bottom: 26px; font: 13px GeistMono, monospace; color: #8f8f8f; }
</style>
<div class="t">E5785Lh-23c</div>
<div class="s">Меню экрана, веб-панель, AmneziaWG в ядре</div>
<div class="dev"><img src="%(home)s"></div>
<div class="pan"><img src="%(panel)s"></div>
<div class="c">снимки со стенда и мока с тестовыми данными, не фото</div>
"""


def header(tmp, webui):
    from playwright.sync_api import sync_playwright

    f = os.path.join(webui, "src", "frontend", "fonts")
    names = os.listdir(f)
    sans = next(n for n in names if n.endswith(".woff2") and "ono" not in n)
    mono = next(n for n in names if n.endswith(".woff2") and "ono" in n)
    html = HEADER_HTML % {"sans": "file://" + os.path.join(f, sans), "mono": "file://" + os.path.join(f, mono),
                          "home": "file://" + os.path.join(IMG, "home.png"),
                          "panel": "file://" + os.path.join(IMG, "panel_home.png")}
    path = os.path.join(tmp, "header.html")
    open(path, "w", encoding="utf-8").write(html)
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1280, "height": 640})
        page.goto("file://" + path)
        page.wait_for_timeout(500)
        shot = os.path.join(tmp, "header.png")
        page.screenshot(path=shot)
        b.close()
    save_png(os.path.join(IMG, "header.png"), Image.open(shot).convert("RGB"), colors=128)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--webui", default=os.path.join(ROOT, "webui"))
    ap.add_argument("--only", default="screens,panel,header")
    ap.add_argument("--work", help="рабочий каталог вместо временного")
    a = ap.parse_args()
    tmp = a.work or tempfile.mkdtemp(prefix="e5785-img-")
    os.makedirs(tmp, exist_ok=True)
    only = a.only.split(",")
    if "screens" in only:
        screens(tmp)
    if "panel" in only:
        panel(tmp, a.webui)
    if "header" in only:
        header(tmp, a.webui)
    if not a.work:
        shutil.rmtree(tmp)


if __name__ == "__main__":
    main()
