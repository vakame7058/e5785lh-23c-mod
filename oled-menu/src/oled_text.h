#ifndef OLED_TEXT_H
#define OLED_TEXT_H
#include <stdint.h>

/* Сглаженный текст: глиф 4 бита на пиксель, 2 пикселя в байте (старшая тетрада - левый). */
struct aa_glyph {
    uint16_t cp;        /* код символа Unicode */
    uint8_t w, h;       /* размер картинки глифа */
    int8_t x, y;        /* смещение картинки от начала строки (y - от верха строки) */
    uint8_t adv;        /* шаг до следующего символа */
    uint32_t off;       /* начало картинки в data */
};

struct aa_font {
    const struct aa_glyph *glyphs;   /* по возрастанию cp */
    const uint8_t *data;
    uint16_t n;
    uint8_t height;     /* высота строки */
    uint8_t ascent;
};

extern const struct aa_font font_s, font_m, font_mb, font_xl;

/* цвет RGB565 (красный в старших битах) */
#define RGB565(r, g, b) ((uint16_t)((((r) >> 3) << 11) | (((g) >> 2) << 5) | ((b) >> 3)))

uint32_t utf8_next(const char **s);
int aa_text_width(const struct aa_font *f, const char *s);
/* вывод с x, y (верх строки); возвращает x после текста */
int aa_put_text(const struct aa_font *f, int x, int y, uint16_t color, const char *s);
/* не шире maxw: иначе обрезать по символу и дописать "…"; возвращает ширину вывода */
int aa_put_text_fit(const struct aa_font *f, int x, int y, int maxw, uint16_t color, const char *s);
/* сколько байт s влезает в ширину w */
int aa_bytes_fit(const struct aa_font *f, const char *s, int w);

/* рисование с прозрачностью a 0..15 поверх того, что уже в кадре */
void aa_blend_pixel(int x, int y, uint16_t color, int a);
void aa_fill_rect(int x, int y, int w, int h, uint16_t color);
/* скругленный прямоугольник: заливка или рамка в 1 px, радиус 0..5, углы сглажены */
void aa_round_rect(int x, int y, int w, int h, int r, uint16_t color, int filled);
/* значок RGB565 16x16, 0 - прозрачно (формат oled_icons.h форка saqie1393) */
void aa_put_icon(int x, int y, const uint16_t *icon, int w, int h);

#endif
