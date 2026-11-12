/*
 * Сглаженный текст и простая графика поверх кадра secret_screen_buf.
 * Смешивание с фоном целочисленное: c = bg + (fg - bg) * a / 15, без float.
 */
#include <stdint.h>
#include <string.h>

#include "oled.h"
#include "oled_text.h"
#include "oled_font_aa.h"

extern uint16_t secret_screen_buf[];
extern void put_pixel(uint8_t x, uint8_t y, uint8_t red, uint8_t green, uint8_t blue);

/* в кадре пиксель хранится со старшим байтом первым */
static inline uint16_t swap16(uint16_t v) { return (uint16_t)((v >> 8) | (v << 8)); }

/* a * 4369 >> 16 == a / 15 с точностью до 1 для a 0..15 */
static inline int mix(int bg, int fg, int a) {
    return bg + (((fg - bg) * a * 4369) >> 16);
}

void aa_blend_pixel(int x, int y, uint16_t color, int a) {
    if (x < 0 || y < 0 || x >= lcd_width || y >= lcd_height || a <= 0) {
        return;
    }
    if (is_small_screen) {
        /* одноцветный экран: порог */
        if (a >= 8) {
            put_pixel(x, y, 255, 255, 255);
        }
        return;
    }
    uint16_t *p = &secret_screen_buf[y * 128 + x];
    if (a >= 15) {
        *p = swap16(color);
        return;
    }
    uint16_t bg = swap16(*p);
    int r = mix(bg >> 11, color >> 11, a);
    int g = mix((bg >> 5) & 63, (color >> 5) & 63, a);
    int b = mix(bg & 31, color & 31, a);
    *p = swap16((uint16_t)((r << 11) | (g << 5) | b));
}

void aa_fill_rect(int x, int y, int w, int h, uint16_t color) {
    for (int yy = y; yy < y + h; yy += 1) {
        for (int xx = x; xx < x + w; xx += 1) {
            aa_blend_pixel(xx, yy, color, 15);
        }
    }
}

uint32_t utf8_next(const char **s) {
    const uint8_t *p = (const uint8_t *)*s;
    uint32_t c = p[0];
    int n = 0;
    if (c < 0x80) {
        n = 0;
    } else if ((c & 0xE0) == 0xC0) {
        c &= 0x1F; n = 1;
    } else if ((c & 0xF0) == 0xE0) {
        c &= 0x0F; n = 2;
    } else if ((c & 0xF8) == 0xF0) {
        c &= 0x07; n = 3;
    } else {
        *s += 1;
        return '?';
    }
    p += 1;
    for (int i = 0; i < n; i += 1) {
        if ((p[i] & 0xC0) != 0x80) {
            *s = (const char *)(p + i);
            return '?';
        }
        c = (c << 6) | (p[i] & 0x3F);
    }
    *s = (const char *)(p + n);
    return c;
}

static const struct aa_glyph *find_glyph(const struct aa_font *f, uint32_t cp) {
    if (cp == 0xA0) {
        cp = ' ';
    }
    int lo = 0, hi = f->n - 1;
    while (lo <= hi) {
        int mid = (lo + hi) >> 1;
        uint16_t c = f->glyphs[mid].cp;
        if (c == cp) {
            return &f->glyphs[mid];
        }
        if (c < cp) {
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return cp == '?' ? 0 : find_glyph(f, '?');
}

static void put_glyph(const struct aa_font *f, const struct aa_glyph *g, int x, int y, uint16_t color) {
    const uint8_t *d = f->data + g->off;
    int bpr = (g->w + 1) >> 1;
    for (int yy = 0; yy < g->h; yy += 1) {
        const uint8_t *row = d + yy * bpr;
        for (int xx = 0; xx < g->w; xx += 1) {
            int a = (xx & 1) ? (row[xx >> 1] & 0x0F) : (row[xx >> 1] >> 4);
            if (a) {
                aa_blend_pixel(x + g->x + xx, y + g->y + yy, color, a);
            }
        }
    }
}

int aa_text_width(const struct aa_font *f, const char *s) {
    int w = 0;
    while (s && *s) {
        const struct aa_glyph *g = find_glyph(f, utf8_next(&s));
        if (g) {
            w += g->adv;
        }
    }
    return w;
}

int aa_put_text(const struct aa_font *f, int x, int y, uint16_t color, const char *s) {
    while (s && *s) {
        uint32_t cp = utf8_next(&s);
        const struct aa_glyph *g = find_glyph(f, cp);
        if (!g) {
            continue;
        }
        put_glyph(f, g, x, y, color);
        x += g->adv;
    }
    return x;
}

int aa_bytes_fit(const struct aa_font *f, const char *s, int w) {
    const char *start = s;
    int x = 0;
    while (s && *s) {
        const char *prev = s;
        const struct aa_glyph *g = find_glyph(f, utf8_next(&s));
        int adv = g ? g->adv : 0;
        if (x + adv > w) {
            return prev - start;
        }
        x += adv;
    }
    return s - start;
}

int aa_put_text_fit(const struct aa_font *f, int x, int y, int maxw, uint16_t color, const char *s) {
    int w = aa_text_width(f, s);
    if (w <= maxw) {
        aa_put_text(f, x, y, color, s);
        return w;
    }
    const char *ell = "\xe2\x80\xa6";   /* … */
    int ew = aa_text_width(f, ell);
    int n = aa_bytes_fit(f, s, maxw - ew);
    char buf[256];
    if (n > (int)sizeof(buf) - 4) {
        n = sizeof(buf) - 4;
    }
    memcpy(buf, s, n);
    /* без пробела перед многоточием */
    while (n > 0 && buf[n - 1] == ' ') {
        n -= 1;
    }
    memcpy(buf + n, ell, 4);
    return aa_put_text(f, x, y, color, buf) - x;
}

#include "oled_corners.h"

void aa_round_rect(int x, int y, int w, int h, int r, uint16_t color, int filled) {
    if (r < 0) r = 0;
    if (r > 5) r = 5;
    if (2 * r > w) r = w / 2;
    if (2 * r > h) r = h / 2;
    const uint8_t *c = filled ? corner_fill[r] : corner_ring[r];
    /* углы: c[j*r+i], i - от края по x, j - по y */
    for (int j = 0; j < r; j += 1) {
        for (int i = 0; i < r; i += 1) {
            int a = c[j * r + i];
            aa_blend_pixel(x + i, y + j, color, a);
            aa_blend_pixel(x + w - 1 - i, y + j, color, a);
            aa_blend_pixel(x + i, y + h - 1 - j, color, a);
            aa_blend_pixel(x + w - 1 - i, y + h - 1 - j, color, a);
        }
    }
    if (filled) {
        aa_fill_rect(x + r, y, w - 2 * r, h, color);
        aa_fill_rect(x, y + r, r, h - 2 * r, color);
        aa_fill_rect(x + w - r, y + r, r, h - 2 * r, color);
    } else {
        aa_fill_rect(x + r, y, w - 2 * r, 1, color);
        aa_fill_rect(x + r, y + h - 1, w - 2 * r, 1, color);
        aa_fill_rect(x, y + r, 1, h - 2 * r, color);
        aa_fill_rect(x + w - 1, y + r, 1, h - 2 * r, color);
    }
}

void aa_put_icon(int x, int y, const uint16_t *icon, int w, int h) {
    for (int yy = 0; yy < h; yy += 1) {
        for (int xx = 0; xx < w; xx += 1) {
            uint16_t c = icon[yy * w + xx];
            if (c) {
                aa_blend_pixel(x + xx, y + yy, c, 15);
            }
        }
    }
}
