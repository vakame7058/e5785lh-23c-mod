"""Разбор nv.bin Balong V7R2 и файла Nvdload официальной прошивки. Только чтение файлов."""
import re
import struct


def hdr(d, base=0):
    magic, ctrl, ver, mnum, crcf, foff, fnum, fsize, roff, rcnt, rsize = struct.unpack_from(
        "<IIHBBIIIIII", d, base)
    return dict(magic=magic, ctrl=ctrl, ver=ver, mnum=mnum, crcf=crcf, foff=foff, fnum=fnum,
                fsize=fsize, roff=roff, rcnt=rcnt, rsize=rsize,
                prod=d[base + 0x40:base + 0x60].split(b"\0")[0].decode("latin1"))


def items(d, base=0):
    """Заголовок и таблица ячеек: {id: {len, off, ...}}."""
    h = hdr(d, base)
    res = {}
    for i in range(h["rcnt"]):
        o = base + h["roff"] + i * 16
        iid, ln, off, fid, prio, mn = struct.unpack_from("<HHIHHI", d, o)
        res[iid] = dict(len=ln, off=off, fid=fid, prio=prio, mn=mn, idx=i)
    return h, res


def value(d, it, base=0, h=None, modem=0):
    """Значение ячейки: файл[размер служебной части + смещение ячейки]."""
    if h is None:
        h = hdr(d, base)
    o = base + h["ctrl"] + it["off"] + modem * it["len"]
    return d[o:o + it["len"]]


def split_nvdload(raw):
    """Nvdload_R11: заголовок, база NV (xnv), затем текст XML с секциями до конца файла."""
    if raw[:4] != b"nv\0\0":
        raise ValueError("не файл Nvdload: нет метки nv в начале")
    hdr_size, xnv_size = struct.unpack_from("<II", raw, 4)
    xml = raw[hdr_size + xnv_size:]
    if not xml.startswith(b"<?xml") or b"</XMLConfig>" not in xml:
        raise ValueError("после базы NV нет XML")
    return raw[hdr_size:hdr_size + xnv_size], xml


def parse_sections(xml):
    """Секции XML: 'cat0' (общая) и 'p<номер>' (product_id). {секция: {id: байты}}."""
    text = xml.decode("latin1")
    text = text[:text.find("</XMLConfig>")]
    secs, cur = {}, "cat0"
    for line in text.split("\n"):
        m = re.search(r'<product product_id="(\d+)"', line)
        if m:
            cur = "p" + m.group(1)
            continue
        if "</product>" in line:
            cur = "cat0"
            continue
        m = re.search(r'<nv id="(\d+)"(?: cdma="\d+")?\s*(?:modem_id="(\d+)")?[^>]*>([^<]*)</nv>', line)
        if m:
            iid = int(m.group(1))
            vals = bytes(int(x, 16) for x in m.group(3).split(",") if x.strip())
            secs.setdefault(cur, {})[iid] = vals
    return secs
