#!/usr/bin/env python3
"""PDF из Markdown-документации любого репозитория: Markdown → HTML → WeasyPrint.

Запуск из корня репозитория (в репозиторий пишутся только PDF):
    docs_pdf.py                                 # весь комплект, по умолчанию в docs/pdf
    docs_pdf.py --only 1-hub                    # часть комплекта
    docs_pdf.py README.md -o /tmp/readme.pdf    # один файл
    docs_pdf.py docs/a.md docs/b.md --title "Установка" -o /tmp/setup.pdf

Настройки проекта — TOML (формат — pdf/README.md): --config ПУТЬ, иначе
docs/pdf.toml в репозитории, иначе projects/<имя каталога репозитория>.toml
рядом со сборщиком.  Без настроек продукт — H1 из README.md или имя каталога,
комплект — README.md и каждый .md из docs/.

Комплект (--set): каждый документ — отдельный PDF, раскладка по папкам — из
настроек.  Ссылка на документ комплекта ведет в соседний PDF (на раздел —
по якорю внутри него), на прочие файлы репозитория — относительным путем от
PDF.  Markdown в docs/, которого нет ни в раскладке, ни в not_in_set, дает
замечание (с --strict — ошибку).

Несколько файлов без --set собираются в один PDF: каждый файл — часть со
своим H1, ссылки между ними становятся внутренними.  Флаги: --html
(сохранить промежуточный HTML), --strict (код 2 при предупреждениях
WeasyPrint, вылезающих за поле строках, битых якорях), --repo-url (ссылки на
другие файлы репозитория сделать кликабельными).

Что делает конвейер с Markdown (сам файл не меняется):
  * H1 уходит на обложку, раздел «Содержание» из Markdown заменяется
    сгенерированным оглавлением с номерами страниц; текст до первого H2
    становится разделом «О документе»;
  * якоря заголовков считаются как на GitHub, поэтому ссылки `(#якорь)`
    из Markdown работают в PDF;
  * ссылка на файл, не вошедший в сборку, становится текстом с путем от
    корня репозитория и названием раздела: «docs/admin.md, раздел
    «Резервные копии»»; название берется из заголовков файла-цели, битый якорь
    попадает в предупреждения;
  * блок кода без языка с псевдографикой (─│┌►▲ и т. п.) — схема: строки не
    переносятся, кегль уменьшается под ширину поля; ► ◄ заменяются на ▶ ◀
    (первых нет в Geist Mono, а fallback-шрифт сдвигает рамки);
  * остальной код: кегль уменьшается до CODE_MIN_PT, более длинные строки
    переносятся с маркером ↳;
  * эмодзи вырезаются; цитата, начинающаяся с ⚠️, становится предупреждением.

Дата редакции на обложке — дата последнего git-коммита исходного файла,
а не время сборки; если в рабочей копии есть правки, это видно на обложке.

Зависимости: python3 >= 3.11 (tomllib), weasyprint >= 61 (тянет fonttools с
brotli для woff2 и pyphen для переносов), markdown-it-py >= 3.  Шрифты Geist /
Geist Mono (OFL 1.1) — docs_pdf/fonts, стили — docs_pdf/style.css рядом со
сборщиком.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import logging
import math
import os
import re
import subprocess
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "docs_pdf"
PROJECTS = HERE / "projects"            # настройки проектов: <имя каталога репо>.toml
STYLE = ASSETS / "style.css"
FONT_DIR = ASSETS / "fonts"
FONT_SANS = FONT_DIR / "Geist-Variable.woff2"
FONT_MONO = FONT_DIR / "GeistMono-Variable.woff2"

# Корень репозитория: git-корень текущего каталога (use_root в main и в
# процессах -j).  От него считаются пути в настройках и в текстах ссылок.
ROOT = Path.cwd()
DOC_SET = "Документация"
INTRO_TITLE = "О документе"
TOC_TITLE = "Содержание"

# --- геометрия страницы; style.css берет поля отсюда (см. page_css) --------
MM = 72 / 25.4                      # pt в миллиметре
PAGE_W_MM = 210
MARGIN_MM = {"top": 25, "right": 20, "bottom": 21, "left": 22}
TEXT_W_PT = (PAGE_W_MM - MARGIN_MM["left"] - MARGIN_MM["right"]) * MM
# Отступы блоков — те же числа, что в style.css (pre, ul/ol, blockquote).
PRE_PAD_X_PT = 7.0
PRE_BORDER_PT = 0.5
LIST_INDENT_PT = 6 * MM
BQ_INDENT_PT = 2.0 + 10.0           # border-left + padding-left
MONO_ADVANCE = 0.6                  # ширина знака Geist Mono, em (600/1000)
CODE_PT = 8.2
CODE_MIN_PT = 6.8
DIAGRAM_MIN_PT = 5.0
LONG_BLOCK_LINES = 30               # длиннее — блоку кода разрешено рваться
WRAP_MARK = "↳"
WRAP_MIN_TAIL = 12                  # не оставлять на строке-продолжении огрызок короче
CODE_BREAK_AFTER = set("_./=,:{(|")   # точки переноса в длинном `коде` в таблицах

BOX_CHARS = re.compile("[─-╿▀-▟▲▶►▼◀◄]")
GLYPH_MAP = str.maketrans({"►": "▶", "◄": "◀"})
EMOJI = re.compile("[\U0001f000-\U0001faff️‍⚠⛔❗❌✅❓⭐⚡]")
CALLOUT_WARN = set("⚠⛔❗❌🚫🔥")
CALLOUT_NOTE = set("ℹ💡📝📌✅")
TOC_HEADINGS = {"содержание", "оглавление", "contents", "table of contents"}
MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля",
          "августа", "сентября", "октября", "ноября", "декабря")

log = logging.getLogger("docs_pdf")

# --------------------------------------------------------------------------
# Настройки проекта
# --------------------------------------------------------------------------

@dataclass
class Project:
    """Настройки комплекта: из TOML или по умолчанию (config is None)."""
    root: Path
    product: str
    out_dir: Path                                   # каталог комплекта
    skip: tuple[Path, ...]                          # каталоги PDF: их .md не исходники
    # раскладка: (папка в out_dir, подпись, исходники от корня); цифра в
    # имени папки задает порядок
    layout: list[tuple[str, str, list[str]]]
    not_in_set: dict[str, str]                      # шаблон пути → почему не в комплекте
    doc_set: str = DOC_SET
    version: str | None = None
    repo_url: str | None = None
    config: Path | None = None


CONFIG_KEYS = {"product", "out_dir", "doc_set", "version", "repo_url", "layout", "not_in_set"}
LAYOUT_KEYS = {"dir", "label", "files"}


def use_root(root: Path) -> None:
    global ROOT
    ROOT = root.resolve()


def find_root(start: Path) -> Path:
    """git-корень каталога start; вне git — сам start."""
    try:
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=start,
                           capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError):
        return start.resolve()
    top = r.stdout.strip()
    return Path(top).resolve() if r.returncode == 0 and top else start.resolve()


def find_config(root: Path, arg: Path | None) -> Path | None:
    """--config, иначе docs/pdf.toml в репозитории, иначе projects/<имя корня>.toml."""
    if arg is not None:
        if not arg.is_file():
            raise SystemExit(f"docs_pdf: нет файла настроек {arg}")
        return arg.resolve()
    for p in (root / "docs" / "pdf.toml", PROJECTS / f"{root.name}.toml"):
        if p.is_file():
            return p
    return None


def readme_product(root: Path) -> str | None:
    """Короткое название из H1 README.md: «proxy» из «# proxy», «Шлюз» из
    «# Шлюз — доступ к серверам».  Длинный H1 не годится в колонтитул — None."""
    readme = root / "README.md"
    if not readme.is_file():
        return None
    fence = False
    for line in readme.read_text(encoding="utf-8").splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
        m = None if fence else re.match(r"#\s+(.+?)\s*#*\s*$", line)
        if m:
            name = re.split(r"\s+[—–-]\s+|:\s", m.group(1).replace("`", ""), maxsplit=1)[0].strip()
            return name if 0 < len(name) <= 40 else None
    return None


