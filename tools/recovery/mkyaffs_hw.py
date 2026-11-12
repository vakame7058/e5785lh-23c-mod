"""cpio (newc) -> образ YAFFS2 «2048+16» для fastboot-записи на Balong (Huawei, ядро 3.10.59).

Формат подсмотрен у стокового раздела app (дамп oem nanddump):
  страница = 2048 данных + 16 байт тега (seq, obj_id, chunk_id, n_bytes, все little-endian u32);
  seq = 0x1001 + номер блока (64 страницы в блоке);
  заголовок объекта: obj_id | тип<<28, chunk_id = 0x80000000 | parent, n_bytes = размер файла (для файлов);
  данные: chunk_id = 1.., n_bytes <= 2048, хвост чанка = нули;
  неиспользуемые поля заголовка = 0xFF, имя = нули.
Загрузчик затирает первые 4 байта образа словом OKAY, поэтому первым чанком идет
служебный файл «okay» с содержимым OKAY (затирание его не портит).

Использование:
  mkyaffs_hw.py build <cpio> <out.img>        собрать образ
  mkyaffs_hw.py verify <cpio> <image>         разобрать образ как ядро (по тегам) и сверить с cpio
"""
import hashlib, struct, sys

CHUNK, TAG, PPB = 2048, 16, 64
T_FILE, T_SYMLINK, T_DIR, T_HARDLINK, T_SPECIAL = 1, 2, 3, 4, 5
ROOT, FIRST_ID, DUMMY_ID = 1, 0x101, 0x100


def parse_cpio(path):
    d = open(path, "rb").read()
    pos, ents = 0, []
    while True:
        h = d[pos:pos + 110]
        assert h[:6] == b"070701", f"не newc на {pos}"
        f = [int(h[6 + 8 * i:14 + 8 * i], 16) for i in range(13)]
        ino, mode, uid, gid, nlink, mtime, size, dmaj, dmin, rmaj, rmin, nsize, _ = f
        name = d[pos + 110:pos + 110 + nsize - 1].decode("utf-8", "surrogateescape")
        pos = (pos + 110 + nsize + 3) & ~3
        data = d[pos:pos + size]
        pos = (pos + size + 3) & ~3
        if name == "TRAILER!!!":
            break
        ents.append(dict(ino=ino, mode=mode, uid=uid, gid=gid, nlink=nlink, mtime=mtime,
                         size=size, dev=(dmaj, dmin), rdev=(rmaj, rmin), name=name, data=data))
    return ents


def norm(name):
    n = name
    while n.startswith("./"):
        n = n[2:]
    return n.strip("/")


class Img:
    def __init__(self):
        self.pages = []                       # (data2048, tag16 без seq-части не нужен: seq вычисляется при выдаче)

    def add(self, data, obj, chunk, nbytes):
        assert len(data) == CHUNK
        self.pages.append((data, obj, chunk, nbytes))

    def tobytes(self):
        out = bytearray()
        for i, (data, obj, chunk, nbytes) in enumerate(self.pages):
            seq = 0x1001 + i // PPB
            out += data + struct.pack("<4I", seq, obj, chunk, nbytes)
        return bytes(out)


def header(typ, parent, name, mode, uid, gid, at, mt, ct, size_lo, size_hi, equiv, alias, rdev):
    h = bytearray(b"\xff" * CHUNK)
    struct.pack_into("<IIH", h, 0, typ, parent, 0xFFFF)
    nb = name.encode("utf-8", "surrogateescape")
    assert len(nb) <= 255, name
    h[10:266] = nb + b"\0" * (256 - len(nb))
    struct.pack_into("<8I", h, 268, mode, uid, gid, at, mt, ct, size_lo, equiv)
    if alias is not None:
        ab = alias.encode("utf-8", "surrogateescape")
        assert len(ab) <= 159, alias
        h[300:460] = ab + b"\0" * (160 - len(ab))
    struct.pack_into("<I", h, 460, rdev)
    # win_*: 0xFF, inband_shadowed=0, inband_is_shrink=0xFFFFFFFF, size_high, reserved=FF, shadows=0, is_shrink=0
    struct.pack_into("<6I", h, 488, 0, 0xFFFFFFFF, size_hi, 0xFFFFFFFF, 0, 0)
    return bytes(h)


