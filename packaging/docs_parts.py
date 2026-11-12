#!/usr/bin/env python3
"""Раскладка документов по двум PDF комплекта.

Файл из docs/ и README частей либо целиком входит в один PDF, либо делится
по разделам ##. Карта ниже решает, что куда. Команда prepare падает, если в
исходнике появился раздел, которого в карте нет: так ни один раздел не теряется.

Запускается из packaging/build_guide.sh на временной копии комплекта:
части пишутся рядом с исходниками, ссылки переписываются, картинки встраиваются.
"""
import base64
import io
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

F = "e5785lh-23c-features.pdf"
I = "e5785lh-23c-install.pdf"
PDF_DIR = "docs/pdf"
PDF_NAME = {F: "Возможности", I: "Установка"}
COVER = {
    F: ("E5785Lh-23c: возможности",
        "Меню экрана, логотип, VPN, веб-панель, модуль ядра: снимки, статусы, подробности"),
    I: ("E5785Lh-23c: установка",
        "Восстановление, исправление NV, установка частей, сборка, частые проблемы"),
}

# Порядок частей в каждом PDF.
ORDER = {
    F: ["docs/features.md", "docs/oled-menu.md", "game/README.md", "docs/boot-logo.md",
        "docs/vpn.md", "webui/README.md", "kernel-module/README.md", "CREDITS.md"],
    I: ["docs/install.md", "docs/recovery.md", "docs/nv-fix.md", "docs/thermal.md",
        "docs/install-all.md", "docs/oled-menu.md", "docs/boot-logo.md", "webui/README.md",
        "kernel-module/README.md", "docs/troubleshooting.md", "tools/README.md"],
}

# Файлы, разделенные между двумя PDF. intro — куда идет текст до первого ##.
# В другом PDF вместо него стоит lead, заголовок части — title.
SPLIT = {
    "docs/oled-menu.md": {
        "intro": F,
        "sections": {
            "Кнопки": F, "Пункты меню": F, "РФ напрямую": F, "Пункт DNS": F, "Главный экран": F,
            "Вход по SSH": I, "Установка": I, "Откат": I, "Файлы набора": F,
            "Сборка из исходников": I, "Ограничения": F,
        },
        "title": "Меню экрана: установка",
        "lead": "Для владельца E5785Lh-23c с модом bay v5: как поставить и откатить меню на экране "
                "роутера.\n\nНужны: прошивка 21.191.63.02 с модом bay v5 и `modwebui_1.5a` "
                "([восстановление](recovery.md)), вход по SSH.\n\nЧто умеет меню: "
                "[раздел «Пункты меню»](oled-menu.md#пункты-меню). Что ставится на роутер: "
                "[раздел «Файлы набора»](oled-menu.md#файлы-набора). Что учесть после установки: "
                "[раздел «Ограничения»](oled-menu.md#ограничения).",
        "intro_edit": [("что умеет меню на экране роутера, как его поставить и откатить.",
                        "что умеет меню на экране роутера. Как его поставить и откатить: "
                        "[раздел «Установка»](oled-menu.md#установка).")],
    },
    "docs/boot-logo.md": {
        "intro": F,
        "sections": {"Логотип": I, "Анимация": I, "Свои картинки по образцу": F, "Ограничения": I},
        "title": "Логотип и анимация: замена",
        "lead": "Как заменить логотип и анимацию загрузки. Какие это картинки и где они лежат: "
                "часть «Логотип и анимация» в [PDF возможностей](pdf/e5785lh-23c-features.pdf). Как нарисовать новые: "
                "[раздел «Свои картинки по образцу»](boot-logo.md#свои-картинки-по-образцу).",
        "intro_edit": [("Генераторы — [`boot/gen/`](../boot/gen/).",
                        "Генераторы — [`boot/gen/`](../boot/gen/). Как заменить: "
                        "[раздел «Логотип»](boot-logo.md#логотип), [раздел «Анимация»](boot-logo.md#анимация).")],
    },
    "webui/README.md": {
        "intro": F,
        "sections": {
            "Требования": I, "Установка": I, "Откат": I, "Что умеет": F, "Устройство": F,
            "Ограничения": F, "Лицензии и благодарности": F,
        },
        "title": "Веб-панель: установка",
        "lead": "Панель ставится и откатывается одной командой с компьютера. Нужны мод bay v5 и доступ "
                "root по SSH. Что умеет панель: [раздел «Что умеет»](README.md#что-умеет).\n\n"
                "В этой части корень комплекта значит каталог `webui/`: команды выполняйте из него.",
        "intro_edit": [("стоковый интерфейс остается на месте.",
                        "стоковый интерфейс остается на месте. Как поставить: "
                        "[раздел «Установка»](README.md#установка).")],
    },
    "kernel-module/README.md": {
        "intro": F,
        "sections": {
            "Что в каталоге": F, "Варианты": F, "Что проверено": F, "Сборка": I,
            "Через пакет `awg`": I, "Запуск вручную": I, "Ограничения": F,
        },
        "title": "Модуль AmneziaWG: сборка и запуск",
        "lead": "{warning}\n\nЗачем нужен модуль и какой вариант выбрать: [раздел «Варианты»](README.md#варианты). "
                "Результаты проверок: [раздел «Что проверено»](README.md#что-проверено).",
    },
}

