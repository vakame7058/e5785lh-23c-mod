#!/bin/bash
# Собирает оба PDF комплекта в docs/pdf/ из docs/*.md и README частей.
#   packaging/build_guide.sh
# Нужны weasyprint, markdown-it-py, Pillow, git, pdftotext.
# Что куда идет — карта в packaging/docs_parts.py. Сборка падает, если раздел не назначен.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

cd "$ROOT"
tar --exclude=docs/pdf --exclude=webui/prebuilt -cf - . | tar -xf - -C "$T"
cd "$T"
python3 packaging/docs_parts.py prepare
git init -q .
git add -A
git -c user.name=build -c user.email=build@localhost commit -qm build
python3 packaging/docs_parts.py build
python3 packaging/docs_parts.py verify
mkdir -p "$ROOT/docs/pdf"
cp docs/pdf/e5785lh-23c-features.pdf docs/pdf/e5785lh-23c-install.pdf "$ROOT/docs/pdf/"