def auto_layout(root: Path, skip: tuple[Path, ...],
                not_in_set: dict[str, str]) -> list[tuple[str, str, list[str]]]:
    """Комплект без раскладки: README.md и каждый .md из docs/ (подкаталоги
    docs/ — папками комплекта), кроме not_in_set и каталогов PDF (skip)."""
    from fnmatch import fnmatch
    groups: dict[str, list[str]] = {}
    if (root / "README.md").is_file():
        groups[""] = ["README.md"]
    for p in sorted((root / "docs").rglob("*.md")):
        if any(p.resolve().is_relative_to(s) for s in skip):
            continue
        rel = p.relative_to(root).as_posix()
        if any(fnmatch(rel, pat) for pat in not_in_set):
            continue
        folder = p.parent.relative_to(root / "docs").as_posix()
        groups.setdefault("" if folder == "." else folder, []).append(rel)
    return [(folder, "", rels) for folder, rels in groups.items()]


def load_project(root: Path, config: Path | None, out_dir: Path | None = None) -> Project:
    """Настройки из TOML (config) или по умолчанию; out_dir — --out-dir."""
    data: dict = {}
    if config is not None:
        import tomllib
        try:
            data = tomllib.loads(config.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError) as exc:
            raise SystemExit(f"docs_pdf: {config}: {exc}")
    where = str(config)

    def bad(msg: str) -> SystemExit:
        return SystemExit(f"docs_pdf: {where}: {msg}")

    extra = set(data) - CONFIG_KEYS
    if extra:
        raise bad(f"неизвестные ключи {', '.join(sorted(extra))} "
                  f"(есть: {', '.join(sorted(CONFIG_KEYS))})")
    for key in ("product", "out_dir", "doc_set", "version", "repo_url"):
        if key in data and not (isinstance(data[key], str) and data[key].strip()):
            raise bad(f"{key} — непустая строка")
    not_in_set = data.get("not_in_set", {})
    if not isinstance(not_in_set, dict) or not all(isinstance(v, str) for v in not_in_set.values()):
        raise bad('not_in_set — таблица «"шаблон пути" = "причина"»')
    set_dir = root / data.get("out_dir", "docs/pdf")
    out_dir = out_dir or set_dir
    skip = (set_dir.resolve(), out_dir.resolve())
    layout: list[tuple[str, str, list[str]]] = []
    for k, item in enumerate(data.get("layout", []), 1):
        if not isinstance(item, dict) or set(item) - LAYOUT_KEYS or "files" not in item:
            raise bad(f"layout #{k}: нужны ключи dir, files (и необязательно label)")
        files = item["files"]
        if not (isinstance(files, list) and files and all(isinstance(f, str) for f in files)):
            raise bad(f"layout #{k}: files — непустой список путей от корня репозитория")
        layout.append((str(item.get("dir", "")).strip("/"), str(item.get("label", "")), files))
    if not layout:
        layout = auto_layout(root, skip, not_in_set)
    return Project(
        root=root, product=data.get("product") or readme_product(root) or root.name,
        out_dir=out_dir, skip=skip, layout=layout, not_in_set=not_in_set,
        doc_set=data.get("doc_set", DOC_SET), version=data.get("version"),
        repo_url=data.get("repo_url"), config=config)


def pdf_name(rel: str) -> str:
    """docs/admin.md → admin.pdf; deploy/exabgp/README.md → exabgp.pdf."""
    p = Path(rel)
    if p.stem == "README" and p.parent != Path("."):
        return p.parent.name + ".pdf"
    return p.stem + ".pdf"


def layout_map(project: Project) -> dict[Path, Path]:
    """Исходник (абсолютный путь) → его PDF в комплекте."""
    out_dir = project.out_dir.resolve()
    return {(ROOT / rel).resolve(): out_dir / folder / pdf_name(rel)
            for folder, _, rels in project.layout for rel in rels}


def check_layout(project: Project) -> list[str]:
    """Каждый Markdown в docs/ — в раскладке или в not_in_set; файлы раскладки
    существуют, имена PDF не совпадают."""
    from fnmatch import fnmatch
    problems: list[str] = []
    seen: set[str] = set()
    pdfs: dict[str, str] = {}
    for folder, _, rels in project.layout:
        for rel in rels:
            if rel in seen:
                problems.append(f"раскладка: {rel} дважды")
            seen.add(rel)
            if not (ROOT / rel).is_file():
                problems.append(f"раскладка: нет файла {rel}")
            out = f"{folder}/{pdf_name(rel)}".lstrip("/")
            if out in pdfs:
                problems.append(f"раскладка: {rel} и {pdfs[out]} дают один {out}")
            pdfs[out] = rel
    for p in sorted((ROOT / "docs").rglob("*.md")):
        rel = repo_rel(p)
        if rel in seen or any(p.resolve().is_relative_to(s) for s in project.skip):
            continue
        if not any(fnmatch(rel, pat) for pat in project.not_in_set):
            problems.append(f"{rel}: нет ни в layout, ни в not_in_set ({project.config})")
    return problems


# --------------------------------------------------------------------------
# Якоря как на GitHub
# --------------------------------------------------------------------------

def github_slug(text: str) -> str:
    """Якорь заголовка по правилам GitHub (github-slugger): нижний регистр,
    остаются буквы, цифры, `_`, `-` и пробелы, пробел → `-`."""
    out = []
    for ch in text.lower():
        cat = unicodedata.category(ch)
        if ch == " ":
            out.append("-")
        elif ch in "-_" or cat[0] in "LMN":
            out.append(ch)
    return "".join(out)


TRANSLIT = dict(zip(
    "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "j", "k", "l", "m", "n",
     "o", "p", "r", "s", "t", "u", "f", "h", "c", "ch", "sh", "sch", "", "y", "",
     "e", "yu", "ya"]))


def ascii_id(name: str) -> str:
    """id внутри PDF латиницей: ссылка «файл.pdf#раздел» из соседнего PDF
    работает в любом просмотрщике, кириллица в именах назначений — нет."""
    s = "".join(TRANSLIT.get(c, c) for c in name.lower())
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9_-]", "", s) or "s"