# Анимация, которая в PDF превращается в первый кадр и ничего не показывает.
NOT_IN_PDF = {"menu_walk.gif"}

# Какой текст ссылки заменить: подпись-имя файла не значит ничего в PDF.
SHORT = {"recovery": "восстановление", "nv-fix": "исправление NV", "boot-logo": "логотип"}


def pdf_key(pdf):
    return "features" if pdf == F else "install"


def part_path(src, pdf):
    if src not in SPLIT:
        return src
    p = Path(src)
    return str(p.with_name(f"{p.stem}.{pdf_key(pdf)}{p.suffix}"))


def split_file(text):
    """(строка #, вводная, [(заголовок ##, текст раздела)]); ``` учитывается."""
    lines = text.splitlines(keepends=True)
    fence = False
    h1, intro, secs, cur = None, [], [], None
    for ln in lines:
        if ln.lstrip().startswith("```"):
            fence = not fence
        m = None if fence else re.match(r"(#{1,2}) (.+?)\s*$", ln)
        if m and m.group(1) == "#" and h1 is None:
            h1 = m.group(2)
            continue
        if m and m.group(1) == "##":
            cur = [m.group(2), [ln]]
            secs.append(cur)
            continue
        (cur[1] if cur else intro).append(ln)
    return h1, "".join(intro), [(a, "".join(b)) for a, b in secs]