def build(cpio_path, out_path):
    ents = parse_cpio(cpio_path)
    img = Img()
    # служебный файл OKAY: первый чанк образа
    okay_data = b"OKAY" + b"\0" * (CHUNK - 4)
    img.add(okay_data, DUMMY_ID, 1, 4)
    img.add(header(T_FILE, ROOT, "okay", 0o100644, 0, 0, 0, 0, 0, 4, 0, 0xFFFFFFFF, None, 0),
            DUMMY_ID | T_FILE << 28, 0x80000000 | ROOT, 4)
    # корень
    root = next((e for e in ents if norm(e["name"]) in ("", ".")), None)
    rm = (root["mode"] if root else 0o40755)
    img.add(header(T_DIR, 0, "", rm, root["uid"] if root else 0, root["gid"] if root else 0,
                   root["mtime"] if root else 0, root["mtime"] if root else 0, root["mtime"] if root else 0,
                   0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, None, 0),
            ROOT | T_DIR << 28, 0x80000000, 0)
    # загрузчик дописывает слово OKAY еще и на потоковое смещение 8192 (страница 3, байт 2000):
    # страница 3 должна быть заголовком (там с байта 512 неиспользуемый хвост FF)
    assert len(img.pages) == 3
    img.add(header(T_FILE, ROOT, "okay2", 0o100644, 0, 0, 0, 0, 0, 0, 0, 0xFFFFFFFF, None, 0),
            0xFF | T_FILE << 28, 0x80000000 | ROOT, 0)
    ids = {"": ROOT}
    nxt = [FIRST_ID]
    by_ino = {}
    # данные для групп жестких ссылок: в newc они лежат в записи с ненулевым размером
    ino_data = {}
    for e in ents:
        if (e["mode"] & 0o170000) == 0o100000 and e["nlink"] > 1 and e["size"]:
            ino_data[(e["ino"], e["dev"])] = e["data"]
    stats = dict(dirs=0, files=0, symlinks=0, hard=0, special=0, bytes=0)

    def ensure_dir(path):
        if path in ids:
            return ids[path]
        parent, _, base = path.rpartition("/")
        pid = ensure_dir(parent)
        oid = nxt[0]; nxt[0] += 1
        ids[path] = oid
        img.add(header(T_DIR, pid, base, 0o40755, 0, 0, 0, 0, 0, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, None, 0),
                oid | T_DIR << 28, 0x80000000 | pid, 0)
        stats["dirs"] += 1
        return oid

    for e in ents:
        path = norm(e["name"])
        if path in ("", "."):
            continue
        parent, _, base = path.rpartition("/")
        pid = ensure_dir(parent)
        ftype = e["mode"] & 0o170000
        m, u, g, t = e["mode"], e["uid"], e["gid"], e["mtime"]
        if ftype == 0o040000:
            if path in ids:
                continue
            oid = nxt[0]; nxt[0] += 1
            ids[path] = oid
            img.add(header(T_DIR, pid, base, m, u, g, t, t, t, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, None, 0),
                    oid | T_DIR << 28, 0x80000000 | pid, 0)
            stats["dirs"] += 1
        elif ftype == 0o120000:
            oid = nxt[0]; nxt[0] += 1
            img.add(header(T_SYMLINK, pid, base, m, u, g, t, t, t, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF,
                           e["data"].decode("utf-8", "surrogateescape"), 0),
                    oid | T_SYMLINK << 28, 0x80000000 | pid, 0)
            stats["symlinks"] += 1
        elif ftype == 0o100000:
            key = (e["ino"], e["dev"])
            if e["nlink"] > 1 and key in by_ino:
                eq = by_ino[key]
                oid = nxt[0]; nxt[0] += 1
                img.add(header(T_HARDLINK, pid, base, m, u, g, t, t, t, 0xFFFFFFFF, 0xFFFFFFFF, eq, None, 0),
                        oid | T_HARDLINK << 28, 0x80000000 | pid, eq)
                stats["hard"] += 1
                continue
            data = e["data"] if e["size"] else ino_data.get(key, b"")
            size = len(data)
            oid = nxt[0]; nxt[0] += 1
            if e["nlink"] > 1:
                by_ino[key] = oid
            for ci in range(0, size, CHUNK):
                part = data[ci:ci + CHUNK]
                img.add(part + b"\0" * (CHUNK - len(part)), oid, ci // CHUNK + 1, len(part))
            img.add(header(T_FILE, pid, base, m, u, g, t, t, t, size & 0xFFFFFFFF, size >> 32, 0xFFFFFFFF, None, 0),
                    oid | T_FILE << 28, 0x80000000 | pid, size & 0xFFFFFFFF)
            stats["files"] += 1; stats["bytes"] += size
        else:
            oid = nxt[0]; nxt[0] += 1
            rd = (e["rdev"][0] << 8) | e["rdev"][1]
            img.add(header(T_SPECIAL, pid, base, m, u, g, t, t, t, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, None, rd),
                    oid | T_SPECIAL << 28, 0x80000000 | pid, 0)
            stats["special"] += 1
    raw = img.tobytes()
    open(out_path, "wb").write(raw)
    n = len(img.pages)
    print(f"{out_path}: страниц {n}, блоков {-(-n // PPB)}, размер {len(raw)} Б (кратно 2064: {len(raw) % 2064 == 0})", stats)
    return n


def verify(cpio_path, img_path):
    """Разбор «как ядро»: по тегам собираем объекты и сверяем с cpio."""
    raw = bytearray(open(img_path, "rb").read())
    raw[0:4] = b"OKAY"                         # как после затирания загрузчиком
    raw[3 * 2064 + 2000:3 * 2064 + 2004] = b"OKAY"
    n = len(raw) // (CHUNK + TAG)
    hdr, data = {}, {}
    for i in range(n):
        base = i * (CHUNK + TAG)
        seq, obj, chunk, nb = struct.unpack_from("<4I", raw, base + CHUNK)
        if chunk & 0x80000000:
            oid = obj & 0x0FFFFFFF
            hdr[oid] = (i, raw[base:base + CHUNK], chunk & 0x0FFFFFFF, nb, obj >> 28)
        else:
            data[(obj, chunk)] = (i, raw[base:base + CHUNK], nb)
    names = {}
    for oid, (i, h, parent, nb, typ) in hdr.items():
        name = bytes(h[10:266]).split(b"\0")[0].decode("utf-8", "surrogateescape")
        names[oid] = (parent, name, typ)

    def path_of(oid):
        parts = []
        while oid != ROOT:
            p, nm, _ = names[oid]
            parts.append(nm); oid = p
        return "/".join(reversed(parts))
    got = {}
    for oid, (i, h, parent, nb, typ) in hdr.items():
        if oid == ROOT:
            continue
        p = path_of(oid)
        mode, = struct.unpack_from("<I", h, 268)
        if typ == T_FILE:
            size = struct.unpack_from("<I", h, 292)[0] | (struct.unpack_from("<I", h, 496)[0] << 32)
            buf = bytearray()
            for c in range(1, -(-size // CHUNK) + 1):
                di, dd, dn = data[(oid, c)]
                buf += dd[:dn]
            assert len(buf) == size, (p, len(buf), size)
            got[p] = ("f", mode, hashlib.sha1(buf).hexdigest())
        elif typ == T_DIR:
            got[p] = ("d", mode, None)
        elif typ == T_SYMLINK:
            got[p] = ("l", mode, bytes(h[300:460]).split(b"\0")[0].decode("utf-8", "surrogateescape"))
        elif typ == T_HARDLINK:
            eq = struct.unpack_from("<I", h, 296)[0]
            got[p] = ("h", mode, path_of(eq))
        else:
            got[p] = ("s", mode, None)
    ents = parse_cpio(cpio_path)
    ino_data = {}
    for e in ents:
        if (e["mode"] & 0o170000) == 0o100000 and e["nlink"] > 1 and e["size"]:
            ino_data[(e["ino"], e["dev"])] = e["data"]
    bad = 0
    want_paths = set()
    for e in ents:
        p = norm(e["name"])
        if p in ("", "."):
            continue
        want_paths.add(p)
        ft = e["mode"] & 0o170000
        g = got.get(p)
        if g is None:
            print("НЕТ в образе:", p); bad += 1; continue
        if ft == 0o100000 and g[0] == "f":
            data = e["data"] if e["size"] else ino_data.get((e["ino"], e["dev"]), b"")
            if hashlib.sha1(data).hexdigest() != g[2] or e["mode"] != g[1]:
                print("РАЗНИЦА файл:", p); bad += 1
        elif ft == 0o040000 and g[0] == "d":
            pass
        elif ft == 0o120000 and g[0] == "l":
            if e["data"].decode("utf-8", "surrogateescape") != g[2]:
                print("РАЗНИЦА symlink:", p); bad += 1
        elif ft == 0o100000 and g[0] == "h":
            pass
        elif ft not in (0o100000, 0o040000, 0o120000) and g[0] == "s":
            pass
        else:
            print("РАЗНЫЙ ТИП:", p, g[0], oct(ft)); bad += 1
    extra = [p for p in got if p not in want_paths and not any(w.startswith(p + "/") for w in want_paths) and p not in ("okay", "okay2")]
    print(f"проверено записей cpio: {len(want_paths)}, расхождений: {bad}, лишних в образе: {len(extra)} {extra[:5]}")
    return bad == 0


if __name__ == "__main__":
    if sys.argv[1] == "build":
        build(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "verify":
        sys.exit(0 if verify(sys.argv[2], sys.argv[3]) else 1)