class Slugger:
    def __init__(self) -> None:
        self.seen: dict[str, int] = {}

    def __call__(self, text: str) -> str:
        base = github_slug(text)
        n = self.seen.get(base)
        if n is None:
            self.seen[base] = 0
            return base
        while True:
            n += 1
            cand = f"{base}-{n}"
            if cand not in self.seen:
                self.seen[base] = n
                self.seen[cand] = 0
                return cand


_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_COMMENT = re.compile(r"<!--.*?-->", re.S)


def strip_comments(md_text: str) -> str:
    """Убрать комментарии <!-- --> вне блоков кода: это заметки для писателей,
    а парсер с выключенным HTML выводит их обычным текстом. Переводы строк
    внутри комментария остаются, чтобы номера строк в замечаниях не сдвигались."""
    out, chunk, fence = [], [], None
    def flush() -> None:
        out.append(_COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), "".join(chunk)))
        chunk.clear()
    for line in md_text.splitlines(keepends=True):
        m = _FENCE.match(line)
        if fence is None and m:
            flush(); fence = m.group(1)[0] * len(m.group(1)); out.append(line)
        elif fence is not None:
            out.append(line)
            if line.strip().startswith(fence) and line.strip().strip(fence[0]) == "":
                fence = None
        else:
            chunk.append(line)
    flush()
    return "".join(out)


def heading_slugs(md_text: str) -> dict[str, str]:
    """slug или явный якорь <a id> → текст заголовка для файла-цели внешней
    ссылки. Якорь отдельным абзацем перед заголовком — имя этого заголовка,
    якорь в тексте — имя раздела, где он стоит."""
    md = make_parser()
    tokens = md.parse(strip_comments(md_text))
    slug = Slugger()
    out: dict[str, str] = {}
    current = ""
    for i, t in enumerate(tokens):
        if t.type == "heading_open":
            current = inline_text(tokens[i + 1].children).strip()
            out[slug(current)] = current
        elif t.type == "inline":
            ids = [c.meta["id"] for c in t.children or () if c.type == "html_anchor"]
            h = lone_anchor_heading(tokens, i - 1) if ids else None
            name = inline_text(tokens[h + 1].children).strip() if h is not None else current
            for a in ids:
                out.setdefault(a, name)
    return out


# --------------------------------------------------------------------------
# Markdown
# --------------------------------------------------------------------------

def make_parser():
    from markdown_it import MarkdownIt
    md = MarkdownIt("commonmark", {"html": False, "linkify": False,
                                   "typographer": False}).enable(["table", "strikethrough"])
    md.inline.ruler.before("html_inline", "html_lite", _html_lite)
    return md


# Сырой HTML в доках — два тега: пустой якорь <a id="…"></a> (цель ссылок
# #cfg-… и т. п.) и <br> в ячейке таблицы. Их и только их парсер понимает;
# html в целом выключен, иначе пропали бы плейсхолдеры вида <asn>, <id>.
_HTML_LITE = re.compile(r'<a\s+(?:id|name)="([^"<>\s]+)"\s*>\s*</a>|<br\s*/?>', re.I)


def _html_lite(state, silent: bool) -> bool:
    if state.src[state.pos] != "<":
        return False
    m = _HTML_LITE.match(state.src, state.pos, state.posMax)
    if not m:
        return False
    if not silent:
        if m.group(1) is None:
            state.push("hardbreak", "br", 0)
        else:
            state.push("html_anchor", "", 0).meta = {"id": m.group(1)}
    state.pos = m.end()
    return True


def lone_anchor_heading(tokens, i: int) -> int | None:
    """Абзац tokens[i] состоит только из якорей <a id>, а следом идет заголовок —
    индекс этого заголовка. Такой якорь — второе имя заголовка."""
    if not (tokens[i].type == "paragraph_open" and i + 3 < len(tokens)
            and tokens[i + 3].type == "heading_open"):
        return None
    kids = tokens[i + 1].children or []
    ok = all(c.type in ("html_anchor", "softbreak")
             or (c.type == "text" and not c.content.strip()) for c in kids)
    return i + 3 if ok and any(c.type == "html_anchor" for c in kids) else None


def inline_text(children) -> str:
    out = []
    for t in children or ():
        if t.type in ("text", "code_inline"):
            out.append(t.content)
        elif t.type in ("softbreak", "hardbreak"):
            out.append(" ")
        elif t.type == "image":
            out.append(inline_text(t.children))
        elif t.type == "xref":
            out.append(inline_text(t.meta["inner"]))
    return "".join(out)


def display_width(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else
               0 if unicodedata.combining(c) else 1 for c in s)


def is_diagram(lang: str, body: str) -> bool:
    if lang in ("ascii", "diagram"):
        return True
    return lang in ("", "text", "txt", "plain") and bool(BOX_CHARS.search(body))


def comment_start(line: str, lang: str) -> int | None:
    """Позиция начала комментария `#` (или `!` в начале строки для IOS)."""
    if lang in ("json", "diff"):
        return None
    stripped = line.lstrip()
    if stripped.startswith("!") and lang in ("", "text", "conf", "cisco"):
        return len(line) - len(stripped)
    quote = None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            return i
    return None