def anchors_of(text, slug_cls):
    """якорь → заголовок раздела ## и заголовок самой строки."""
    slug = slug_cls()
    out = {}
    top = None
    fence = False
    for ln in text.splitlines():
        if ln.lstrip().startswith("```"):
            fence = not fence
        m = None if fence else re.match(r"(#{1,6}) (.+?)\s*$", ln)
        if not m:
            continue
        plain = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", m.group(2)).replace("`", "").replace("*", "")
        if len(m.group(1)) == 2:
            top = m.group(2)
        out[slug(plain.strip())] = (top, plain.strip())
    return out


class Plan:
    def __init__(self):
        from docs_pdf import Slugger
        self.sources = sorted({s for o in ORDER.values() for s in o})
        self.text = {s: Path(s).read_text(encoding="utf-8") for s in self.sources}
        self.parsed = {s: split_file(self.text[s]) for s in self.sources}
        self.anchors = {s: anchors_of(self.text[s], Slugger) for s in self.sources}
        self.whole = {}
        for pdf, srcs in ORDER.items():
            for s in srcs:
                if s not in SPLIT:
                    if s in self.whole:
                        raise SystemExit(f"{s}: один файл в двух PDF, нет в SPLIT")
                    self.whole[s] = pdf

    def check(self):
        bad = []
        for s, m in SPLIT.items():
            have = [h for h, _ in self.parsed[s][2]]
            for h in have:
                if h not in m["sections"]:
                    bad.append(f"{s}: раздел «{h}» не назначен ни в один PDF")
            for h in m["sections"]:
                if h not in have:
                    bad.append(f"{s}: раздела «{h}» нет в файле")
            for pdf in (F, I):
                if s not in ORDER[pdf]:
                    bad.append(f"{s}: нет в порядке {pdf}")
        if bad:
            raise SystemExit("\n".join(bad))

    def table(self):
        rows = []
        for s in self.sources:
            for h, _ in self.parsed[s][2]:
                pdf = SPLIT[s]["sections"][h] if s in SPLIT else self.whole[s]
                rows.append((s, h, pdf))
            if not self.parsed[s][2]:
                rows.append((s, "(весь текст)", self.whole[s]))
            if s in SPLIT:
                rows.append((s, "(вводная)", SPLIT[s]["intro"]))
        return rows

    def part_title(self, src, pdf):
        if src in SPLIT and SPLIT[src]["intro"] != pdf:
            return SPLIT[src]["title"]
        return self.parsed[src][0]

    def where(self, src, frag, pdf):
        """PDF, в котором лежит ссылка на файл src и якорь frag."""
        if src not in SPLIT:
            return self.whole[src]
        if not frag:
            return pdf
        if frag not in self.anchors[src]:
            raise SystemExit(f"{src}: нет якоря #{frag}")
        return SPLIT[src]["sections"][self.anchors[src][frag][0]]

    def rewrite(self, body, src, pdf):
        out_dir = Path(part_path(src, pdf)).parent
        src_dir = Path(src).parent

        def link(m):
            text, href = m.group(1), m.group(2)
            if re.match(r"^[a-z][a-z0-9+.-]*:", href, re.I):
                return m.group(0)
            path, _, frag = href.partition("#")
            path, frag = unquote(path), unquote(frag)
            key = os.path.normpath(src_dir / path) if path else src
            if key not in self.text:
                return m.group(0)
            if frag and frag not in self.anchors[key]:
                raise SystemExit(f"{src}: нет якоря {href}")
            dest = self.where(key, frag, pdf)
            bare = text.strip("`")
            if re.fullmatch(r"[\w./-]+\.md", bare):
                text = self.part_title(key, dest)
            text = SHORT.get(text, text)
            if dest == pdf:
                rel = os.path.relpath(part_path(key, dest), out_dir)
                return f"[{text}]({rel}{'#' + frag if frag else ''})"
            rel = os.path.relpath(f"{PDF_DIR}/{dest}", out_dir)
            if frag:
                top, name = self.anchors[key][frag]
                if name.casefold() != text.casefold() and "раздел" not in text:
                    text = f"{text}, раздел «{name}»"
            return f"[{text}]({rel})"

        res = []
        fence = False
        for ln in body.splitlines(keepends=True):
            if ln.lstrip().startswith("```"):
                fence = not fence
            if not fence:
                ln = re.sub(r"(?<!!)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^()\s]+)\)", link, ln)
            res.append(ln)
        return "".join(res)

    def part_text(self, src, pdf):
        h1, intro, secs = self.parsed[src]
        if src not in SPLIT:
            return self.text[src]
        m = SPLIT[src]
        if m["intro"] == pdf:
            head, lead = h1, intro.strip("\n")
            for old, new in m.get("intro_edit", ()):
                if old not in lead:
                    raise SystemExit(f"{src}: во вводной нет текста «{old}»")
                lead = lead.replace(old, new)
        else:
            warn = next((ln for ln in intro.splitlines() if ln.startswith("> ")), "")
            head, lead = m["title"], m["lead"].replace("{warning}", warn)
        body = "".join(t for h, t in secs if m["sections"][h] == pdf)
        return f"# {head}\n\n{lead}\n\n{body}"

    def write(self):
        for pdf, srcs in ORDER.items():
            for s in srcs:
                Path(part_path(s, pdf)).write_text(
                    self.rewrite(self.part_text(s, pdf), s, pdf), encoding="utf-8")


