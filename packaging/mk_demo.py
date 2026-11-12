#!/usr/bin/env python3
"""Ролик для README: экран роутера, снятый со стендов, с подписями. Результат: docs/img/demo.gif.

Запуск из корня комплекта:
    python3 packaging/mk_demo.py

Кадры рисует настоящий код меню (oled-menu/src) на компьютере: стенд главного экрана test/home
и стенд меню test/dns, в котором пункт VPN отвечает заглушкой test/vpn/svc.sh. Данные выдуманные.
Нужны те же программы, что для mk_images.py: clang с ASan и UBSan, bwrap, busybox, Pillow.
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mk_images as mi  # noqa: E402

ROOT = mi.ROOT
K = 3                      # масштаб экрана 128x128
CAP_H = 64                 # полоса подписи
BG = (18, 18, 18)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

# Сценарий меню: (кнопка или "", снимать ли кадр, длительность мс, подпись).
# m - MENU (следующий пункт), p - POWER (выбрать).
MENU_CAP = "MENU — дальше, POWER — выбрать"
MODE_CAP = "Режим сети: 4G, 3G или авто"
VPN_CAP = "VPN AmneziaWG прямо в роутере"
SPLIT_CAP = "«РФ напрямую»: сайты РФ мимо VPN"
PROF_CAP = "Профили VPN переключаются кнопкой"
DNS_CAP = "Шифрованный DNS: DoH и DoT"
ADS_CAP = "Блокировка рекламы через DNS"

SCENARIO = [
    ("", 1300, MENU_CAP)] + [("m", 330, MENU_CAP)] * 14 + [
    # «Назад» -> «Режим сети»
    ("m", 330, MODE_CAP), ("m", 330, MODE_CAP), ("m", 330, MODE_CAP), ("m", 700, MODE_CAP),
    ("p", 1300, MODE_CAP), ("m", 400, MODE_CAP), ("m", 400, MODE_CAP), ("m", 400, MODE_CAP), ("m", 400, MODE_CAP),
    ("m", 500, MODE_CAP), ("p", 600, MENU_CAP),
    # «Режим сети» -> «VPN»: включен, «РФ напрямую», смена профиля
    ("m", 800, VPN_CAP), ("p", 2400, VPN_CAP), ("m", 500, VPN_CAP),
    ("m", 1600, SPLIT_CAP), ("p", 1000, SPLIT_CAP), ("m", 400, SPLIT_CAP), ("m", 2200, SPLIT_CAP),
    ("m", 600, PROF_CAP), ("m", 1000, PROF_CAP), ("p", 2400, PROF_CAP),
    # назад в меню, затем DNS
    ("p", 600, MENU_CAP), ("m", 800, DNS_CAP), ("p", 2000, DNS_CAP),
    ("m", 400, DNS_CAP), ("m", 400, DNS_CAP), ("m", 900, DNS_CAP), ("m", 500, DNS_CAP), ("m", 500, DNS_CAP),
    ("m", 500, DNS_CAP), ("m", 1000, DNS_CAP), ("p", 1200, DNS_CAP), ("m", 700, DNS_CAP), ("p", 2400, DNS_CAP),
    ("m", 500, ADS_CAP), ("m", 1800, ADS_CAP),
]


def font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default()


def card(screen, caption):
    """Экран 128x128 -> кадр с подписью снизу."""
    w = 128 * K + 32
    im = Image.new("RGB", (w, 128 * K + 32 + CAP_H), BG)
    im.paste(screen.convert("RGB").resize((128 * K, 128 * K), Image.NEAREST), (16, 16))
    d = ImageDraw.Draw(im)
    size = 22
    f = font(size)
    while d.textlength(caption, font=f) > w - 24 and size > 12:
        size -= 1
        f = font(size)
    tw = d.textlength(caption, font=f)
    d.text(((w - tw) / 2, 128 * K + 32 + (CAP_H - 24) / 2), caption, font=f, fill=(235, 235, 235))
    return im


def menu_run(tmp):
    """Прогон сценария на стенде test/dns с заглушкой VPN; кадр после каждого шага."""
    t = os.path.join(ROOT, "oled-menu", "test", "dns")
    run = os.path.join(tmp, "run_demo.sh")
    src = open(os.path.join(t, "run.sh")).read()
    src = src.replace('T=$(cd "$(dirname "$0")" && pwd)', 'T=' + t)
    src = src.replace('mkdir -p "$OUT/png"', 'mkdir -p "$OUT/png"; cp "$T/../vpn/svc.sh" "$OUT/vsvc.sh"; '
                      'echo 1 > "$OUT/running"; echo 0 > "$OUT/split"; echo awg2 > "$OUT/active"')
    src = src.replace("/nonexistent/svc.sh", '"$0"/vsvc.sh')
    open(run, "w").write(src)
    args = []
    for i, (key, _, _) in enumerate(SCENARIO):
        if key:
            args.append(key)
        args.append(f"s{i:03d}")
    subprocess.run(["bash", run, *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    out = os.path.join(ROOT, "oled-menu", "test", "out", "dns", "png")
    frames = [mi.raw_to_image(os.path.join(out, f"{i:03d}.raw")) for i in range(len(SCENARIO))]
    shutil.rmtree(os.path.join(ROOT, "oled-menu", "test", "out"), ignore_errors=True)
    return frames


def main():
    frames, dur = [], []
    tmp = tempfile.mkdtemp(prefix="demo_")
    try:
        # главный экран
        home = mi.home_frames(tmp)
        for name, cap, t in (("02_megafon.raw", "Главный экран: сеть, сигнал, заряд", 2600),
                             ("34_band_extpower.raw", "Диапазон LTE и питание", 2000),
                             ("35_vpn_green.raw", "Значок VPN на главном экране", 2400)):
            frames.append(card(mi.raw_to_image(os.path.join(home, name)), cap))
            dur.append(t)
        # меню
        for im, (_, t, cap) in zip(menu_run(tmp), SCENARIO):
            frames.append(card(im, cap))
            dur.append(t)
        # игра
        g = Image.open(os.path.join(ROOT, "game", "preview", "orbit_autopilot.gif"))
        n = getattr(g, "n_frames", 1)
        acc = 0
        for i in range(0, min(n, 110), 2):
            g.seek(i)
            frames.append(card(g.convert("RGB").resize((128, 128), Image.LANCZOS), "И игра «Орбита» в меню"))
            t = g.info.get("duration", 55) * 2
            dur.append(t)
            acc += t
        # заставка при включении
        d = os.path.join(ROOT, "boot", "anim")
        names = sorted(n for n in os.listdir(d) if n.startswith("poehali4_") and n.endswith(".png"))
        ms = [int(x) for x in open(os.path.join(d, "durations")).read().split()]
        for n, t in zip(names, ms):
            frames.append(card(Image.open(os.path.join(d, n)).resize((128, 128), Image.LANCZOS), "Своя заставка при включении"))
            dur.append(t)
        dur[-1] = 1500
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    pal = [f.convert("P", palette=Image.ADAPTIVE, colors=128) for f in frames]
    path = os.path.join(mi.IMG, "demo.gif")
    pal[0].save(path, save_all=True, append_images=pal[1:], duration=dur, loop=0, optimize=True, disposal=1)
    print(f"demo.gif: {len(frames)} кадров, {sum(dur) / 1000:.1f} с, {os.path.getsize(path)} Б")


if __name__ == "__main__":
    main()