def wrap_spans(line: str, cols: int) -> list[tuple[int, int]]:
    """Режет строку кода на куски по cols знаков (продолжения — на
    cols-indent-2, с маркером).  Рвет по пробелу, если он не слишком рано."""
    if display_width(line) <= cols:
        return [(0, len(line))]
    indent = len(line) - len(line.lstrip(" "))
    indent = min(indent, cols // 3)
    spans = []
    start, width = 0, cols
    while True:
        rest = line[start:]
        if display_width(rest) <= width:
            spans.append((start, len(line)))
            return spans
        cut = width
        spaces = [k for k in range(int(width * 0.55), width + 1) if rest[k] == " "]
        good = [k for k in spaces if len(rest) - k - 1 >= WRAP_MIN_TAIL]
        if good or spaces:
            cut = (good or spaces)[-1] + 1
        spans.append((start, start + cut))
        start += cut
        while start < len(line) and line[start] == " ":
            start += 1
        if start >= len(line):
            return spans
        width = cols - indent - 2


def render_code_lines(lines: list[str], lang: str, cols: int | None) -> tuple[str, int]:
    """HTML тела блока кода; второй элемент — число перенесенных строк."""
    out, wrapped = [], 0
    for line in lines:
        cpos = comment_start(line, lang)
        spans = wrap_spans(line, cols) if cols else [(0, len(line))]
        if len(spans) > 1:
            wrapped += 1
        indent = min(len(line) - len(line.lstrip(" ")), (cols or 0) // 3)
        for k, (s, e) in enumerate(spans):
            piece = []
            if k:
                piece.append(" " * indent + f'<span class="wrap">{WRAP_MARK} </span>')
            if cpos is None or cpos >= e:
                piece.append(html.escape(line[s:e], quote=False))
            elif cpos <= s:
                piece.append(f'<span class="c">{html.escape(line[s:e], quote=False)}</span>')
            else:
                piece.append(html.escape(line[s:cpos], quote=False))
                piece.append(f'<span class="c">{html.escape(line[cpos:e], quote=False)}</span>')
            out.append("".join(piece))
    return "\n".join(out), wrapped


# --------------------------------------------------------------------------
# Документ
# --------------------------------------------------------------------------

@dataclass
class Heading:
    level: int
    text: str
    anchor: str


@dataclass
class Doc:
    path: Path
    idx: int
    tokens: list = field(default_factory=list)
    title: str = ""
    headings: list[Heading] = field(default_factory=list)
    slugs: dict[str, str] = field(default_factory=dict)   # slug → anchor
    used: set[str] = field(default_factory=set)

    @property
    def prefix(self) -> str:
        return f"d{self.idx}-"

    def new_anchor(self, name: str) -> str:
        """Уникальный в документе id латиницей для slug или <a id>."""
        base = a = self.prefix + ascii_id(name)
        n = 1
        while a in self.used:
            n += 1
            a = f"{base}-{n}"
        self.used.add(a)
        return a

    @property
    def rel(self) -> str:
        return repo_rel(self.path)


def repo_rel(p: Path) -> str:
    try:
        return p.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return p.as_posix()


@dataclass
class BuildResult:
    pdf: Path
    pages: int
    title: str
    revision: str
    toc: list[Heading]
    bookmarks: list[tuple[int, str]]
    warnings: list[str]
    overflows: list[str]
    notes: list[str]


class Builder:
    def __init__(self, project: Project, sources: list[Path], *, title: str | None = None,
                 subtitle: str | None = None, pdf_of: dict[Path, Path] | None = None) -> None:
        self.project = project
        self.sources = [Path(s).resolve() for s in sources]
        self.single = len(self.sources) == 1
        self.title_arg, self.subtitle_arg = title, subtitle
        self.repo_url = project.repo_url.rstrip("/") if project.repo_url else None
        # Комплект: ссылка на документ из него ведет в соседний PDF, на прочие
        # файлы репозитория — относительным путем от PDF.
        self.pdf_of = pdf_of
        self.set_root = Path(os.path.commonpath([str(p.parent) for p in pdf_of.values()])) \
            if pdf_of else None
        self.out: Path | None = None
        self._pdf_anchor_cache: dict[Path, dict[str, str]] = {}
        self.md = make_parser()
        self.md.add_render_rule("fence", _render_fence)
        self.md.add_render_rule("code_block", _render_fence)
        self.md.add_render_rule("xref", _render_xref)
        self.md.add_render_rule("html_anchor", _render_anchor)
        self.md.add_render_rule("code_inline", _render_code_inline)
        self.docs: list[Doc] = []
        self.notes: list[str] = []          # битые ссылки, перенос кода и т. п.
        self._target_cache: dict[Path, dict[str, str] | None] = {}
        self.rev = revision(self.sources)

    # ---- разбор ---------------------------------------------------------

    def parse(self) -> None:
        for i, src in enumerate(self.sources, 1):
            doc = Doc(src, i)
            doc.used.update((doc.prefix + "top", doc.prefix + "intro"))
            doc.tokens = self.md.parse(strip_comments(src.read_text(encoding="utf-8")))
            self._headings(doc)
            self._anchors(doc)
            self.docs.append(doc)
        for doc in self.docs:
            self._strip_md_toc(doc)
            if self.single:
                self._intro(doc)
            self._drop_rules(doc)
            self._blocks(doc)
            self._inlines(doc)

    def _headings(self, doc: Doc) -> None:
        slug = Slugger()
        toks = doc.tokens
        for i, t in enumerate(toks):
            if t.type != "heading_open":
                continue
            text = inline_text(toks[i + 1].children).strip()
            s = slug(text)
            anchor = doc.new_anchor(s)
            t.attrSet("id", anchor)
            level = int(t.tag[1])
            if level == 2:
                t.attrSet("data-running", _short(text, 64))
            doc.slugs[s] = anchor
            doc.headings.append(Heading(level, text, anchor))
            if level == 1 and not doc.title:
                doc.title = text
        if not doc.title:
            doc.title = doc.path.stem

    def _anchors(self, doc: Doc) -> None:
        """Явные якоря <a id="x">: ссылка #x ведет туда же, куда в GitHub.
        Якорь отдельным абзацем перед заголовком становится вторым именем
        заголовка (абзац убирается — пустой <p> дал бы лишний отступ), якорь
        в тексте остается пустым <a> с префиксованным id на своем месте."""
        toks = doc.tokens
        drop: set[int] = set()
        for i, t in enumerate(toks):
            if t.type != "inline":
                continue
            kids = [c for c in t.children or () if c.type == "html_anchor"]
            if not kids:
                continue
            h = lone_anchor_heading(toks, i - 1)
            for c in kids:
                name = c.meta["id"]
                if h is not None and doc.slugs.get(name) == toks[h].attrGet("id"):
                    continue    # <a id> повторяет slug своего же заголовка
                if name in doc.slugs:
                    self.notes.append(f"{doc.rel}: якорь <a id=\"{name}\"> совпадает "
                                      f"с другим якорем или заголовком")
                    continue
                if h is not None:
                    doc.slugs[name] = toks[h].attrGet("id")
                else:
                    c.meta["anchor"] = doc.new_anchor(name)
                    doc.slugs[name] = c.meta["anchor"]
            if h is not None:
                drop.update((i - 1, i, i + 1))
        if drop:
            doc.tokens = [t for k, t in enumerate(toks) if k not in drop]

    def _strip_md_toc(self, doc: Doc) -> None:
        toks = doc.tokens
        for i, t in enumerate(toks):
            if t.type == "heading_open" and t.tag == "h2" and \
                    inline_text(toks[i + 1].children).strip().lower() in TOC_HEADINGS:
                j = i + 3
                while j < len(toks) and not (toks[j].type == "heading_open" and toks[j].tag in ("h1", "h2")):
                    j += 1
                hrefs = [c.attrGet("href") or "" for tk in toks[i + 3:j] if tk.type == "inline"
                         for c in tk.children or () if c.type == "link_open"]
                if hrefs and all(h.startswith("#") for h in hrefs):
                    anchor = t.attrGet("id")
                    del toks[i:j]
                    doc.headings = [h for h in doc.headings if h.anchor != anchor]
                return

    def _intro(self, doc: Doc) -> None:
        """Одиночный документ: H1 — на обложку, текст до первого H2 — «О документе»."""
        from markdown_it.token import Token
        toks = doc.tokens
        if not toks or toks[0].type != "heading_open" or toks[0].tag != "h1":
            return
        h1_anchor = toks[0].attrGet("id")
        del toks[0:3]
        doc.headings = [h for h in doc.headings if h.anchor != h1_anchor]
        first_h2 = next((k for k, t in enumerate(toks) if t.type == "heading_open"), len(toks))
        if any(t.type != "hr" for t in toks[:first_h2]):
            anchor = doc.prefix + "intro"
            ho = Token("heading_open", "h2", 1, block=True, markup="##")
            ho.attrSet("id", anchor)
            ho.attrSet("data-running", INTRO_TITLE)
            ho.attrSet("class", "intro")
            inl = Token("inline", "", 0, content=INTRO_TITLE,
                        children=[Token("text", "", 0, content=INTRO_TITLE)])
            hc = Token("heading_close", "h2", -1, block=True, markup="##")
            toks[0:0] = [ho, inl, hc]
            doc.headings.insert(0, Heading(2, INTRO_TITLE, anchor))

    def _drop_rules(self, doc: Doc) -> None:
        """`---` перед H1/H2 (они и так с новой страницы) и в конце — лишние."""
        toks = doc.tokens
        keep = []
        for i, t in enumerate(toks):
            if t.type == "hr":
                nxt = next((x for x in toks[i + 1:] if x.type != "hr"), None)
                if nxt is None or (nxt.type == "heading_open" and nxt.tag in ("h1", "h2")) or not keep:
                    continue
            keep.append(t)
        doc.tokens = keep

    def _blocks(self, doc: Doc) -> None:
        toks = doc.tokens
        indent: list[float] = []
        in_table = False
        for i, t in enumerate(toks):
            if t.type == "inline" and in_table:
                for c in t.children or ():
                    if c.type == "code_inline":
                        c.meta["in_table"] = True
            if t.type == "table_close":
                in_table = False
            if t.type in ("bullet_list_open", "ordered_list_open"):
                indent.append(LIST_INDENT_PT)
            elif t.type == "blockquote_open":
                indent.append(BQ_INDENT_PT)
                self._callout(toks, i)
            elif t.type in ("bullet_list_close", "ordered_list_close", "blockquote_close"):
                indent.pop()
            elif t.type in ("fence", "code_block"):
                t.meta["avail_pt"] = TEXT_W_PT - sum(indent)
                t.meta["notes"] = self.notes
                t.meta["where"] = f"{doc.rel}:{(t.map or [0])[0] + 1}"
                t.content = t.content.translate(GLYPH_MAP)
            elif t.type == "table_open":
                in_table = True
                self._table(toks, i)
            elif t.type == "list_item_open":
                self._task(toks, i)
            elif t.type == "paragraph_open" and i + 3 < len(toks):
                nxt = toks[i + 3]
                if nxt.type in ("fence", "code_block", "table_open") and \
                        re.sub(r"[*_\s]+$", "", toks[i + 1].content).endswith(":"):
                    t.attrJoin("class", "lead")

    @staticmethod
    def _callout(toks, i: int) -> None:
        inl = next((t for t in toks[i + 1:i + 4] if t.type == "inline"), None)
        if not inl or not inl.children or inl.children[0].type != "text":
            return
        first = inl.children[0].content.lstrip()
        if first[:1] in CALLOUT_WARN:
            toks[i].attrJoin("class", "callout warn")
        elif first[:1] in CALLOUT_NOTE:
            toks[i].attrJoin("class", "callout note")

    @staticmethod
    def _task(toks, i: int) -> None:
        if i + 2 >= len(toks) or toks[i + 2].type != "inline":
            return
        inl = toks[i + 2]
        m = re.match(r"\[([ xX])\] ", inl.content)
        if not m or not inl.children or inl.children[0].type != "text":
            return
        inl.children[0].content = inl.children[0].content[4:]
        inl.content = inl.content[4:]
        toks[i].attrJoin("class", "task done" if m.group(1) != " " else "task")
        for k in range(i - 1, -1, -1):
            if toks[k].type == "bullet_list_open" and toks[k].level == toks[i].level - 1:
                if "tasks" not in (toks[k].attrGet("class") or ""):
                    toks[k].attrJoin("class", "tasks")
                break

    @staticmethod
    def _table(toks, i: int) -> None:
        ncols, j = 0, i + 1
        while toks[j].type != "table_close":
            if toks[j].type == "th_open":
                ncols += 1
            j += 1
        cls = "wide" if ncols >= 4 else "normal"
        toks[i].attrJoin("class", f"cols-{ncols} {cls}")

    def _inlines(self, doc: Doc) -> None:
        for t in doc.tokens:
            if t.type != "inline" or not t.children:
                continue
            kids = []
            k = 0
            ch = t.children
            while k < len(ch):
                c = ch[k]
                if c.type == "text":
                    c.content = EMOJI.sub("", c.content).translate(GLYPH_MAP)
                    if kids == [] and c.content.startswith(" "):
                        c.content = c.content.lstrip()
                elif c.type == "code_inline":
                    c.content = c.content.translate(GLYPH_MAP)
                if c.type == "link_open":
                    end = next(m for m in range(k + 1, len(ch)) if ch[m].type == "link_close")
                    kids.extend(self._link(doc, ch[k], ch[k + 1:end], ch[end]))
                    k = end + 1
                    continue
                kids.append(c)
                k += 1
            t.children = kids

    def _link(self, doc: Doc, opn, inner: list, cls) -> list:
        from markdown_it.token import Token
        for c in inner:
            if c.type == "text":
                c.content = EMOJI.sub("", c.content).translate(GLYPH_MAP)
        href = opn.attrGet("href") or ""
        if re.match(r"^[a-z][a-z0-9+.-]*:", href, re.I):
            opn.attrJoin("class", "ext")
            return [opn, *inner, cls]
        path_part, _, frag = href.partition("#")
        from urllib.parse import unquote
        path_part, frag = unquote(path_part), unquote(frag)
        if not path_part:                                  # (#якорь) в том же файле
            anchor = doc.slugs.get(frag)
            if anchor is None:
                self.notes.append(f"{doc.rel}: битый якорь #{frag}")
                return inner
            opn.attrSet("href", "#" + anchor)
            opn.attrJoin("class", "internal")
            return [opn, *inner, cls]
        target = (doc.path.parent / path_part).resolve()
        in_build = next((d for d in self.docs if d.path == target), None)
        if in_build is not None:
            anchor = in_build.slugs.get(frag) if frag else in_build.prefix + "top"
            if anchor is None:
                self.notes.append(f"{doc.rel}: битый якорь {href}")
                anchor = in_build.prefix + "top"
            opn.attrSet("href", "#" + anchor)
            opn.attrJoin("class", "internal")
            return [opn, *inner, cls]
        rel = repo_rel(target)
        section = None
        if not target.exists():
            self.notes.append(f"{doc.rel}: ссылка на несуществующий файл {href}")
        elif frag:
            slugs = self._target_slugs(target)
            section = (slugs or {}).get(frag)
            if section is None:
                self.notes.append(f"{doc.rel}: битый якорь {href}")
        x = Token("xref", "", 0)
        x.meta = {"inner": inner, "path": rel, "match": rel, "section": section,
                  "frag": frag, "url": self._repo_link(rel, frag)}
        if self.pdf_of is not None and self.out is not None:
            here = self.out.parent
            pdf = self.pdf_of.get(target)
            if pdf is not None:                     # соседний PDF комплекта
                url = os.path.relpath(pdf, here)
                anchor = self._pdf_anchors(target).get(frag) if frag and section else None
                x.meta["path"] = os.path.relpath(pdf, self.set_root)
                x.meta["url"] = url + ("#" + anchor if anchor else "")
            elif x.meta["url"] is None and target.exists() and here.is_relative_to(ROOT):
                x.meta["url"] = os.path.relpath(target, here)
        return [x]

    def _pdf_anchors(self, p: Path) -> dict[str, str]:
        """slug → id назначения в собственном PDF файла p (как его соберет Builder)."""
        if p not in self._pdf_anchor_cache:
            doc = Doc(p, 1)
            doc.used.update((doc.prefix + "top", doc.prefix + "intro"))
            doc.tokens = self.md.parse(strip_comments(p.read_text(encoding="utf-8")))
            self._headings(doc)
            notes = len(self.notes)
            self._anchors(doc)
            del self.notes[notes:]
            self._pdf_anchor_cache[p] = doc.slugs
        return self._pdf_anchor_cache[p]

    def _target_slugs(self, p: Path) -> dict[str, str] | None:
        if p not in self._target_cache:
            self._target_cache[p] = heading_slugs(p.read_text(encoding="utf-8")) \
                if p.suffix == ".md" else None
        return self._target_cache[p]

    def _repo_link(self, rel: str, frag: str) -> str | None:
        if not self.repo_url:
            return None
        from urllib.parse import quote
        ref = self.rev.get("commit_full") or "main"
        url = f"{self.repo_url}/blob/{ref}/{quote(rel)}"
        return url + ("#" + quote(frag) if frag else "")

    # ---- HTML -------------------------------------------------------------

    def title(self) -> tuple[str, str | None]:
        if self.title_arg:
            return self.title_arg, self.subtitle_arg
        p = self.project
        t = self.docs[0].title if self.single else f"{p.product}: {p.doc_set.lower()}"
        main, sep, sub = t.partition(": ")
        if not sep:
            return t, self.subtitle_arg
        return main, self.subtitle_arg or (sub[:1].upper() + sub[1:])

    def toc(self) -> list[Heading]:
        levels = (2, 3) if self.single else (1, 2)
        return [h for d in self.docs for h in d.headings if h.level in levels]

    def html(self) -> str:
        title, subtitle = self.title()
        env: dict = {}
        body = []
        for d in self.docs:
            inner = self.md.renderer.render(d.tokens, self.md.options, env)
            body.append(f'<article class="doc" id="{d.prefix}top">\n{inner}</article>')
        toc = "\n".join(
            f'<li class="toc-l{h.level}"><a href="#{h.anchor}">{html.escape(h.text)}</a></li>'
            for h in self.toc())
        r = self.rev
        e = html.escape
        product, doc_set = e(self.project.product), e(self.project.doc_set)
        dirty = '<span class="dirty"> (в рабочей копии есть незакоммиченные правки)</span>' \
            if r["dirty"] else ""
        commit = f', коммит <span class="mono">{e(r["commit"])}</span>' if r["commit"] else ""
        version = self.project.version
        meta_rows = [("Редакция", f'{e(r["date_long"])}{commit}{dirty}')]
        if version:
            meta_rows.append(("Версия продукта", f"{product} {e(version)}"))
        meta = "\n".join(f"<tr><th>{k}</th><td>{v}</td></tr>" for k, v in meta_rows)
        footer = f"{self.project.product} · редакция {r['date_short']}" + ("*" if r["dirty"] else "")
        css_vars = (f".cover {{ string-set: footer {css_str(footer)}; }}\n"
                    f".cover-title {{ string-set: doctitle {css_str(_short(title, 70))}; }}\n")
        mode = "single" if self.single else "multi"
        return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>{e(title if not subtitle else f"{title}: {subtitle[:1].lower()}{subtitle[1:]}")}</title>
<meta name="author" content="{product}">
<meta name="description" content="{doc_set}: {e(", ".join(d.rel for d in self.docs))}">
<meta name="dcterms.created" content="{r['iso']}">
<meta name="dcterms.modified" content="{r['iso']}">
<style>
{css_vars}</style>
</head>
<body class="mode-{mode}">
<section class="cover">
  <div class="cover-head">
    <div class="cover-product">{product}</div>
    <div class="cover-set">{doc_set}</div>
  </div>
  <div class="cover-main">
    <h1 class="cover-title">{e(_glue_last_word(title))}</h1>
    {f'<p class="cover-subtitle">{e(subtitle)}</p>' if subtitle else ''}
  </div>
  <div class="cover-foot"><table class="cover-meta">{meta}</table></div>
</section>
<nav class="toc" id="toc">
<h2 class="toc-title">{TOC_TITLE}</h2>
<ul>
{toc}
</ul>
</nav>
{chr(10).join(body)}
</body>
</html>
"""

    # ---- PDF --------------------------------------------------------------

    def build(self, out: Path, *, html_out: Path | None = None) -> BuildResult:
        from weasyprint import CSS, HTML
        from weasyprint.text.fonts import FontConfiguration

        for f in (FONT_SANS, FONT_MONO, STYLE):
            if not f.exists():
                raise SystemExit(f"docs_pdf: нет {repo_rel(f)}")
        self.out = out.resolve()
        self.parse()
        source = self.html()
        if html_out:
            html_out.parent.mkdir(parents=True, exist_ok=True)
            html_out.write_text(source, encoding="utf-8")
        self.notes.extend(glyph_gaps(self.docs))

        warnings: list[str] = []

        class _Grab(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                if record.levelno >= logging.WARNING:
                    warnings.append(record.getMessage())

        wlog = logging.getLogger("weasyprint")
        grab = _Grab()
        wlog.addHandler(grab)
        try:
            fonts = FontConfiguration()
            # Поля страницы — отдельным листом ДО style.css: иначе @page из
            # <style> документа перебивает @page cover { margin: 0 }.
            sheets = [CSS(string=page_css(), font_config=fonts),
                      CSS(filename=str(STYLE), font_config=fonts)]
            # base_url=None: относительные ссылки на соседние PDF и файлы
            # репозитория остаются относительными (с базой стали бы file:///…).
            document = HTML(string=source, base_url=None).render(
                stylesheets=sheets, font_config=fonts)
            out.parent.mkdir(parents=True, exist_ok=True)
            document.write_pdf(out)
        finally:
            wlog.removeHandler(grab)
        title, _ = self.title()
        return BuildResult(
            pdf=out, pages=len(document.pages), title=title, revision=self.rev["date_long"],
            toc=self.toc(), bookmarks=flatten_bookmarks(document.make_bookmark_tree()),
            warnings=warnings, overflows=find_overflows(document), notes=self.notes)


# --------------------------------------------------------------------------
# Правила рендера markdown-it
# --------------------------------------------------------------------------

def _render_fence(self, tokens, idx, options, env) -> str:
    t = tokens[idx]
    lang = (t.info or "").strip().split()[0].lower() if (t.info or "").strip() else ""
    lines = [ln.rstrip() for ln in t.content.expandtabs(4).rstrip("\n").split("\n")]
    width = max((display_width(ln) for ln in lines), default=0)
    avail = t.meta.get("avail_pt", TEXT_W_PT) - 2 * PRE_PAD_X_PT - 2 * PRE_BORDER_PT
    avail *= 0.995
    classes = ["code"]
    if is_diagram(lang, t.content):
        classes.append("diagram")
        fs = CODE_PT if width == 0 else min(CODE_PT, avail / (MONO_ADVANCE * width))
        if fs < DIAGRAM_MIN_PT:
            t.meta.get("notes", []).append(
                f"{t.meta.get('where')}: схема шириной {width} знаков не влезает даже кеглем {DIAGRAM_MIN_PT}")
            fs = DIAGRAM_MIN_PT
        fs = math.floor(fs * 20) / 20
        body = "\n".join(html.escape(ln, quote=False) for ln in lines)
    else:
        def fits(size: float) -> int:
            return int(avail // (MONO_ADVANCE * size))
        if width <= fits(CODE_PT):
            fs, cols = CODE_PT, None
        elif width <= fits(CODE_MIN_PT):
            fs, cols = math.floor(avail / (MONO_ADVANCE * width) * 20) / 20, None
        else:
            fs, cols = CODE_MIN_PT, fits(CODE_MIN_PT)
        body, wrapped = render_code_lines(lines, lang, cols)
        if wrapped:
            classes.append("wrapped")
            t.meta.get("notes", []).append(
                f"{t.meta.get('where')}: перенесено строк кода с маркером {WRAP_MARK}: {wrapped}")
    if len(lines) > LONG_BLOCK_LINES:
        classes.append("long")
    data = f' data-lang="{html.escape(lang)}"' if lang else ""
    return (f'<pre class="{" ".join(classes)}"{data} style="font-size:{fs:g}pt">'
            f"<code>{body}</code></pre>\n")


def code_breaks(text: str) -> str:
    """HTML `кода` с <wbr> после _ . / = и т. п. и на стыке слов в CamelCase:
    узкая колонка таблицы рвет идентификатор там, а не посреди слова (U+200B в
    извлекаемый текст не попадает).  Точки между цифрами (адреса, версии) не
    трогаются."""
    out = []
    n = len(text)
    for k, ch in enumerate(text):
        out.append(html.escape(ch, quote=False))
        if 1 < k < n - 3 and ch.islower() and text[k + 1].isupper() \
                and text[k + 2].islower():
            out.append("<wbr>")             # SessionCookie|Validation|Failure
            continue
        if ch in CODE_BREAK_AFTER and 1 < k < n - 3:
            if ch == "." and text[k - 1].isdigit() and text[k + 1].isdigit():
                continue
            if text[k + 1] in CODE_BREAK_AFTER or text[k + 1] in " }])\"'":
                continue
            out.append("<wbr>")
    return "".join(out)


def _lead_break(tokens, idx) -> str:
    """<wbr> перед встроенным элементом, если перед ним пробел.

    WeasyPrint не переносит строку на пробеле, за которым сразу начинается
    встроенный элемент (<code>, ссылка): весь хвост строки уезжает за край
    узкой ячейки. Явная точка переноса это лечит."""
    if idx == 0:
        return ""
    prev = tokens[idx - 1]
    if prev.type == "softbreak" or (prev.type == "text" and prev.content[-1:].isspace()):
        return "<wbr>"
    return ""


def _render_code_inline(self, tokens, idx, options, env) -> str:
    t = tokens[idx]
    long = len(t.content) > (16 if t.meta.get("in_table") else 40)
    body = code_breaks(t.content) if long else html.escape(t.content, quote=False)
    return _lead_break(tokens, idx) + code_pieces(body)


def code_pieces(body: str) -> str:
    """`Код` с точками переноса — цепочкой соседних <code>, по куску на отрезок.

    Если WeasyPrint рвет сам <code> по <wbr>, текст после него на новой строке
    уже не переносится и уходит за край ячейки. Между соседними элементами
    разрыв обычный. Отступы и скругления —
    только у первого и последнего куска (cs-a, cs-z в style.css)."""
    parts = body.split("<wbr>")
    if len(parts) == 1:
        return f"<code>{body}</code>"
    last = len(parts) - 1
    return "<wbr>".join(
        f'<code class="cs{" cs-a" if i == 0 else ""}{" cs-z" if i == last else ""}">{p}</code>'
        for i, p in enumerate(parts))


def _render_anchor(self, tokens, idx, options, env) -> str:
    return f'<a id="{html.escape(tokens[idx].meta["anchor"])}"></a>'


def _render_xref(self, tokens, idx, options, env) -> str:
    m = tokens[idx].meta
    inner, path, section = m["inner"], m["path"], m["section"]
    text = inline_text(inner).strip()
    parts = m.get("match", path).split("/")
    tails = ["/".join(parts[k:]) for k in range(len(parts))]    # от длинного к basename
    path_html = f'<span class="xref-path">{html.escape(path)}</span>'
    add_section = section and not re.search(r"[«§]|раздел", text) \
        and section.casefold() != text.casefold()
    sec_html = f", раздел «{html.escape(section)}»" if add_section else ""
    tail = next((x for x in tails if len(inner) == 1 and inner[0].type == "text"
                 and x in inner[0].content), None)
    if text in tails:
        out = path_html + sec_html
    elif tail:
        before, _, after = inner[0].content.partition(tail)
        out = html.escape(before) + path_html + html.escape(after) + sec_html
    else:
        out = self.renderInline(inner, options, env) + f" ({path_html}{sec_html})"
    lead = _lead_break(tokens, idx)
    if m["url"]:
        return f'{lead}<a class="xref" href="{html.escape(m["url"])}">{out}</a>'
    return f'{lead}<span class="xref">{out}</span>'


# --------------------------------------------------------------------------
# Метаданные и проверки
# --------------------------------------------------------------------------

def _short(text: str, n: int) -> str:
    if len(text) <= n:
        return text
    cut = text[:n].rsplit(" ", 1)[0]
    return cut.rstrip(",:;—- ") + "…"


def _glue_last_word(text: str) -> str:
    """Последние два слова через неразрывный пробел: одно слово на последней
    строке заголовка обложки выглядит оборванным («Руководство сетевого / инженера»)."""
    head, sep, tail = text.rpartition(" ")
    return f"{head}\u00a0{tail}" if sep and len(tail) < 20 else text


def css_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _git(*args: str) -> str | None:
    try:
        r = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True,
                           timeout=30, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def revision(sources: list[Path]) -> dict:
    """Дата редакции — последний коммит, трогавший исходники (не время сборки)."""
    best = None
    dirty = False
    for s in sources:
        out = _git("log", "-1", "--format=%cI%x09%h%x09%H", "--", str(s))
        if out:
            iso, short, full = out.split("\t")
            if best is None or iso > best[0]:
                best = (iso, short, full)
        if _git("status", "--porcelain", "--", str(s)):
            dirty = True
    if best:
        iso, short, full = best
        when = dt.datetime.fromisoformat(iso)
    else:
        when = max(dt.datetime.fromtimestamp(s.stat().st_mtime).astimezone() for s in sources)
        iso, short, full = when.isoformat(timespec="seconds"), "", ""
        dirty = True
    return {"iso": iso, "commit": short, "commit_full": full, "dirty": dirty,
            "date_long": f"{when.day} {MONTHS[when.month - 1]} {when.year}",
            "date_short": when.strftime("%d.%m.%Y")}


def page_css() -> str:
    m = MARGIN_MM
    return f"@page {{ size: A4; margin: {m['top']}mm {m['right']}mm {m['bottom']}mm {m['left']}mm; }}"


def glyph_gaps(docs: list[Doc]) -> list[str]:
    """Знаки, которых нет в Geist / Geist Mono: их нарисует чужой шрифт."""
    try:
        from fontTools.ttLib import TTFont
        sans = set(TTFont(str(FONT_SANS)).getBestCmap())
        mono = set(TTFont(str(FONT_MONO)).getBestCmap())
    except Exception as exc:
        return [f"проверка глифов пропущена: {exc}"]
    text, code = set(), set()
    for d in docs:
        for t in d.tokens:
            if t.type in ("fence", "code_block"):
                code.update(t.content)
            for c in t.children or ():
                if c.type == "code_inline":
                    code.update(c.content)
                elif c.type == "text":
                    text.update(c.content)
                elif c.type == "xref":
                    text.update(inline_text(c.meta["inner"]))
    miss_t = sorted(c for c in text if ord(c) > 32 and ord(c) not in sans)
    miss_c = sorted(c for c in code if ord(c) > 32 and ord(c) not in mono)
    out = []
    if miss_t:
        out.append("нет глифа в Geist: " + " ".join(f"{c} U+{ord(c):04X}" for c in miss_t))
    if miss_c:
        out.append("нет глифа в Geist Mono: " + " ".join(f"{c} U+{ord(c):04X}" for c in miss_c))
    return out


def flatten_bookmarks(tree, level: int = 1) -> list[tuple[int, str]]:
    out = []
    for bm in tree:
        label, children = bm[0], bm[2]
        out.append((level, label))
        out.extend(flatten_bookmarks(children, level + 1))
    return out


def find_overflows(document, tol: float = 0.75) -> list[str]:
    """Текст правее поля страницы или правее своего блока кода / ячейки."""
    try:
        from weasyprint.formatting_structure import boxes
    except ImportError:
        return []
    problems: list[str] = []

    def walk(box, right: float, pno: int) -> None:
        for child in getattr(box, "children", ()):
            if isinstance(child, boxes.MarginBox):
                continue
            r = right
            if getattr(child, "element_tag", None) in ("pre", "td", "th") and \
                    isinstance(child, boxes.BlockContainerBox):
                r = min(r, child.border_box_x() + child.border_width())
            if isinstance(child, boxes.TextBox):
                edge = child.position_x + child.width
                if edge > r + tol:
                    problems.append(f"стр. {pno}: +{edge - r:.1f}px «{child.text.strip()[:50]}»")
            walk(child, r, pno)

    for pno, page in enumerate(document.pages, 1):
        pb = page._page_box
        walk(pb, pb.content_box_x() + pb.width, pno)
    return problems


# --------------------------------------------------------------------------

def _report(res: BuildResult) -> tuple[list[str], bool]:
    lines = [f"{repo_rel(res.pdf)}: {res.pages} стр., редакция {res.revision}, "
             f"оглавление {len(res.toc)} пунктов, закладок {len(res.bookmarks)}"]
    lines += [f"  weasyprint: {w}" for w in res.warnings]
    lines += [f"  за полем: {o}" for o in res.overflows]
    lines += [f"  замечание: {n}" for n in res.notes]
    bad = bool(res.warnings or res.overflows
               or any("битый" in n or "несуществующий" in n for n in res.notes))
    return lines, bad


def _build_one(project: Project, src: Path, out: Path) -> tuple[list[str], bool]:
    use_root(project.root)                  # процесс -j: глобальный ROOT заново
    logging.basicConfig(level=logging.ERROR, format="%(name)s: %(message)s")
    b = Builder(project, [src], pdf_of=layout_map(project))
    return _report(b.build(out))


def build_set(project: Project, *, jobs: int = 1, only: list[str] | None = None) -> bool:
    """Весь комплект по раскладке: PDF на документ, ссылки между ними — на
    соседние PDF. only — подстроки путей исходников или папок PDF (собрать
    часть). True — без замечаний."""
    from concurrent.futures import ProcessPoolExecutor
    bad = False
    for line in check_layout(project):
        print(line)
        bad = True
    pdf_of = layout_map(project)
    tasks = []
    for folder, _, rels in project.layout:
        for rel in rels:
            src = (ROOT / rel).resolve()
            if not src.is_file() or (only and not any(o in rel or (folder and o in folder) for o in only)):
                continue
            tasks.append((project, src, pdf_of[src]))
    if jobs > 1 and len(tasks) > 1:
        with ProcessPoolExecutor(max_workers=jobs) as ex:
            results = list(ex.map(_build_one, *zip(*tasks)))
    else:
        results = [_build_one(*t) for t in tasks]
    for lines, b in results:
        print("\n".join(lines))
        bad = bad or b
    print(f"комплект: {len(results)} PDF в {repo_rel(project.out_dir)}")
    return not bad


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("sources", nargs="*", type=Path,
                    help="файлы для одного PDF; без них — весь комплект")
    ap.add_argument("-o", "--output", type=Path,
                    help="PDF для файлов из аргументов (по умолчанию dist/<имя>.pdf)")
    ap.add_argument("--config", type=Path,
                    help="TOML с настройками проекта (по умолчанию docs/pdf.toml, "
                         "затем projects/<имя каталога репозитория>.toml рядом со сборщиком)")
    ap.add_argument("--title")
    ap.add_argument("--subtitle")
    ap.add_argument("--html", type=Path, help="сохранить промежуточный HTML")
    ap.add_argument("--repo-url", help="база ссылок на файлы репозитория, напр. https://git.example/proj")
    ap.add_argument("--strict", action="store_true",
                    help="код 2 при предупреждениях WeasyPrint, переполнениях и битых ссылках")
    ap.add_argument("--set", action="store_true",
                    help="весь комплект: PDF на документ в --out-dir (так и без файлов)")
    ap.add_argument("--out-dir", type=Path,
                    help="каталог комплекта (по умолчанию out_dir из настроек или docs/pdf)")
    ap.add_argument("--only", action="append",
                    help="комплект: собрать только исходники, в пути которых (или в папке PDF) есть подстрока")
    ap.add_argument("-j", "--jobs", type=int, default=1, help="с --set: параллельных сборок")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.ERROR, format="%(name)s: %(message)s")
    try:
        import markdown_it  # noqa: F401
        import weasyprint  # noqa: F401
    except ImportError as exc:
        print(f"docs_pdf: нужен {exc.name} (pip install --user weasyprint markdown-it-py)",
              file=sys.stderr)
        return 1
    use_root(find_root(Path.cwd()))
    config = find_config(ROOT, args.config)
    project = load_project(ROOT, config, args.out_dir.resolve() if args.out_dir else None)
    if args.repo_url:
        project.repo_url = args.repo_url
    if args.set or not args.sources:
        print(f"настройки: {config or 'нет, комплект — README.md и docs/**/*.md'}; "
              f"продукт: {project.product}")
        ok = build_set(project, jobs=max(1, args.jobs), only=args.only)
        return 2 if args.strict and not ok else 0
    out = args.output or ROOT / "dist" / (args.sources[0].stem + ".pdf")
    b = Builder(project, args.sources, title=args.title, subtitle=args.subtitle)
    lines, bad = _report(b.build(out, html_out=args.html))
    print("\n".join(lines))
    return 2 if args.strict and bad else 0


if __name__ == "__main__":
    sys.exit(main())
