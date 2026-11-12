#!/usr/bin/env python3
"""Сборка SPA: core/*.js, затем pages/*.js -> dist/js/mod/app.js; css/*.css -> dist/css/mod/app.css;
index.html -> dist/html/mod.html и dist/js/mod/index.html; fonts/*.woff2 -> dist/css/mod/font-geist-*.css
(OFL — комментарием в начале app.css); рядом .gz.

Запуск: python3 build.py [--watch] [--no-check] [--no-min]
--no-min — без сжатия (отступы и комментарии остаются, удобно для отладки в браузере).
Проверка синтаксиса бандла через `node --check`, если node есть.
"""
import gzip
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.environ.get('MYWEBUI_DIST') or os.path.join(HERE, 'dist')   # MYWEBUI_DIST — собрать в другой каталог


def files(sub, ext):
    d = os.path.join(HERE, sub)
    if not os.path.isdir(d):
        return []
    return sorted(os.path.join(d, f) for f in os.listdir(d)
                  if f.endswith(ext) and not f.startswith('.'))


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = text.encode('utf-8')
    with open(path, 'wb') as f:
        f.write(data)
    # mtime=0: одинаковый .gz при одинаковом входе
    with open(path + '.gz', 'wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, compresslevel=9, mtime=0) as gz:
            gz.write(data)
    return len(data), os.path.getsize(path + '.gz')


BACKTICK = re.compile(r'(?<!\\)`')


def squeeze(js):
    """Простое сжатие без разбора JS: убирает пустые строки, строки-комментарии `//` и отступы.
    Переводы строк остаются (ASI не меняется); внутри шаблонных строк `...` ничего не трогает."""
    out = []
    tpl = False
    for line in js.split('\n'):
        if tpl:
            out.append(line)
        else:
            st = line.strip()
            if st and not st.startswith('//'):
                out.append(st)
        if len(BACKTICK.findall(line)) % 2:
            tpl = not tpl
    return '\n'.join(out) + '\n'


def build(check=True, minify=True):
    t0 = time.time()
    parts = []
    srcs = files('core', '.js') + files('pages', '.js')
    for p in srcs:
        rel = os.path.relpath(p, HERE)
        # каждый файл в своей области видимости; общее — только через M
        parts.append('// ==== %s\n;(function () {\n\'use strict\';\n%s\n})();\n' % (rel, read(p)))
    js = '/* mywebui E5785: собрано build.py */\n' + ''.join(parts)
    if minify:
        js = squeeze(js)
    css = ''.join('/* ==== %s */\n%s\n' % (os.path.relpath(p, HERE), read(p)) for p in files('css', '.css'))
    ofl = os.path.join(HERE, 'fonts', 'OFL.txt')
    if os.path.isfile(ofl):  # лицензия шрифтов едет вместе с ними, в начале app.css
        css = ('/*! Шрифты Geist и Geist Mono (/css/mod/font-geist-sans.css, font-geist-mono.css), npm geist 1.7.2, подрезаны.\n'
               + read(ofl).replace('*/', '* /') + '\n*/\n') + css
    html = read(os.path.join(HERE, 'index.html'))

    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    out = [
        ('js/mod/app.js', js),
        ('css/mod/app.css', css),
        ('html/mod.html', html),
        ('js/mod/index.html', html),   # копия оболочки: на роутере /html/*.html кроме стоковых не отдаются
    ]
    sizes = []
    for rel, text in out:
        sizes.append((rel,) + write(os.path.join(DIST, rel), text))
    # Шрифты Geist (OFL) рядом со стилями. Веб роутера отдает только известные расширения (.css, .js, .html …),
    # на .woff2 отвечает 100002, а data: URI в CSS запрещает его CSP (default-src 'self': шрифт из data: не грузится).
    # Поэтому файл шрифта кладется под именем font-*.css (одно расширение): браузер грузит шрифт по @font-face
    # и на тип ответа не смотрит. Лицензия OFL — комментарием /*! … */ в начале app.css. .gz рядом: установщик берет .gz.
    FONT_NAMES = {'Geist-Variable.woff2': 'font-geist-sans.css', 'GeistMono-Variable.woff2': 'font-geist-mono.css'}
    fdir = os.path.join(HERE, 'fonts')
    for f, name in sorted(FONT_NAMES.items()):
        src = os.path.join(fdir, f)
        if not os.path.isfile(src):
            continue
        rel = 'css/mod/' + name
        dst = os.path.join(DIST, rel)
        with open(src, 'rb') as fi:
            data = fi.read()
        with open(dst, 'wb') as fo:
            fo.write(data)
        with open(dst + '.gz', 'wb') as raw:
            with gzip.GzipFile(filename='', mode='wb', fileobj=raw, compresslevel=9, mtime=0) as gz:
                gz.write(data)
        sizes.append((rel, os.path.getsize(dst), os.path.getsize(dst + '.gz')))

    ok = True
    if check and shutil.which('node'):
        r = subprocess.run(['node', '--check', os.path.join(DIST, 'js/mod/app.js')],
                           capture_output=True, text=True)
        if r.returncode != 0:
            ok = False
            sys.stderr.write(r.stderr)
    for rel, n, gz in sizes:
        print('%-40s %7d байт, gz %6d' % (rel, n, gz))
    print('файлов js: %d, %.2f с, %s' % (len(srcs), time.time() - t0, 'ОК' if ok else 'ОШИБКА синтаксиса'))
    return ok


def snapshot():
    st = []
    for sub in ('core', 'pages', 'css'):
        for p in files(sub, '.js' if sub != 'css' else '.css'):
            st.append((p, os.path.getmtime(p)))
    p = os.path.join(HERE, 'index.html')
    st.append((p, os.path.getmtime(p)))
    return st


if __name__ == '__main__':
    check = '--no-check' not in sys.argv
    minify = '--no-min' not in sys.argv
    ok = build(check, minify)
    if '--watch' in sys.argv:
        last = snapshot()
        while True:
            time.sleep(0.7)
            cur = snapshot()
            if cur != last:
                last = cur
                try:
                    build(check, minify)
                except Exception as e:  # продолжаем следить
                    print('сборка упала:', e)
    sys.exit(0 if ok else 1)