def embed_images(paths):
    """Сборщик не ограничивает размер картинок: уменьшаем и встраиваем."""
    from PIL import Image
    max_w, max_h = 640, 820

    def embed(base, m):
        if Path(m.group(2)).name in NOT_IN_PDF:
            return ""
        f = (base / m.group(2)).resolve()
        im = Image.open(f).convert("RGB")
        if im.size == (384, 384):       # один экран роутера: вдвое от 128, иначе на всю страницу
            im = im.resize((256, 256), Image.LANCZOS)
        if im.width > max_w or im.height > max_h:
            k = min(max_w / im.width, max_h / im.height)
            im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        return f"![{m.group(1)}](data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()})"

    for p in paths:
        p = Path(p)
        s = p.read_text(encoding="utf-8")
        s = re.sub(r"!\[([^\]]*)\]\(([^)]+\.(?:png|gif))\)", lambda m: embed(p.parent, m), s)
        p.write_text(s, encoding="utf-8")


def images_of(paths):
    out = set()
    for p in paths:
        for m in re.finditer(r"!\[[^\]]*\]\(([^)]+\.(?:png|gif))\)", Path(p).read_text(encoding="utf-8")):
            out.add(os.path.normpath(Path(p).parent / m.group(1)))
    return out


def prepare():
    plan = Plan()
    plan.check()
    plan.write()
    print("раздел → PDF")
    for src, head, pdf in plan.table():
        print(f"  {src} | {head} | {pdf}")
    parts = {pdf: [part_path(s, pdf) for s in srcs] for pdf, srcs in ORDER.items()}
    missing = {str(p) for p in Path("docs/img").iterdir()} - images_of(parts[F])
    if missing:
        raise SystemExit(f"снимков нет в {F}: {sorted(missing)}")
    print(f"картинок: {F} {len(images_of(parts[F]))}, {I} {len(images_of(parts[I]))}: "
          + ", ".join(sorted(Path(x).name for x in images_of(parts[I]))))
    embed_images(p for ps in parts.values() for p in ps)
    Path(PDF_DIR).mkdir(parents=True, exist_ok=True)
    for pdf in ORDER:
        Path(PDF_DIR, pdf).touch()


def build():
    import docs_pdf
    root = docs_pdf.find_root(Path.cwd())
    docs_pdf.use_root(root)
    project = docs_pdf.load_project(root, docs_pdf.find_config(root, None), None)
    bad = False
    for pdf, srcs in ORDER.items():
        title, subtitle = COVER[pdf]
        files = [root / part_path(s, pdf) for s in srcs]
        out = root / PDF_DIR / pdf
        # pdf_of={}: ссылки на файлы рядом с PDF остаются относительными и работают
        b = docs_pdf.Builder(project, files, title=title, subtitle=subtitle, pdf_of={})
        b.rev["commit"] = None          # коммит временной копии читателю ни о чем не говорит
        lines, b_bad = docs_pdf._report(b.build(out))
        print("\n".join(lines))
        bad = bad or b_bad
    return 2 if bad else 0


def verify():
    """Каждый заголовок ## исходников виден в тексте своего PDF."""
    plan = Plan()
    norm = lambda s: re.sub(r"\s+", " ", s.replace("`", "")).casefold()
    text = {}
    for pdf in ORDER:
        text[pdf] = norm(subprocess.run(["pdftotext", "-layout", f"{PDF_DIR}/{pdf}", "-"],
                                        capture_output=True, text=True, check=True).stdout)
    bad = 0
    n = 0
    for src, head, pdf in plan.table():
        if head.startswith("("):
            continue
        n += 1
        if norm(head) not in text[pdf]:
            print(f"нет в PDF: {src} | {head} | {pdf}")
            bad += 1
    for pdf in ORDER:
        if re.search(r"\.(features|install)\.md", text[pdf]):
            print(f"{pdf}: виден служебный файл части")
            bad += 1
    print(f"заголовков проверено: {n}, потеряно: {bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "prepare":
        prepare()
    elif cmd == "build":
        sys.exit(build())
    elif cmd == "verify":
        sys.exit(verify())
    else:
        raise SystemExit("команда: prepare, build или verify")
