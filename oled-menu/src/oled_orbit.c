/*
 * «Орбита» - игра для секретного меню hijack_ng, экран 128x128 RGB565.
 * Интерфейс и встраивание - oled_orbit.h.
 *
 * Ракета держится в воздухе импульсами тяги (POWER), обходит астероиды,
 * спутники, обломки и редкие стены-фермы с проходом. Звезды дают очки,
 * канистры - топливо, пузырь - щит на один удар. Пять уровней - полет к Луне,
 * дальше к Марсу и снова к Луне, скорость растет.
 *
 * Потоки. Таймер osa вызывает orbit_tick в своем потоке, кнопки приходят из
 * потока notify. Состояние игры - под g_lock. POWER только прибавляет
 * атомарный счетчик нажатий, тик его забирает. Под g_lock не вызываются
 * repaint, leave_widget и timer_delete_ex. leave_widget вызывается только из
 * обработчика MENU, поэтому таймер никогда не удаляется из своего колбэка.
 *
 * Память - только статическая, 66 КБ: кадр 32 КБ, кэш планеты 17 КБ,
 * спрайты ракеты 9,5 КБ, состояние 6 КБ. Арифметика целочисленная, без float.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/types.h>

#include "oled.h"
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-variable"
#pragma GCC diagnostic ignored "-Wunused-function"
#include "oled_font.h"      /* ширины букв для выравнивания надписей */
#pragma GCC diagnostic pop
#include "oled_orbit.h"

extern void repaint(void);
extern void leave_widget(void);
extern void put_raw_buffer(uint8_t *from, uint32_t len);
extern void put_small_text(uint8_t x, uint8_t y, uint8_t w, uint8_t h,
                           uint8_t red, uint8_t green, uint8_t blue, char *text);
extern void put_large_text(uint8_t x, uint8_t y, uint8_t w, uint8_t h,
                           uint8_t red, uint8_t green, uint8_t blue, char *text);
extern uint32_t (*timer_create_ex)(uint32_t, uint32_t, void (*)(), uint32_t);
extern uint32_t (*timer_delete_ex)(uint32_t);
extern uint32_t lcd_state;      /* oled_widgets.c: LED_ON или LED_SLEEP */

#define SW 128
#define SH 128

/* ------------------------------------------------------------------ цвет */

/* кадр хранится как secret_screen_buf: RGB565, старший байт первым */
#define C565(r, g, b) ((uint16_t)((((r) >> 3) << 11) | (((g) >> 2) << 5) | ((b) >> 3)))
#define BSWAP16(c) ((uint16_t)((((c) >> 8) & 0xff) | (((c) & 0xff) << 8)))
#define RGB(r, g, b) BSWAP16(C565(r, g, b))

__attribute__((noinline)) static uint16_t rgb(int r, int g, int b) {
    if (r < 0) r = 0; else if (r > 255) r = 255;
    if (g < 0) g = 0; else if (g > 255) g = 255;
    if (b < 0) b = 0; else if (b > 255) b = 255;
    uint16_t c = (uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
    /* 0 - прозрачный цвет спрайтов, настоящий черный не нужен */
    return c ? BSWAP16(c) : BSWAP16(1);
}

/* a -> b на t/256 */
__attribute__((noinline)) static uint16_t mix(uint16_t from, uint16_t to, int t) {
    if (t <= 0) return from;
    if (t >= 256) return to;
    uint16_t x = BSWAP16(from), y = BSWAP16(to);
    int r1 = x >> 11, g1 = (x >> 5) & 63, b1 = x & 31;
    int r2 = y >> 11, g2 = (y >> 5) & 63, b2 = y & 31;
    int r = r1 + (((r2 - r1) * t) / 256);
    int gg = g1 + (((g2 - g1) * t) / 256);
    int bb = b1 + (((b2 - b1) * t) / 256);
    uint16_t c = (uint16_t)((r << 11) | (gg << 5) | bb);
    return BSWAP16(c);
}

/* яркость цвета на k/256 */
static uint16_t shade(int r, int g, int b, int k) {
    return rgb(r * k / 256, g * k / 256, b * k / 256);
}

/* ------------------------------------------------------- тригонометрия */

/* угол 0..255 - полный круг; значения Q14 */
static const int16_t SIN_Q[65] = {
    0, 402, 804, 1205, 1606, 2006, 2404, 2801, 3196, 3590, 3981, 4370, 4756,
    5139, 5520, 5897, 6270, 6639, 7005, 7366, 7723, 8076, 8423, 8765, 9102,
    9434, 9760, 10080, 10394, 10702, 11003, 11297, 11585, 11866, 12140, 12406,
    12665, 12916, 13160, 13395, 13623, 13842, 14053, 14256, 14449, 14635,
    14811, 14978, 15137, 15286, 15426, 15557, 15679, 15791, 15893, 15986,
    16069, 16143, 16207, 16261, 16305, 16340, 16364, 16379, 16384};

static int isin(int a) {
    a &= 255;
    if (a < 64) return SIN_Q[a];
    if (a < 128) return SIN_Q[128 - a];
    if (a < 192) return -SIN_Q[a - 128];
    return -SIN_Q[256 - a];
}
static int icos(int a) { return isin(a + 64); }

/* сдвиг вправо с округлением к ближайшему, одинаково для знаков */
static int rsh(int v, int n) {
    return v >= 0 ? (v + (1 << (n - 1))) >> n : -((-v + (1 << (n - 1))) >> n);
}

static int isqrt(int v) {
    if (v <= 0) return 0;
    unsigned int x = (unsigned int)v, r = 0, bit = 1u << 30;
    while (bit > x) bit >>= 2;
    while (bit) {
        if (x >= r + bit) {
            x -= r + bit;
            r = (r >> 1) + bit;
        } else {
            r >>= 1;
        }
        bit >>= 2;
    }
    return (int)r;
}

static int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* ------------------------------------------------------- параметры игры */

/* координаты и скорости Q8 (1/256 пикселя), время - кадры по ORBIT_TICK_MS */
#define Q 8
#define ROCKET_X 30
#define GRAVITY 33          /* 0,13 пикс/кадр^2 */
#define THRUST 170          /* за кадр тяги */
#define BURN_PER_PRESS 3    /* кадров тяги на нажатие */
#define BURN_MAX 6
#define VY_DOWN_MAX 900
#define VY_UP_MAX (-800)
#define CEIL_Y (11 << Q)    /* ниже строки счета */
#define FLOOR_Y (125 << Q)
#define FUEL_MAX (100 << Q)
#define FUEL_PER_PRESS 384    /* 1,5 из 100 */
#define FUEL_CAN (35 << Q)
#define LEVEL_FRAMES 700    /* 35 с */
#define SPEED0 384          /* 1,5 пикс/кадр */
#define SPEED_STEP 40
#define SPEED_MAX 900
#define TITLE_IDLE_FRAMES 600
#define OVER_BLINK_FRAMES 200
#define OVER_LOCK_FRAMES 16  /* после «Конец» POWER не сразу: случайное нажатие */
#define DYING_FRAMES 34
#define BANNER_FRAMES 64

enum { ST_TITLE, ST_READY, ST_PLAY, ST_PAUSE, ST_COUNTDOWN, ST_DYING, ST_OVER, ST_NOTIMER, ST_NOSCREEN };
enum { OB_NONE, OB_AST, OB_SAT, OB_DEB, OB_WALL };
enum { BN_NONE, BN_STAR, BN_FUEL, BN_SHIELD };
enum { CAUSE_NONE, CAUSE_AST, CAUSE_SAT, CAUSE_DEB, CAUSE_WALL, CAUSE_FALL, CAUSE_FUEL };

static const char *const CAUSE_TEXT[] = {
    "", "Удар об астероид", "Удар о спутник", "Удар об обломок",
    "Удар о стену", "Ракета упала", "Кончилось топливо"};

static const char *const STAGE_NAME[2][5] = {
    {"Взлет", "Орбита", "Пояс обломков", "Астероиды", "Луна близко"},
    {"Разгон", "Орбита", "Пояс обломков", "Астероиды", "Марс близко"}};

/* фон уровней: верх и низ градиента */
static const uint8_t STAGE_BG[5][6] = {
    {4, 6, 24, 12, 26, 72},
    {3, 5, 20, 10, 12, 44},
    {10, 4, 26, 30, 10, 44},
    {14, 6, 12, 40, 16, 22},
    {2, 2, 10, 18, 20, 34}};

/* веса выбора препятствия: астероид, спутник, обломки, стена */
static const uint8_t STAGE_MIX[5][4] = {
    {100, 0, 0, 0},
    {55, 45, 0, 12},
    {30, 20, 40, 16},
    {60, 15, 15, 16},
    {35, 25, 25, 20}};
static const uint8_t LAP_STAGE0_MIX[4] = {50, 30, 20, 12};

static const uint8_t AST_RMIN[5] = {4, 5, 4, 6, 4};
static const uint8_t AST_RMAX[5] = {8, 10, 9, 14, 14};

/* --------------------------------------------------------------- данные */

#define MAX_OBST 24
#define MAX_BONUS 8
#define MAX_PART 112
#define MAX_RING 6
#define MAX_FLOAT 6
#define MAX_STARS 44
#define MAX_TEXTS 8

struct obst {
    uint8_t type, kind, flags;
    uint8_t ang;            /* поворот */
    int8_t angv;
    int16_t r;              /* астероид - радиус, спутник - полудлина панелей, стена - полупроход */
    int16_t base_y;         /* спутник, стена: середина колебаний */
    int16_t amp;            /* размах колебаний */
    uint8_t phase;
    int32_t x, y, vx, vy;
    int16_t lim2[16];       /* астероид: квадрат радиуса по направлениям */
    int8_t cr[3][3];        /* астероид: кратеры (угол/4, расстояние, радиус) */
};
#define OF_PASSED 1
#define OF_NEAR 2

struct bonus {
    uint8_t type, phase;
    int16_t base_y;
    int32_t x, y;
};

struct part {
    int32_t x, y, vx, vy;
    int16_t ay;
    uint8_t life, max, ramp, big;
};

struct ring {
    int16_t x, y;
    uint8_t t, max;
    uint16_t color;
};

struct floater {
    int16_t x, y;
    uint8_t t;
    uint16_t color;
    char s[8];
};

struct star {
    int32_t x;
    uint8_t y, layer, phase, bright;
};

struct otext {
    int16_t x, y;
    uint8_t large, shadow, r, g, b;
    char s[40];
};

static struct {
    int state, prev_state;
    uint32_t frame, st_frames, idle;
    int dirty;                  /* кадр изменился - нужен repaint */

    int32_t ry, rvy;
    int tilt;                   /* градусы, + нос вверх */
    int burn, fuel, shield, invuln;
    int32_t speed, scroll;      /* scroll - текущая прокрутка (замедляется при гибели) */
    uint32_t score, best;
    int new_record, cause;
    int level, level_frame, level_len;
    int banner, banner_kind;
    int32_t dist_acc, spawn_acc;
    int star_cd, fuel_cd, shield_cd, wall_cd;
    int combo, combo_t;
    int shake, flash, countdown, launch_text;
    int pal_from, pal_to, pal_t;
    int pl_x_off, pl_exit, pl_kind;
    int title_x;
    uint32_t rng;

    struct obst ob[MAX_OBST];
    struct bonus bn[MAX_BONUS];
    struct part pt[MAX_PART];
    struct ring rg[MAX_RING];
    struct floater fl[MAX_FLOAT];
    struct star st[MAX_STARS];

    struct otext tx[MAX_TEXTS];
    int ntx;
} g;

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static int g_alive;             /* под g_lock: игра открыта */
static uint32_t g_timer;        /* под g_lock */
static int g_presses;           /* атомарно: нажатия POWER с прошлого тика */
static int g_tables_ready;

static uint16_t fb[SW * SH];
static int cam_x, cam_y;        /* тряска */

/* --------------------------------------------------------- случайности */

static uint32_t rnd32(void) {
    uint32_t x = g.rng;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    g.rng = x;
    return x;
}
static int rnd(int n) { return n > 0 ? (int)(rnd32() % (uint32_t)n) : 0; }
static int rnd_range(int lo, int hi) { return lo + rnd(hi - lo + 1); }

static void seed_rng(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    g.rng = (uint32_t)ts.tv_nsec ^ ((uint32_t)ts.tv_sec << 12) ^ 0x9e3779b9u;
    if (!g.rng) g.rng = 1;
}

/* ---------------------------------------------------------- рисование */

static void px(int x, int y, uint16_t c) {
    if ((unsigned)x < SW && (unsigned)y < SH) fb[y * SW + x] = c;
}
__attribute__((noinline)) static void pxa(int x, int y, uint16_t c, int a) {
    if ((unsigned)x < SW && (unsigned)y < SH) fb[y * SW + x] = mix(fb[y * SW + x], c, a);
}
static void rect(int x, int y, int w, int h, uint16_t c) {
    int x0 = clampi(x, 0, SW), x1 = clampi(x + w, 0, SW);
    int y0 = clampi(y, 0, SH), y1 = clampi(y + h, 0, SH);
    for (int yy = y0; yy < y1; yy += 1)
        for (int xx = x0; xx < x1; xx += 1) fb[yy * SW + xx] = c;
}
static void circle(int cx, int cy, int r, uint16_t c, int a) {
    int x = r, y = 0, err = 1 - r;
    while (x >= y) {
        pxa(cx + x, cy + y, c, a); pxa(cx - x, cy + y, c, a);
        pxa(cx + x, cy - y, c, a); pxa(cx - x, cy - y, c, a);
        if (x != y) {
            pxa(cx + y, cy + x, c, a); pxa(cx - y, cy + x, c, a);
            pxa(cx + y, cy - x, c, a); pxa(cx - y, cy - x, c, a);
        }
        y += 1;
        if (err < 0) {
            err += 2 * y + 1;
        } else {
            x -= 1;
            err += 2 * (y - x) + 1;
        }
    }
}
static void blit(const uint16_t *spr, int w, int h, int x0, int y0) {
    for (int y = 0; y < h; y += 1) {
        int yy = y0 + y;
        if ((unsigned)yy >= SH) continue;
        for (int x = 0; x < w; x += 1) {
            uint16_t c = spr[y * w + x];
            int xx = x0 + x;
            if (c && (unsigned)xx < SW) fb[yy * SW + xx] = c;
        }
    }
}
static void dim_frame(int t) {
    uint16_t k = RGB(0, 0, 0);
    for (int i = 0; i < SW * SH; i += 1) fb[i] = mix(fb[i], k, t);
}

/* цифры 3x5 для счета: строки сверху вниз по 3 бита */
static const uint16_t TINY[12] = {
    0x7B6F, 0x2C97, 0x73E7, 0x72CF, 0x5BC9, 0x79CF, 0x79EF, 0x7292, 0x7BEF, 0x7BCF,
    0x05D0, /* + */
    0x0000};

static int tiny_glyph(char ch) {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch == '+') return 10;
    return 11;
}
static int tiny_text(int x, int y, const char *s, uint16_t c, int a) {
    for (; *s; s += 1) {
        uint16_t gl = TINY[tiny_glyph(*s)];
        for (int row = 0; row < 5; row += 1)
            for (int col = 0; col < 3; col += 1)
                if (gl & (1 << (14 - row * 3 - col))) {
                    if (a >= 256) px(x + col, y + row, c);
                    else pxa(x + col, y + row, c, a);
                }
        x += 4;
    }
    return x;
}

/* ------------------------------------------------------------- надписи */

static int text_width(const char *s, int large) {
    uint8_t *p = (uint8_t *)s;
    int w = 0;
    while (*p) {
        uint8_t i = get_char_idx_and_go_next(&p);
        w += large ? LARGE_FONT_WIDTHS[i] : SMALL_FONT_WIDTHS[i];
    }
    return w;
}

/* надпись в кадр шрифтом SMALL_FONT hijack_ng: под препятствиями, с тенью и прозрачностью */
static void fb_text(int x, int y, const char *s, uint16_t c, int alpha) {
    if (x < 0) x = (SW - text_width(s, 0)) / 2;
    for (int pass = 0; pass < 2; pass += 1) {
        uint8_t *p = (uint8_t *)s;
        int cx = x;
        while (*p) {
            uint8_t i = get_char_idx_and_go_next(&p);
            int w = SMALL_FONT_WIDTHS[i];
            for (int ly = 0; ly < SMALL_FONT_SIZE; ly += 1)
                for (int lx = 0; lx < w && lx < 16; lx += 1)
                    if (SMALL_FONT[i][ly * SMALL_FONT_BYTES_PER_CHAR + lx / 8] & (0x80 >> (lx % 8))) {
                        if (pass == 0) pxa(cx + lx + 1, y + ly + 1, RGB(0, 0, 0), alpha / 2);
                        else pxa(cx + lx, y + ly, c, alpha);
                    }
            cx += w;
        }
    }
}

/* x < 0 - по центру */
static void add_text(int large, int x, int y, int r, int gg, int b, int shadow, const char *fmt, ...) {
    if (g.ntx >= MAX_TEXTS) return;
    struct otext *t = &g.tx[g.ntx];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(t->s, sizeof(t->s), fmt, ap);
    va_end(ap);
    if (x < 0) x = (SW - text_width(t->s, large)) / 2;
    t->x = (int16_t)clampi(x, 0, SW - 1);
    t->y = (int16_t)clampi(y, 0, SH - 1);
    t->large = (uint8_t)large;
    t->shadow = (uint8_t)shadow;
    t->r = (uint8_t)clampi(r, 0, 255);
    t->g = (uint8_t)clampi(gg, 0, 255);
    t->b = (uint8_t)clampi(b, 0, 255);
    g.ntx += 1;
}

/* ------------------------------------------------------------ спрайты */

/* ракета носом вправо, 20x11; центр поворота (10,5) */
static const char *const ROCKET_ART[11] = {
    "rrr.................",
    ".rrrr...............",
    "..rrrrrr............",
    "..WWWWWWRRWWWWNN....",
    "GGWWWWWWRRWhBWNNNN..",
    "GGWWWWWWRRWBBWNNNNNN",
    "GGwwwwwwRRwBBwnnnn..",
    "..wwwwwwRRwwwwnn....",
    "..rrrrrr............",
    ".rrrr...............",
    "rrr................."};

#define RS 23
#define RS_C 11
static uint16_t rocket_spr[9][RS * RS];
static uint8_t ang_lut[31][31];     /* направление от центра, 0..255 */

static uint16_t art_color(char ch) {
    switch (ch) {
    case 'W': return RGB(240, 240, 244);
    case 'w': return RGB(196, 198, 212);
    case 'N': return RGB(228, 228, 234);
    case 'n': return RGB(186, 188, 200);
    case 'R': return RGB(213, 43, 30);
    case 'r': return RGB(186, 34, 26);
    case 'G': return RGB(120, 120, 132);
    case 'B': return RGB(70, 120, 210);
    case 'h': return RGB(170, 210, 255);
    default: return 0;
    }
}

static int deg_to_ang(int deg) { return (deg * 256 + (deg >= 0 ? 180 : -180)) / 360; }

static void build_tables(void) {
    for (int k = 0; k < 9; k += 1) {
        int a = deg_to_ang((k - 4) * 10);
        int c = icos(a), s = isin(a);
        for (int dy = -RS_C; dy <= RS_C; dy += 1)
            for (int dx = -RS_C; dx <= RS_C; dx += 1) {
                /* обратный поворот: точка кадра -> точка рисунка */
                int ax = 10 + rsh(dx * c - dy * s, 14);
                int ay = 5 + rsh(dx * s + dy * c, 14);
                uint16_t col = 0;
                if (ax >= 0 && ax < 20 && ay >= 0 && ay < 11) col = art_color(ROCKET_ART[ay][ax]);
                rocket_spr[k][(dy + RS_C) * RS + dx + RS_C] = col;
            }
    }
    for (int dy = -15; dy <= 15; dy += 1)
        for (int dx = -15; dx <= 15; dx += 1) {
            int best = 0, bd = -0x7fffffff;
            for (int a = 0; a < 256; a += 1) {
                int d = dx * icos(a) + dy * isin(a);
                if (d > bd) {
                    bd = d;
                    best = a;
                }
            }
            ang_lut[dy + 15][dx + 15] = (uint8_t)best;
        }
}

/* --------------------------------------------------------- фон и планета */

#define PL_RMAX 46
#define PL_DIM (2 * PL_RMAX + 1)
static uint16_t pl_buf[PL_DIM * PL_DIM];
static int pl_r = -1, pl_kind_built = -1;

/* пятна: x, y, радиус в долях радиуса планеты (Q8) */
static const int8_t MOON_SPOTS[6][3] = {
    {-70, -50, 80}, {60, 60, 60}, {20, -110, 40}, {-90, 90, 36}, {100, -40, 30}, {-10, 30, 26}};

static void planet_build(int r, int kind) {
    int d = 2 * r + 1;
    int br, bgc, bb, dr, dg, db;
    if (kind == 0) {        /* Луна */
        br = 200; bgc = 205; bb = 215; dr = 150; dg = 156; db = 172;
    } else {                /* Марс */
        br = 210; bgc = 108; bb = 66; dr = 150; dg = 66; db = 44;
    }
    for (int dy = -r; dy <= r; dy += 1)
        for (int dx = -r; dx <= r; dx += 1) {
            int d2 = dx * dx + dy * dy;
            uint16_t col = 0;
            if (d2 <= r * r + r / 2) {
                int cr = br, cg = bgc, cb = bb;
                for (int i = 0; i < 6; i += 1) {
                    int sx = MOON_SPOTS[i][0] * r / 256, sy = MOON_SPOTS[i][1] * r / 256;
                    int sr = MOON_SPOTS[i][2] * r / 256 + 1;
                    int e = (dx - sx) * (dx - sx) + (dy - sy) * (dy - sy);
                    if (e <= sr * sr) {
                        cr = dr; cg = dg; cb = db;
                        if (e > sr * sr - 2 * sr && dy < sy) { cr = dr - 20; cg = dg - 20; cb = db - 16; }
                        break;
                    }
                }
                if (kind == 1 && dy < -r * 3 / 4) { cr = 236; cg = 232; cb = 226; }
                /* свет слева сверху, края темнее */
                int k = 230 + (-dx * 50 - dy * 40) / (r ? r : 1) - d2 * 70 / (r * r + 1);
                k = k * 200 / 256;   /* планета на фоне, приглушена */
                col = shade(cr, cg, cb, clampi(k, 40, 300));
            }
            pl_buf[(dy + r) * d + dx + r] = col;
        }
    pl_r = r;
    pl_kind_built = kind;
}

static void bg_colors(int y, int *r, int *gg, int *b) {
    const uint8_t *a = STAGE_BG[g.pal_from], *c = STAGE_BG[g.pal_to];
    int t = g.pal_t;
    int r0 = a[0] + (c[0] - a[0]) * t / 256, g0 = a[1] + (c[1] - a[1]) * t / 256, b0 = a[2] + (c[2] - a[2]) * t / 256;
    int r1 = a[3] + (c[3] - a[3]) * t / 256, g1 = a[4] + (c[4] - a[4]) * t / 256, b1 = a[5] + (c[5] - a[5]) * t / 256;
    *r = r0 + (r1 - r0) * y / (SH - 1);
    *gg = g0 + (g1 - g0) * y / (SH - 1);
    *b = b0 + (b1 - b0) * y / (SH - 1);
}

static void draw_background(void) {
    for (int y = 0; y < SH; y += 1) {
        int r, gg, b;
        bg_colors(y, &r, &gg, &b);
        uint16_t c = rgb(r, gg, b);
        uint16_t *p = fb + y * SW;
        for (int x = 0; x < SW; x += 1) p[x] = c;
    }
}

static void stars_init(void) {
    for (int i = 0; i < MAX_STARS; i += 1) {
        struct star *s = &g.st[i];
        s->x = rnd(SW) << Q;
        s->y = (uint8_t)rnd(SH);
        s->layer = (uint8_t)(i < 22 ? 0 : (i < 36 ? 1 : 2));
        s->phase = (uint8_t)rnd(256);
        s->bright = (uint8_t)rnd_range(0, 60);
    }
}

static const int STAR_PAR[3] = {40, 96, 200};

static void stars_move(int32_t scroll) {
    for (int i = 0; i < MAX_STARS; i += 1) {
        struct star *s = &g.st[i];
        s->x -= scroll * STAR_PAR[s->layer] / 256;
        if (s->x < 0) {
            s->x += SW << Q;
            s->y = (uint8_t)rnd(SH);
        }
        s->phase = (uint8_t)(s->phase + 3 + s->layer);
    }
}

static void draw_stars(int layer_min, int layer_max) {
    for (int i = 0; i < MAX_STARS; i += 1) {
        struct star *s = &g.st[i];
        if (s->layer < layer_min || s->layer > layer_max) continue;
        int x = s->x >> Q, y = s->y;
        int base = s->layer == 0 ? 90 : (s->layer == 1 ? 150 : 210);
        int v = base + s->bright + (isin(s->phase) * 30 >> 14);
        if (s->layer == 2 && (s->phase & 0x80) && i % 3 == 0) {
            /* крупная звезда крестиком */
            uint16_t c2 = rgb(v * 3 / 5, v * 3 / 5, v * 2 / 3);
            px(x - 1, y, c2); px(x + 1, y, c2); px(x, y - 1, c2); px(x, y + 1, c2);
        }
        px(x, y, rgb(v, v, v + 10));
    }
}

static int planet_radius(void) {
    int stage = (g.level - 1) % 5;
    int len = g.level_len > 0 ? g.level_len : LEVEL_FRAMES;
    int prog = (stage * len + clampi(g.level_frame, 0, len)) * 256 / (5 * len);
    return clampi(5 + 41 * prog / 256, 5, PL_RMAX);
}

static void draw_planet(void) {
    int r = g.pl_exit ? PL_RMAX : planet_radius();   /* облет: большая уходит влево */
    int prog = (r - 5) * 256 / 41;
    if (r != pl_r || g.pl_kind != pl_kind_built) planet_build(r, g.pl_kind);
    int cx = 100 + 8 * prog / 256 - g.pl_x_off, cy = 24 + 14 * prog / 256;
    blit(pl_buf, 2 * pl_r + 1, 2 * pl_r + 1, cx - pl_r, cy - pl_r);
}

/* Земля внизу на первом уровне, уходит по мере подъема */
static void draw_earth(int eh, int rot) {
    if (eh <= 0) return;
    const int R = 200;
    int cy = SH - eh + R;
    for (int x = 0; x < SW; x += 1) {
        int dx = x - 64;
        int top = cy - isqrt(R * R - dx * dx);
        for (int k = 1; k <= 3; k += 1) pxa(x, top - k, RGB(80, 150, 255), 130 - k * 35);
        for (int y = top; y < SH; y += 1) {
            int dd = y - top;
            uint16_t c;
            if (dd == 0) c = RGB(170, 220, 255);
            else if (dd == 1) c = RGB(100, 170, 245);
            else {
                int u = (x + rot) & 63, v = dd;
                int land = ((u * 7 + v * 3) % 23 < 7) && ((u / 9 + v / 4) % 3 == 0);
                int cloud = ((u * 5 + v * 11) % 37 == 0);
                if (cloud) c = RGB(220, 230, 240);
                else if (land) c = shade(70, 130, 70, 256 - dd * 6);
                else c = shade(30, 80, 170, 256 - dd * 6);
            }
            px(x, y, c);
        }
    }
}

static int earth_height(void) {
    if (g.state == ST_TITLE) return 9;
    if (g.level != 1) return 0;
    if (g.state == ST_READY) return 22;
    int len = g.level_len > 0 ? g.level_len : LEVEL_FRAMES;
    return 22 - 26 * clampi(g.level_frame, 0, len) / (len / 2 + 1);
}

/* ------------------------------------------------------------ частицы */

static const uint16_t *ramp_colors(int ramp, int *n) {
    static uint16_t ramps[7][6];
    static int ready = 0;
    if (!ready) {
        const uint8_t src[7][6][3] = {
            {{255, 250, 210}, {255, 220, 90}, {255, 150, 30}, {230, 70, 20}, {140, 30, 20}, {70, 30, 30}},      /* огонь */
            {{255, 255, 255}, {255, 230, 120}, {255, 170, 50}, {220, 80, 30}, {120, 60, 60}, {70, 66, 76}},    /* взрыв */
            {{220, 250, 255}, {120, 220, 255}, {70, 170, 240}, {40, 110, 200}, {30, 60, 140}, {20, 30, 80}},   /* щит */
            {{255, 255, 220}, {255, 240, 120}, {255, 210, 60}, {220, 160, 40}, {150, 100, 30}, {80, 60, 30}},  /* звезда */
            {{200, 200, 210}, {170, 170, 180}, {140, 140, 150}, {110, 110, 120}, {80, 80, 90}, {50, 50, 60}},  /* дым, осколки */
            {{220, 255, 220}, {130, 240, 150}, {80, 210, 110}, {50, 160, 80}, {30, 110, 60}, {20, 60, 40}},    /* топливо */
            {{255, 255, 255}, {240, 240, 244}, {213, 43, 30}, {200, 200, 210}, {160, 40, 30}, {90, 90, 100}}};  /* корпус */
        for (int i = 0; i < 7; i += 1)
            for (int j = 0; j < 6; j += 1) ramps[i][j] = rgb(src[i][j][0], src[i][j][1], src[i][j][2]);
        ready = 1;
    }
    *n = 6;
    return ramps[clampi(ramp, 0, 6)];
}
enum { RAMP_FIRE, RAMP_BOOM, RAMP_SHIELD, RAMP_STAR, RAMP_SMOKE, RAMP_FUEL, RAMP_HULL };

static void emit(int32_t x, int32_t y, int32_t vx, int32_t vy, int life, int ramp, int big, int ay) {
    for (int i = 0; i < MAX_PART; i += 1) {
        struct part *p = &g.pt[i];
        if (p->life) continue;
        p->x = x; p->y = y; p->vx = vx; p->vy = vy;
        p->life = p->max = (uint8_t)clampi(life, 1, 255);
        p->ramp = (uint8_t)ramp; p->big = (uint8_t)big; p->ay = (int16_t)ay;
        return;
    }
}

static void burst(int32_t x, int32_t y, int n, int speed, int life, int ramp, int big) {
    for (int i = 0; i < n; i += 1) {
        int a = rnd(256), sp = rnd_range(speed / 3, speed);
        emit(x, y, icos(a) * sp >> 14, isin(a) * sp >> 14, rnd_range(life / 2, life), ramp, big && rnd(2), 0);
    }
}

static void parts_update(void) {
    for (int i = 0; i < MAX_PART; i += 1) {
        struct part *p = &g.pt[i];
        if (!p->life) continue;
        p->x += p->vx; p->y += p->vy; p->vy += p->ay;
        p->vx -= p->vx / 16; p->vy -= p->vy / 16;
        p->life -= 1;
    }
    for (int i = 0; i < MAX_RING; i += 1)
        if (g.rg[i].t) g.rg[i].t -= 1;
    for (int i = 0; i < MAX_FLOAT; i += 1)
        if (g.fl[i].t) {
            g.fl[i].t -= 1;
            if (g.fl[i].t & 1) g.fl[i].y -= 1;
        }
}

static void draw_parts(void) {
    for (int i = 0; i < MAX_PART; i += 1) {
        struct part *p = &g.pt[i];
        if (!p->life) continue;
        int n;
        const uint16_t *rc = ramp_colors(p->ramp, &n);
        int idx = (p->max - p->life) * n / p->max;
        uint16_t c = rc[clampi(idx, 0, n - 1)];
        int x = (p->x >> Q) + cam_x, y = (p->y >> Q) + cam_y;
        px(x, y, c);
        if (p->big && p->life * 2 > p->max) {
            px(x + 1, y, c); px(x, y + 1, c); px(x + 1, y + 1, c);
        }
    }
}

static void add_ring(int x, int y, uint16_t c) {
    for (int i = 0; i < MAX_RING; i += 1)
        if (!g.rg[i].t) {
            g.rg[i].x = (int16_t)x; g.rg[i].y = (int16_t)y;
            g.rg[i].t = g.rg[i].max = 9; g.rg[i].color = c;
            return;
        }
}

static void add_floater(int x, int y, uint16_t c, const char *s) {
    int slot = 0;
    for (int i = 0; i < MAX_FLOAT; i += 1)
        if (g.fl[i].t < g.fl[slot].t) slot = i;
    struct floater *f = &g.fl[slot];
    f->x = (int16_t)clampi(x, 0, SW - 16); f->y = (int16_t)clampi(y, 9, SH - 6);
    f->t = 26; f->color = c;
    snprintf(f->s, sizeof(f->s), "%s", s);
}

static void draw_fx(void) {
    for (int i = 0; i < MAX_RING; i += 1) {
        struct ring *r = &g.rg[i];
        if (!r->t) continue;
        int age = r->max - r->t;
        circle(r->x + cam_x, r->y + cam_y, 2 + age * 2, r->color, 256 - age * 24);
        if (age < 4) circle(r->x + cam_x, r->y + cam_y, 1 + age, RGB(255, 255, 255), 200);
    }
    for (int i = 0; i < MAX_FLOAT; i += 1) {
        struct floater *f = &g.fl[i];
        if (!f->t) continue;
        int a = f->t > 12 ? 256 : f->t * 20;
        tiny_text(f->x + 1, f->y + 1, f->s, RGB(0, 0, 0), a / 2);
        tiny_text(f->x, f->y, f->s, f->color, a);
    }
}

/* --------------------------------------------------------- препятствия */

static struct obst *obst_alloc(void) {
    for (int i = 0; i < MAX_OBST; i += 1)
        if (g.ob[i].type == OB_NONE) {
            memset(&g.ob[i], 0, sizeof(g.ob[i]));
            return &g.ob[i];
        }
    return NULL;
}

static int stage_of(int level) { return (level - 1) % 5; }
static int lap_of(int level) { return (level - 1) / 5; }

static void spawn_asteroid(void) {
    struct obst *o = obst_alloc();
    if (!o) return;
    int stage = stage_of(g.level), lap = lap_of(g.level);
    o->type = OB_AST;
    o->r = (int16_t)rnd_range(AST_RMIN[stage], AST_RMAX[stage] + (lap ? 1 : 0));
    o->kind = 0;
    o->vx = -rnd(64);
    o->r = (int16_t)clampi(o->r, 3, 15);    /* ang_lut: до 15 пикс */
    if ((stage >= 1 || lap) && rnd(100) < 22 + 8 * stage) {
        o->kind = 1;                    /* быстрый железный */
        o->r = (int16_t)clampi(o->r, 4, 8);
        o->vx = -rnd_range(90, 200 + 30 * stage);
    } else if (o->r >= 11) {
        o->kind = 2;                    /* большой ледяной, медленнее прокрутки */
        o->vx = rnd_range(20, 70);
    }
    if (stage >= 2 || lap) o->vy = rnd_range(-50, 50) * (o->kind == 1 ? 2 : 1);
    o->x = (SW + o->r + 2) << Q;
    o->y = rnd_range(12 + o->r, SH - 4 - o->r) << Q;
    o->ang = (uint8_t)rnd(256);
    o->angv = (int8_t)((rnd(2) ? 1 : -1) * rnd_range(1, 3));
    for (int i = 0; i < 16; i += 1) {
        int f = rnd_range(196, 256);
        int rr = o->r * f;            /* Q8 */
        o->lim2[i] = (int16_t)((rr * rr) >> 16);
    }
    for (int i = 0; i < 3; i += 1) {
        o->cr[i][0] = (int8_t)rnd(64);
        o->cr[i][1] = (int8_t)(o->r * rnd_range(20, 60) / 100);
        o->cr[i][2] = (int8_t)clampi(o->r / 4 + rnd(2), 1, 4);
    }
}

static void spawn_satellite(void) {
    struct obst *o = obst_alloc();
    if (!o) return;
    int stage = stage_of(g.level);
    o->type = OB_SAT;
    o->r = (int16_t)rnd_range(10, 14 + (stage >= 3 ? 2 : 0));
    o->base_y = (int16_t)rnd_range(22, SH - 22);
    o->amp = (int16_t)rnd_range(0, 8);
    o->phase = (uint8_t)rnd(256);
    o->x = (SW + o->r + 4) << Q;
    o->y = o->base_y << Q;
    o->vx = -rnd(50);
    o->ang = (uint8_t)rnd(256);
    o->angv = (int8_t)((rnd(2) ? 1 : -1) * rnd_range(1, 2 + stage / 2));
    o->kind = (uint8_t)rnd(2);
}

static void spawn_debris(void) {
    int stage = stage_of(g.level);
    int n = rnd_range(4, 6 + stage / 2);
    int y0 = rnd_range(20, SH - 30);
    int slope = rnd_range(-3, 3);
    int vx = -rnd_range(90, 200);
    int x = SW + 4;
    for (int i = 0; i < n; i += 1) {
        struct obst *o = obst_alloc();
        if (!o) return;
        o->type = OB_DEB;
        o->r = 2;
        o->x = x << Q;
        o->y = clampi(y0 + i * slope * 3 + rnd_range(-2, 2), 12, SH - 6) << Q;
        o->vx = vx + rnd(40);
        o->vy = slope * 6 + rnd_range(-8, 8);
        o->ang = (uint8_t)rnd(256);
        o->kind = (uint8_t)rnd(3);
        x += rnd_range(8, 13);
    }
}

static void spawn_wall(void) {
    struct obst *o = obst_alloc();
    if (!o) return;
    o->type = OB_WALL;
    o->r = (int16_t)clampi(23 - g.level, 17, 22);
    o->amp = (int16_t)(g.level >= 4 ? rnd_range(6, 12) : 0);
    int lo = 12 + o->r + o->amp, hi = SH - 4 - o->r - o->amp;
    o->base_y = (int16_t)rnd_range(lo, hi);
    o->phase = (uint8_t)rnd(256);
    o->x = (SW + 2) << Q;
    o->y = o->base_y << Q;
    o->vx = 0;
}

static int obstacle_rightmost(void) {
    int m = -1000;
    for (int i = 0; i < MAX_OBST; i += 1)
        if (g.ob[i].type != OB_NONE) {
            int x = (g.ob[i].x >> Q) + g.ob[i].r;
            if (x > m) m = x;
        }
    return m;
}

static void spawn_obstacle(void) {
    int stage = stage_of(g.level), lap = lap_of(g.level);
    const uint8_t *mix_w = (stage == 0 && lap) ? LAP_STAGE0_MIX : STAGE_MIX[stage];
    int w[4] = {mix_w[0], mix_w[1], mix_w[2], mix_w[3]};
    if (g.level < 2 || g.wall_cd > 0 || obstacle_rightmost() > SW - 36) w[3] = 0;
    int sum = w[0] + w[1] + w[2] + w[3];
    int pick = rnd(sum), kind = 0;
    while (kind < 3 && pick >= w[kind]) pick -= w[kind++];
    int gap;
    switch (kind) {
    case 0: spawn_asteroid(); gap = 0; break;
    case 1: spawn_satellite(); gap = 10; break;
    case 2: spawn_debris(); gap = 40; break;
    default:
        spawn_wall();
        g.wall_cd = 300;
        gap = 46;
        break;
    }
    int base = clampi(62 - 6 * (g.level - 1), 30, 62);
    g.spawn_acc += (base + gap + rnd(28)) << Q;
}

/* ------------------------------------------------------------- бонусы */

/* свободна ли точка от препятствий (для бонуса) */
static int place_ok(int x, int y) {
    for (int i = 0; i < MAX_OBST; i += 1) {
        struct obst *o = &g.ob[i];
        if (o->type == OB_NONE) continue;
        int ox = o->x >> Q, oy = o->y >> Q;
        if (o->type == OB_WALL) {
            if (x > ox - 14 && x < ox + 22 && (y < oy - o->r + 7 || y > oy + o->r - 7)) return 0;
            continue;
        }
        int rr = (o->type == OB_SAT ? o->r : o->r) + 10;
        if (abs(x - ox) < rr + 6 && abs(y - oy) < rr) return 0;
    }
    return 1;
}

static struct bonus *bonus_alloc(void) {
    for (int i = 0; i < MAX_BONUS; i += 1)
        if (g.bn[i].type == BN_NONE) return &g.bn[i];
    return NULL;
}

static int spawn_bonus_at(int type, int x, int y) {
    struct bonus *b = bonus_alloc();
    if (!b) return 0;
    b->type = (uint8_t)type;
    b->x = x << Q;
    b->base_y = (int16_t)y;
    b->y = y << Q;
    b->phase = (uint8_t)rnd(256);
    return 1;
}

/* y, где можно поставить бонус у правого края; -1 - нет места */
static int bonus_y(int x) {
    /* если рядом стена - в ее проход */
    for (int i = 0; i < MAX_OBST; i += 1) {
        struct obst *o = &g.ob[i];
        if (o->type == OB_WALL && abs((o->x >> Q) + 4 - x) < 30) return o->y >> Q;
    }
    for (int k = 0; k < 8; k += 1) {
        int y = rnd_range(18, SH - 16);
        if (place_ok(x, y)) return y;
    }
    return -1;
}

static void bonus_director(void) {
    if (g.star_cd > 0) g.star_cd -= 1;
    if (g.fuel_cd > 0) g.fuel_cd -= 1;
    if (g.shield_cd > 0) g.shield_cd -= 1;
    int x = SW + 6;
    if (g.fuel_cd == 0 && g.fuel < FUEL_MAX * 85 / 100) {
        int y = bonus_y(x);
        if (y >= 0 && spawn_bonus_at(BN_FUEL, x, y)) g.fuel_cd = g.fuel < FUEL_MAX / 3 ? rnd_range(90, 130) : rnd_range(180, 240);
        else g.fuel_cd = 8;
        return;
    }
    if (g.shield_cd == 0 && !g.shield && g.level >= 2) {
        int y = bonus_y(x);
        if (y >= 0 && spawn_bonus_at(BN_SHIELD, x, y)) g.shield_cd = rnd_range(500, 760);
        else g.shield_cd = 8;
        return;
    }
    if (g.star_cd == 0) {
        int y = bonus_y(x);
        if (y < 0) {
            g.star_cd = 6;
            return;
        }
        int pattern = rnd(4), n = 1;
        if (pattern == 1) n = 3;
        if (pattern >= 2) n = 5;
        for (int i = 0; i < n; i += 1) {
            int yy = y;
            if (pattern == 2) yy = y - (isin(i * 32) * 14 >> 14);         /* дуга */
            if (pattern == 3) yy = y + (i - 2) * 5;                      /* наклонная линия */
            yy = clampi(yy, 14, SH - 10);
            if (place_ok(x + i * 11, yy)) spawn_bonus_at(BN_STAR, x + i * 11, yy);
        }
        g.star_cd = rnd_range(60, 120);
    }
}

/* ------------------------------------------------------------- ракета */

static int rocket_k(void) { return clampi((g.tilt + 45) / 10, 0, 8); }

/* ось ракеты: направление носа Q14 */
static void rocket_dir(int *dx, int *dy) {
    int a = deg_to_ang((rocket_k() - 4) * 10);
    *dx = icos(a);
    *dy = -isin(a);
}

/* квадрат расстояния от точки (Q4) до оси ракеты (Q4) */
static int rocket_dist2(int px4, int py4) {
    int dx, dy;
    rocket_dir(&dx, &dy);
    int cx = ROCKET_X * 16, cy = g.ry >> (Q - 4);
    int ax = cx - (dx * 7 >> 10), ay = cy - (dy * 7 >> 10);   /* 7 пикс назад, Q4 */
    int bx = cx + (dx * 8 >> 10), by = cy + (dy * 8 >> 10);   /* 8 пикс вперед */
    int64_t ex = bx - ax, ey = by - ay;
    int64_t wx = px4 - ax, wy = py4 - ay;
    int64_t len2 = ex * ex + ey * ey, t = wx * ex + wy * ey;
    int64_t qx, qy;
    if (t <= 0 || len2 == 0) {
        qx = ax; qy = ay;
    } else if (t >= len2) {
        qx = bx; qy = by;
    } else {
        qx = ax + ex * t / len2;
        qy = ay + ey * t / len2;
    }
    int64_t ddx = px4 - qx, ddy = py4 - qy;
    int64_t d2 = ddx * ddx + ddy * ddy;
    return d2 > 0x7fffffff ? 0x7fffffff : (int)d2;
}

#define ROCKET_R4 32        /* полутолщина корпуса для столкновений, 2 пикс в Q4 */

static void draw_flame(void) {
    int dx, dy;
    rocket_dir(&dx, &dy);
    int cx = ROCKET_X + cam_x, cy = (g.ry >> Q) + cam_y;
    int nx = cx * 16 - (dx * 10 >> 10), ny = cy * 16 - (dy * 10 >> 10);  /* сопло, Q4 */
    int len = g.burn ? rnd_range(7, 10) : (g.state == ST_PLAY || g.state == ST_READY ? rnd_range(1, 3) : 0);
    for (int t = 0; t < len; t += 1) {
        int hw = (len - t) * 2 / (len + 1) + (t < 2 && len > 4 ? 1 : 0);
        int qx = nx - (dx * t >> 10), qy = ny - (dy * t >> 10);
        uint16_t c = t < len / 3 ? RGB(255, 245, 170) : (t < 2 * len / 3 ? RGB(255, 160, 40) : RGB(230, 70, 20));
        for (int w = -hw; w <= hw; w += 1) {
            int x = (qx + (-dy * w >> 10) + 8) >> 4, y = (qy + (dx * w >> 10) + 8) >> 4;
            px(x, y, abs(w) == hw && hw > 0 ? RGB(230, 80, 20) : c);
        }
    }
}

static void flame_particles(void) {
    int dx, dy;
    rocket_dir(&dx, &dy);
    int32_t nx = (ROCKET_X << Q) - (dx * 10 >> 6), ny = g.ry - (dy * 10 >> 6);
    int n = g.burn ? 3 : (g.frame & 1);
    for (int i = 0; i < n; i += 1) {
        int sp = g.burn ? rnd_range(260, 520) : rnd_range(80, 160);
        int sx = rnd_range(-60, 60), sy = rnd_range(-60, 60);
        emit(nx, ny, -(dx * sp >> 14) + sx - g.scroll / 2, -(dy * sp >> 14) + sy,
             g.burn ? rnd_range(6, 11) : rnd_range(2, 4), RAMP_FIRE, 0, 0);
    }
}

static void draw_rocket(void) {
    if (g.invuln && (g.frame & 2)) return;
    int x = ROCKET_X + cam_x, y = (g.ry >> Q) + cam_y;
    blit(rocket_spr[rocket_k()], RS, RS, x - RS_C, y - RS_C);
    if (g.shield) {
        int r = 12 + ((g.frame >> 2) & 1);
        circle(x, y, r, RGB(90, 200, 255), 170);
        circle(x, y, r - 1, RGB(40, 120, 220), 70);
        int a = g.frame * 6;
        px(x + (icos(a) * r >> 14), y + (isin(a) * r >> 14), RGB(230, 250, 255));
    }
}

/* ------------------------------------------------- рисование препятствий */

static void draw_asteroid(struct obst *o) {
    int cx = (o->x >> Q) + cam_x, cy = (o->y >> Q) + cam_y, R = o->r;
    int br, bgc, bb;
    if (o->kind == 1) { br = 150; bgc = 92; bb = 66; }
    else if (o->kind == 2) { br = 150; bgc = 168; bb = 186; }
    else { br = 132; bgc = 116; bb = 104; }
    int crx[3], cry[3], crr[3];
    for (int i = 0; i < 3; i += 1) {
        int a = o->cr[i][0] * 4 + o->ang;
        crx[i] = icos(a) * o->cr[i][1] >> 14;
        cry[i] = isin(a) * o->cr[i][1] >> 14;
        crr[i] = o->cr[i][2];
    }
    int maxl = 0;
    for (int i = 0; i < 16; i += 1)
        if (o->lim2[i] > maxl) maxl = o->lim2[i];
    for (int dy = -R; dy <= R; dy += 1) {
        int y = cy + dy;
        if ((unsigned)y >= SH) continue;
        for (int dx = -R; dx <= R; dx += 1) {
            int x = cx + dx;
            if ((unsigned)x >= SW) continue;
            int d2 = dx * dx + dy * dy;
            if (d2 > maxl) continue;
            int a = (uint8_t)(ang_lut[dy + 15][dx + 15] - o->ang);
            int bin = a >> 4, fr = a & 15;
            int l0 = o->lim2[bin], l1 = o->lim2[(bin + 1) & 15];
            int lim = l0 + (l1 - l0) * fr / 16;
            if (d2 > lim) continue;
            int k = 236 + (-dx - dy) * 70 / R - d2 * 50 / (lim + 1);
            if (lim - d2 < 2 * R) k = k * 3 / 5;        /* темный край */
            for (int i = 0; i < 3; i += 1) {
                int ex = dx - crx[i], ey = dy - cry[i];
                int e = ex * ex + ey * ey;
                if (e <= crr[i] * crr[i]) {
                    k = (ex + ey > 0) ? k * 4 / 5 : k * 3 / 5;
                    break;
                }
            }
            fb[y * SW + x] = shade(br, bgc, bb, clampi(k, 50, 320));
        }
    }
}

static void draw_satellite(struct obst *o) {
    int cx = (o->x >> Q) + cam_x, cy = (o->y >> Q) + cam_y;
    int c = icos(o->ang), s = isin(o->ang);
    uint16_t panel = o->kind ? RGB(46, 92, 196) : RGB(60, 80, 170);
    uint16_t cell = RGB(24, 44, 110), edge = RGB(150, 180, 240), rod = RGB(150, 150, 160);
    /* панели: от центра в обе стороны, ширина 5 пикс; шаг полпикселя, без дыр */
    for (int t2 = -2 * o->r; t2 <= 2 * o->r; t2 += 1) {
        int at = abs(t2);
        if (at < 7) continue;
        for (int w2 = -4; w2 <= 4; w2 += 1) {
            if (at < 11 && w2 != 0) continue;          /* штанга */
            int x = cx + rsh(c * t2 - s * w2, 15);
            int y = cy + rsh(s * t2 + c * w2, 15);
            uint16_t col = at < 11 ? rod : ((at % 6) < 1 ? cell : (w2 <= -3 ? edge : (w2 >= 3 ? cell : panel)));
            px(x, y, col);
        }
    }
    /* корпус: повернутый квадрат 7x7 */
    for (int u = -7; u <= 7; u += 1)
        for (int w = -7; w <= 7; w += 1) {
            int x = cx + rsh(c * u - s * w, 15), y = cy + rsh(s * u + c * w, 15);
            int k = 230 + (u + w) * 5;
            px(x, y, (abs(u) >= 6 || abs(w) >= 6) ? RGB(160, 118, 36) : shade(235, 186, 64, k));
        }
    px(cx, cy, RGB(255, 240, 200));
    /* огонек на конце панели */
    if ((g.frame >> 3) & 1) {
        int x = cx + rsh(c * o->r, 14), y = cy + rsh(s * o->r, 14);
        px(x, y, RGB(255, 60, 40));
    }
}

static void draw_debris(struct obst *o) {
    int x = (o->x >> Q) + cam_x, y = (o->y >> Q) + cam_y;
    /* кувыркающийся обломок: 4 рисунка 5x5, светлая грань и темная */
    static const char *const SHAPES[4][5] = {
        {".aa..", "aAAb.", ".Abb.", "..b..", "....."},
        {"..a..", ".aAA.", "aAbb.", "..b..", "....."},
        {".....", ".aAa.", "aAAbb", ".bb..", "....."},
        {".a...", ".AAa.", ".bAA.", ".bb..", "....."}};
    int sh = (o->ang >> 6) & 3;
    uint16_t ca, cA, cb;
    if (o->kind == 0) { ca = RGB(240, 240, 250); cA = RGB(180, 184, 200); cb = RGB(100, 104, 120); }
    else if (o->kind == 1) { ca = RGB(255, 200, 110); cA = RGB(220, 130, 50); cb = RGB(120, 70, 40); }
    else { ca = RGB(230, 230, 170); cA = RGB(170, 170, 110); cb = RGB(96, 96, 70); }
    px(x + 3, y, RGB(70, 74, 90));          /* след */
    for (int yy = 0; yy < 5; yy += 1)
        for (int xx = 0; xx < 5; xx += 1) {
            char ch = SHAPES[sh][yy][xx];
            if (ch != '.') px(x - 2 + xx, y - 2 + yy, ch == 'a' ? ca : (ch == 'A' ? cA : cb));
        }
}

static int wall_gap_center(struct obst *o) { return o->y >> Q; }

static void draw_wall(struct obst *o) {
    int x = (o->x >> Q) + cam_x;
    int gc = wall_gap_center(o) + cam_y, top = gc - o->r, bot = gc + o->r;
    uint16_t red = RGB(200, 60, 40), dark = RGB(120, 34, 26), cap = RGB(150, 150, 162), capd = RGB(96, 96, 110);
    for (int y = 0; y < SH; y += 1) {
        if (y >= top && y <= bot) continue;
        int yy = y - cam_y;
        px(x, y, red);
        px(x + 7, y, red);
        int ph = ((yy % 12) + 12) % 12;
        int d = ph < 6 ? ph : 11 - ph;               /* зигзаг решетки */
        px(x + 1 + d, y, dark);
        px(x + 6 - d, y, red);
    }
    for (int k = 0; k < 3; k += 1) {
        for (int xx = x - 2; xx <= x + 9; xx += 1) {
            px(xx, top - k, k == 0 ? capd : cap);
            px(xx, bot + k, k == 0 ? capd : cap);
        }
    }
    int blink = (g.frame >> 2) & 1;
    px(x - 2, top - 1, blink ? RGB(255, 60, 40) : RGB(90, 30, 30));
    px(x + 9, top - 1, blink ? RGB(90, 30, 30) : RGB(255, 60, 40));
    px(x - 2, bot + 1, blink ? RGB(60, 255, 90) : RGB(30, 90, 40));
    px(x + 9, bot + 1, blink ? RGB(30, 90, 40) : RGB(60, 255, 90));
}

/* ---------------------------------------------------------- бонусы рисунок */

static const char *const STAR_ART[7] = {
    "...Y...",
    "..YYY..",
    "YYYWYYY",
    ".YYWYY.",
    "..YYY..",
    ".YY.YY.",
    ".Y...Y."};
static const char *const FUEL_ART[9] = {
    ".ggg...",
    ".g.g...",
    "GGGGGG.",
    "GLLLLGG",
    "GLDLLGG",
    "GLDDLGG",
    "GLLLLGG",
    "GGGGGG.",
    ".dddd.."};

static void draw_art(const char *const *art, int w, int h, int x0, int y0) {
    for (int y = 0; y < h; y += 1)
        for (int x = 0; x < w; x += 1) {
            uint16_t c;
            switch (art[y][x]) {
            case 'Y': c = RGB(255, 214, 40); break;
            case 'W': c = RGB(255, 255, 230); break;
            case 'G': c = RGB(60, 190, 90); break;
            case 'g': c = RGB(150, 150, 160); break;
            case 'L': c = RGB(120, 235, 140); break;
            case 'D': c = RGB(250, 250, 250); break;
            case 'd': c = RGB(30, 110, 50); break;
            default: continue;
            }
            px(x0 + x, y0 + y, c);
        }
}

static void draw_bonus(struct bonus *b) {
    int x = (b->x >> Q) + cam_x, y = (b->y >> Q) + cam_y;
    switch (b->type) {
    case BN_STAR:
        draw_art(STAR_ART, 7, 7, x - 3, y - 3);
        if (((g.frame + b->phase) & 15) < 3) {
            uint16_t w = RGB(255, 255, 255);
            px(x - 5, y, w); px(x + 5, y, w); px(x, y - 5, w); px(x, y + 5, w);
        }
        break;
    case BN_FUEL:
        draw_art(FUEL_ART, 7, 9, x - 3, y - 4);
        break;
    case BN_SHIELD: {
        int r = 5 + (((g.frame + b->phase) >> 3) & 1);
        circle(x, y, r, RGB(100, 210, 255), 256);
        circle(x, y, r - 2, RGB(40, 120, 220), 150);
        px(x - 2, y - 2, RGB(240, 250, 255));
        px(x - 1, y - 3, RGB(200, 240, 255));
        break;
    }
    default:
        break;
    }
}

/* -------------------------------------------------------------- HUD */

static void tricolor(int x0, int x1, int y0, int phase, int alpha) {
    static const uint8_t col[3][3] = {{255, 255, 255}, {0, 57, 166}, {213, 43, 30}};
    for (int x = x0; x <= x1; x += 1) {
        int a = phase + x * 9;
        int off = isin(a) * 2 >> 14;
        int sh = 220 + (icos(a) * 36 >> 14);
        for (int s = 0; s < 3; s += 1)
            for (int k = 0; k < 2; k += 1)
                pxa(x, y0 + off + s * 2 + k, shade(col[s][0], col[s][1], col[s][2], sh), alpha);
    }
}

static void draw_hud(void) {
    char buf[16];
    snprintf(buf, sizeof(buf), "%u", g.score);
    tiny_text(3, 2, buf, RGB(0, 0, 0), 256);
    tiny_text(2, 1, buf, RGB(255, 255, 255), 256);

    /* путь к планете за круг: 5 уровней */
    int len = g.level_len > 0 ? g.level_len : LEVEL_FRAMES;
    int stage = stage_of(g.level);
    int prog = (stage * len + clampi(g.level_frame, 0, len)) * 40 / (5 * len);
    for (int x = 40; x <= 80; x += 1) px(x, 3, (x - 40) <= prog ? RGB(230, 230, 240) : RGB(70, 74, 96));
    for (int k = 1; k < 5; k += 1) px(40 + k * 8, 2, RGB(140, 140, 160));
    px(40 + prog, 2, RGB(255, 255, 255)); px(40 + prog, 4, RGB(255, 255, 255)); px(41 + prog, 3, RGB(255, 120, 60));
    uint16_t pc = g.pl_kind ? RGB(210, 110, 70) : RGB(200, 205, 215);
    rect(83, 2, 3, 3, pc); px(84, 1, pc); px(84, 5, pc); px(82, 3, pc); px(86, 3, pc);

    /* щит */
    if (g.shield) circle(91, 3, 2, RGB(100, 210, 255), 256);

    /* топливо */
    int f = g.fuel * 24 / FUEL_MAX;
    uint16_t fc = g.fuel > FUEL_MAX / 2 ? RGB(90, 220, 110) : (g.fuel > FUEL_MAX / 4 ? RGB(240, 200, 60) : RGB(245, 70, 50));
    int warn = g.fuel < FUEL_MAX / 5 && ((g.frame >> 2) & 1);
    rect(98, 1, 28, 5, RGB(20, 22, 34));
    for (int x = 99; x < 125; x += 1) { px(x, 1, RGB(110, 110, 130)); px(x, 5, RGB(110, 110, 130)); }
    px(98, 2, RGB(110, 110, 130)); px(98, 3, RGB(110, 110, 130)); px(98, 4, RGB(110, 110, 130));
    px(125, 2, RGB(110, 110, 130)); px(125, 3, RGB(110, 110, 130)); px(125, 4, RGB(110, 110, 130));
    if (!warn) rect(100, 2, f, 3, fc);
    /* значок: капля */
    uint16_t dc = warn ? RGB(255, 80, 60) : RGB(255, 190, 60);
    px(94, 1, dc); px(93, 2, dc); px(94, 2, dc); px(95, 2, dc);
    px(93, 3, dc); px(94, 3, dc); px(95, 3, dc); px(94, 4, dc);
}

/* опасный низ: красная подсветка, когда ракета низко */
static void draw_danger(void) {
    int y = g.ry >> Q;
    if (y < 96 || g.state != ST_PLAY) return;
    int a = clampi((y - 96) * 7, 0, 200);
    if ((g.frame >> 1) & 1) a = a * 2 / 3;
    for (int k = 0; k < 4; k += 1)
        for (int x = 0; x < SW; x += 1) pxa(x, SH - 1 - k, RGB(255, 40, 30), a - k * a / 4);
}

/* ------------------------------------------------------- кадр мира */

static void render_world(int with_rocket) {
    draw_background();
    draw_stars(0, 1);
    draw_planet();
    draw_earth(earth_height(), (int)(g.frame / 3));
    draw_stars(2, 2);

    if (g.banner > 0 && g.state == ST_PLAY) {
        /* надпись уровня - фоном, препятствия рисуются поверх */
        int a = g.banner < 12 ? g.banner * 21 : 256;
        int lap = lap_of(g.level), stage = stage_of(g.level);
        char l1[32], l2[32];
        if (g.banner_kind == 1 && g.banner > 24) {
            snprintf(l1, sizeof(l1), "%s", lap & 1 ? "Облет Луны!" : "Облет Марса!");
            snprintf(l2, sizeof(l2), "+500");
        } else {
            snprintf(l1, sizeof(l1), "Уровень %d", g.level);
            snprintf(l2, sizeof(l2), "%s", STAGE_NAME[lap ? 1 : 0][stage]);
        }
        fb_text(-1, 10, l1, RGB(255, 255, 255), a * 200 / 256);
        fb_text(-1, 24, l2, RGB(255, 214, 60), a * 200 / 256);
        tricolor(24, 103, 41, (int)g.frame * 10, a * 180 / 256);
    }

    cam_x = cam_y = 0;
    if (g.shake > 0) {
        int a = clampi(g.shake / 2 + 1, 1, 4);
        cam_x = rnd_range(-a, a);
        cam_y = rnd_range(-a, a);
    }
    for (int i = 0; i < MAX_OBST; i += 1)
        if (g.ob[i].type == OB_WALL) draw_wall(&g.ob[i]);
    for (int i = 0; i < MAX_BONUS; i += 1)
        if (g.bn[i].type != BN_NONE) draw_bonus(&g.bn[i]);
    for (int i = 0; i < MAX_OBST; i += 1) {
        struct obst *o = &g.ob[i];
        if (o->type == OB_AST) draw_asteroid(o);
        else if (o->type == OB_SAT) draw_satellite(o);
        else if (o->type == OB_DEB) draw_debris(o);
    }
    if (with_rocket) {
        draw_flame();
        draw_parts();
        draw_rocket();
    } else {
        draw_parts();
    }
    draw_fx();
    cam_x = cam_y = 0;

    if (g.banner > 0 && g.state == ST_READY) tricolor(24, 103, 41, (int)g.frame * 10, 256);
    draw_danger();
    draw_hud();
    if (g.flash > 0) {
        uint16_t w = RGB(255, 250, 235);
        int t = g.flash * 50;
        for (int i = 0; i < SW * SH; i += 1) fb[i] = mix(fb[i], w, t);
    }
}

/* ----------------------------------------------------------- рекорд */

static int best_read_try(uint32_t *v) {
    int fd = open(ORBIT_BEST_FILE, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    char buf[16];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0) return -1;
    buf[n] = 0;
    uint32_t x = 0;
    for (char *p = buf; *p >= '0' && *p <= '9'; p += 1) {
        x = x * 10 + (uint32_t)(*p - '0');
        if (x > 99999999u) return -1;
    }
    *v = x;
    return 0;
}

static int best_write_try(uint32_t v) {
    static const char tmp[] = ORBIT_BEST_FILE ".new";
    char buf[16];
    int n = snprintf(buf, sizeof(buf), "%u\n", v);
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd < 0) return -1;
    int ok = write(fd, buf, n) == n;
    ok = fsync(fd) == 0 && ok;
    ok = close(fd) == 0 && ok;
    if (!ok || rename(tmp, ORBIT_BEST_FILE) != 0) {
        unlink(tmp);
        return -1;
    }
    return 0;
}

/*
 * oled работает с euid 1000 и saved uid 0 (хуки setuid в oled_hijack.c).
 * Если файл или каталог не дают доступа, повтор с euid 0 и сразу возврат.
 * В bionic seteuid - прямой вызов setresuid: меняет права только этого потока.
 */
static uint32_t best_load(void) {
    uint32_t v = 0;
    if (best_read_try(&v) == 0) return v;
    if (errno != EACCES && errno != EPERM) return 0;
    uid_t euid = geteuid();
    if (euid != 0 && seteuid(0) == 0) {
        if (best_read_try(&v) != 0) v = 0;
        if (seteuid(euid) != 0) fprintf(stderr, "orbit: seteuid back failed\n");
    }
    return v;
}

static void best_save(uint32_t v) {
    if (best_write_try(v) == 0) return;
    uid_t euid = geteuid();
    if (euid != 0 && seteuid(0) == 0) {
        best_write_try(v);
        if (seteuid(euid) != 0) fprintf(stderr, "orbit: seteuid back failed\n");
    }
}

/* конец партии: обновить рекорд */
static void finish_record(void) {
    if (g.score > g.best) {
        g.best = g.score;
        g.new_record = 1;
        best_save(g.best);
    }
}

/* --------------------------------------------------------- состояния */

static void set_state(int st) {
    g.prev_state = g.state;
    g.state = st;
    g.st_frames = 0;
    g.dirty = 1;
}

static void level_setup(int level, int first) {
    int old_stage = stage_of(g.level);
    g.level = level;
    g.level_frame = 0;
    g.speed = clampi(SPEED0 + SPEED_STEP * (level - 1), SPEED0, SPEED_MAX);
    g.pal_from = first ? stage_of(level) : old_stage;
    g.pal_to = stage_of(level);
    g.pal_t = first ? 256 : 0;
    g.banner = clampi((g.level_len > 0 ? g.level_len : LEVEL_FRAMES) / 3, 20, BANNER_FRAMES);
    g.banner_kind = 0;
    if (!first && stage_of(level) == 0) {
        g.banner_kind = 1;          /* облет планеты */
        g.pl_exit = 1;
    }
}

static void game_reset(void) {
    int keep_best = (int)g.best;
    memset(g.ob, 0, sizeof(g.ob));
    memset(g.bn, 0, sizeof(g.bn));
    memset(g.pt, 0, sizeof(g.pt));
    memset(g.rg, 0, sizeof(g.rg));
    memset(g.fl, 0, sizeof(g.fl));
    g.best = (uint32_t)keep_best;
    g.ry = 64 << Q;
    g.rvy = 0;
    g.tilt = 0;
    g.burn = 0;
    g.fuel = FUEL_MAX;
    g.shield = 0;
    g.invuln = 0;
    g.score = 0;
    g.new_record = 0;
    g.cause = CAUSE_NONE;
    g.level = 1;
    level_setup(1, 1);
    g.dist_acc = 0;
    g.spawn_acc = 70 << Q;
    g.star_cd = 30;
    g.fuel_cd = 260;
    g.shield_cd = 200;
    g.wall_cd = 0;
    g.combo = g.combo_t = 0;
    g.shake = g.flash = 0;
    g.launch_text = 0;
    g.pl_x_off = 0;
    g.pl_exit = 0;
    g.pl_kind = 0;
    g.scroll = 0;
}

static void die(int cause) {
    g.cause = cause;
    int32_t x = ROCKET_X << Q, y = g.ry;
    burst(x, y, 40, 900, 28, RAMP_BOOM, 1);
    burst(x, y, 16, 360, 36, RAMP_SMOKE, 1);
    for (int i = 0; i < 12; i += 1) {         /* куски корпуса: белые и красные, падают */
        int a = rnd(256), sp = rnd_range(200, 620);
        emit(x, y, icos(a) * sp >> 14, isin(a) * sp >> 14, rnd_range(24, 40), RAMP_HULL, 1, 10);
    }
    add_ring(ROCKET_X, g.ry >> Q, RGB(255, 200, 120));
    add_ring(ROCKET_X, g.ry >> Q, RGB(255, 120, 40));
    g.flash = 3;
    g.shake = 14;
    g.burn = 0;
    set_state(ST_DYING);
}

static void hit(int cause, struct obst *o) {
    if (g.invuln || g.state != ST_PLAY) return;
    if (g.shield) {
        g.shield = 0;
        g.invuln = 36;
        g.shake = 8;
        g.flash = 1;
        burst(ROCKET_X << Q, g.ry, 18, 420, 16, RAMP_SHIELD, 0);
        add_ring(ROCKET_X, g.ry >> Q, RGB(100, 210, 255));
        if (o && o->type != OB_WALL) {
            burst(o->x, o->y, 12, 300, 20, RAMP_SMOKE, 1);
            o->type = OB_NONE;
        }
        return;
    }
    die(cause);
}

static void add_score(int pts, int x, int y, uint16_t c) {
    g.score += (uint32_t)pts;
    if (x >= 0) {
        char s[8];
        snprintf(s, sizeof(s), "+%d", pts);
        add_floater(x, y, c, s);
    }
}

/* столкновения и подбор */
static void collide(void) {
    int ry4 = g.ry >> (Q - 4);
    for (int i = 0; i < MAX_OBST && g.state == ST_PLAY; i += 1) {
        struct obst *o = &g.ob[i];
        if (o->type == OB_NONE) continue;
        int ox = o->x >> Q, oy = o->y >> Q;
        if (abs(ox - ROCKET_X) > o->r + 24 && o->type != OB_WALL) continue;
        int ox4 = o->x >> (Q - 4), oy4 = o->y >> (Q - 4);
        switch (o->type) {
        case OB_AST: {
            int rr = (o->r * 218 >> 8) * 16 + ROCKET_R4;
            int d2 = rocket_dist2(ox4, oy4);
            if (d2 < rr * rr) hit(CAUSE_AST, o);
            else if (d2 < (rr + 56) * (rr + 56)) o->flags |= OF_NEAR;
            break;
        }
        case OB_SAT: {
            int rr = 4 * 16 + ROCKET_R4;
            if (rocket_dist2(ox4, oy4) < rr * rr) {
                hit(CAUSE_SAT, o);
                break;
            }
            int c = icos(o->ang), s = isin(o->ang);
            for (int t = 6; t <= o->r && g.state == ST_PLAY; t += 2)
                for (int sg = -1; sg <= 1; sg += 2) {
                    int qx = ox4 + sg * (c * t >> 10), qy = oy4 + sg * (s * t >> 10);
                    int pr = 36 + ROCKET_R4;
                    int d2 = rocket_dist2(qx, qy);
                    if (d2 < pr * pr) {
                        hit(CAUSE_SAT, o);
                        t = 1000;
                        break;
                    } else if (d2 < (pr + 48) * (pr + 48)) {
                        o->flags |= OF_NEAR;
                    }
                }
            break;
        }
        case OB_DEB: {
            int rr = 2 * 16 + ROCKET_R4;
            if (rocket_dist2(ox4, oy4) < rr * rr) hit(CAUSE_DEB, o);
            break;
        }
        case OB_WALL: {
            if (ROCKET_X + 12 < ox - 2 || ROCKET_X - 12 > ox + 9) break;
            int top = oy - o->r, bot = oy + o->r;
            int dx, dy;
            rocket_dir(&dx, &dy);
            for (int t = -7; t <= 8; t += 3) {
                int qx = ROCKET_X * 16 + (dx * t >> 10), qy = ry4 + (dy * t >> 10);
                /* ближайшая точка прямоугольников стены */
                int rx0 = (ox - 2) * 16, rx1 = (ox + 10) * 16;
                int cx = clampi(qx, rx0, rx1);
                int cyt = clampi(qy, -1000, (top + 1) * 16);
                int cyb = clampi(qy, bot * 16, 4000);
                int e1 = (qx - cx) * (qx - cx) + (qy - cyt) * (qy - cyt);
                int e2 = (qx - cx) * (qx - cx) + (qy - cyb) * (qy - cyb);
                if (e1 < ROCKET_R4 * ROCKET_R4 || e2 < ROCKET_R4 * ROCKET_R4) {
                    hit(CAUSE_WALL, o);
                    break;
                }
            }
            break;
        }
        }
    }
    if (g.state != ST_PLAY) return;
    for (int i = 0; i < MAX_BONUS; i += 1) {
        struct bonus *b = &g.bn[i];
        if (b->type == BN_NONE) continue;
        int bx = b->x >> Q, by = b->y >> Q;
        int ddx = bx - ROCKET_X, ddy = by - (g.ry >> Q);
        if (ddx * ddx + ddy * ddy > 10 * 10) continue;
        switch (b->type) {
        case BN_STAR: {
            if (g.combo_t > 0) g.combo = clampi(g.combo + 1, 1, 5);
            else g.combo = 1;
            g.combo_t = 40;
            add_score(10 * g.combo, bx - 4, by - 10, RGB(255, 230, 90));
            add_ring(bx, by, RGB(255, 220, 80));
            burst(b->x, b->y, 8, 300, 12, RAMP_STAR, 0);
            break;
        }
        case BN_FUEL:
            g.fuel = clampi(g.fuel + FUEL_CAN, 0, FUEL_MAX);
            add_ring(bx, by, RGB(100, 240, 130));
            burst(b->x, b->y, 10, 300, 14, RAMP_FUEL, 0);
            add_score(5, bx - 4, by - 10, RGB(130, 240, 150));
            break;
        case BN_SHIELD:
            g.shield = 1;
            add_ring(bx, by, RGB(100, 210, 255));
            burst(b->x, b->y, 12, 340, 14, RAMP_SHIELD, 0);
            add_score(5, bx - 4, by - 10, RGB(130, 220, 255));
            break;
        }
        b->type = BN_NONE;
    }
}

static void world_move(int32_t scroll) {
    stars_move(scroll);
    for (int i = 0; i < MAX_OBST; i += 1) {
        struct obst *o = &g.ob[i];
        if (o->type == OB_NONE) continue;
        o->x += o->vx - scroll;
        o->ang = (uint8_t)(o->ang + o->angv);
        switch (o->type) {
        case OB_AST:
            o->y += o->vy;
            if ((o->y >> Q) - o->r < 10 && o->vy < 0) o->vy = -o->vy;
            if ((o->y >> Q) + o->r > SH - 2 && o->vy > 0) o->vy = -o->vy;
            break;
        case OB_SAT:
            o->phase = (uint8_t)(o->phase + 3);
            o->y = (o->base_y << Q) + (isin(o->phase) * o->amp >> 6);
            break;
        case OB_DEB:
            o->y += o->vy;
            o->ang = (uint8_t)(o->ang + 9);
            break;
        case OB_WALL:
            if (o->amp) {
                o->phase = (uint8_t)(o->phase + 2);
                o->y = (o->base_y << Q) + (isin(o->phase) * o->amp >> 6);
            }
            break;
        }
        int ox = o->x >> Q;
        int right = o->type == OB_WALL ? ox + 10 : ox + o->r + 2;
        if (right < 0 || (o->y >> Q) < -20 || (o->y >> Q) > SH + 20) {
            o->type = OB_NONE;
            continue;
        }
        /* прошел мимо ракеты */
        if (!(o->flags & OF_PASSED) && right < ROCKET_X - 10 && g.state == ST_PLAY) {
            o->flags |= OF_PASSED;
            if (o->type == OB_WALL) add_score(25, ROCKET_X - 4, (g.ry >> Q) - 14, RGB(255, 255, 255));
            else if ((o->flags & OF_NEAR) && o->type != OB_DEB) add_score(5, ROCKET_X - 4, (g.ry >> Q) - 14, RGB(255, 150, 120));
        }
    }
    for (int i = 0; i < MAX_BONUS; i += 1) {
        struct bonus *b = &g.bn[i];
        if (b->type == BN_NONE) continue;
        b->x -= scroll;
        b->phase = (uint8_t)(b->phase + 5);
        b->y = (b->base_y << Q) + (isin(b->phase) * 3 >> 6);
        if ((b->x >> Q) < -10) b->type = BN_NONE;
    }
    for (int i = 0; i < MAX_PART; i += 1)
        if (g.pt[i].life) g.pt[i].x -= scroll / 3;
}

static void effects_tick(void) {
    parts_update();
    if (g.shake > 0) g.shake -= 1;
    if (g.flash > 0) g.flash -= 1;
    if (g.banner > 0) g.banner -= 1;
    if (g.pal_t < 256) g.pal_t = clampi(g.pal_t + 8, 0, 256);
    if (g.pl_exit) {
        g.pl_x_off += 3;
        if (g.pl_x_off > 100 + PL_RMAX * 2) {
            g.pl_exit = 0;
            g.pl_x_off = 0;
            g.pl_kind = lap_of(g.level) & 1;
        }
    }
}

static void rocket_physics(int presses) {
    if (presses > 0) {
        if (g.fuel > 0) {
            g.burn = clampi(g.burn + BURN_PER_PRESS * presses, 0, BURN_MAX);
            g.fuel = clampi(g.fuel - FUEL_PER_PRESS * presses, 0, FUEL_MAX);
        } else {
            /* пустой бак: только чих дыма */
            burst((ROCKET_X - 9) << Q, g.ry, 4, 160, 8, RAMP_SMOKE, 0);
        }
    }
    g.rvy += GRAVITY;
    if (g.burn > 0) {
        g.rvy -= THRUST;
        g.burn -= 1;
    }
    g.rvy = clampi(g.rvy, VY_UP_MAX, VY_DOWN_MAX);
    g.ry += g.rvy;
    if (g.ry < CEIL_Y) {
        g.ry = CEIL_Y;
        if (g.rvy < 0) g.rvy = -g.rvy / 4;
    }
    int target = clampi(-g.rvy * 14 / 256, -40, 40);
    g.tilt += (target - g.tilt) / 2;
    flame_particles();
}

static void play_tick(int presses) {
    g.level_frame += 1;
    if (g.invuln > 0) g.invuln -= 1;
    if (g.wall_cd > 0) g.wall_cd -= 1;
    if (g.combo_t > 0) g.combo_t -= 1;
    if (g.launch_text > 0) g.launch_text -= 1;
    g.scroll = g.speed;
    rocket_physics(presses);
    world_move(g.scroll);
    g.spawn_acc -= g.scroll;
    if (g.spawn_acc <= 0) spawn_obstacle();
    bonus_director();
    collide();
    if (g.state != ST_PLAY) return;
    if (g.ry > FLOOR_Y) {
        g.shield = 0;
        g.invuln = 0;
        die(g.fuel <= 0 ? CAUSE_FUEL : CAUSE_FALL);
        return;
    }
    g.dist_acc += g.scroll;
    while (g.dist_acc >= (8 << Q)) {
        g.dist_acc -= 8 << Q;
        g.score += 1;
    }
    int len = g.level_len > 0 ? g.level_len : LEVEL_FRAMES;
    if (g.level_frame >= len) {
        int lap_end = stage_of(g.level) == 4;
        level_setup(g.level + 1, 0);
        add_score(lap_end ? 500 : 50 * (g.level - 1), -1, 0, 0);
    }
}

/* ------------------------------------------------------------ надписи по состоянию */

static void texts_for_state(void) {
    g.ntx = 0;
    int blink = (g.st_frames >> 3) & 1;
    switch (g.state) {
    case ST_TITLE:
        add_text(1, -1, 10, 255, 255, 255, 1, "ОРБИТА");
        add_text(0, -1, 42, 150, 180, 230, 1, "полет к Луне");
        if (g.best) add_text(0, -1, 56, 255, 214, 60, 1, "Рекорд: %u", g.best);
        add_text(0, -1, 86, 255, 255, 255, 1, "POWER - старт");
        add_text(0, -1, 100, 150, 150, 170, 1, "MENU - выход");
        break;
    case ST_READY:
        add_text(0, -1, 12, 255, 255, 255, 1, "Уровень 1");
        add_text(0, -1, 26, 255, 214, 60, 1, "%s", STAGE_NAME[0][0]);
        if (!blink || g.st_frames > 400) add_text(0, -1, 72, 255, 255, 255, 1, "POWER - тяга");
        add_text(0, -1, 88, 150, 150, 170, 1, "MENU - пауза");
        break;
    case ST_PLAY:
    case ST_DYING:
        if (g.launch_text > 0) {
            int c = 120 + g.launch_text * 6;
            add_text(1, -1, 50, c, c, c, 1, "ПОЕХАЛИ!");
        }
        break;
    case ST_PAUSE:
        add_text(1, -1, 22, 255, 255, 255, 1, "ПАУЗА");
        add_text(0, -1, 50, 200, 200, 210, 1, "Очки: %u", g.score);
        add_text(0, -1, 80, 255, 255, 255, 1, "POWER - дальше");
        add_text(0, -1, 96, 150, 150, 170, 1, "MENU - выход");
        break;
    case ST_COUNTDOWN:
        add_text(1, -1, 50, 255, 255, 255, 1, "%d", (g.countdown + 11) / 12);
        break;
    case ST_OVER:
        add_text(1, -1, 10, 255, 90, 70, 1, "КОНЕЦ");
        add_text(0, -1, 34, 170, 170, 190, 1, "%s", CAUSE_TEXT[clampi(g.cause, 0, 6)]);
        add_text(0, -1, 52, 255, 255, 255, 1, "Очки: %u", g.score);
        if (g.new_record) {
            if (!blink || g.st_frames > OVER_BLINK_FRAMES) add_text(0, -1, 68, 255, 214, 60, 1, "Новый рекорд!");
        } else {
            add_text(0, -1, 68, 255, 214, 60, 1, "Рекорд: %u", g.best);
        }
        add_text(0, -1, 92, 255, 255, 255, 1, "POWER - еще раз");
        add_text(0, -1, 108, 150, 150, 170, 1, "MENU - выход");
        break;
    case ST_NOTIMER:
        add_text(0, -1, 40, 255, 255, 255, 1, "Нет свободного");
        add_text(0, -1, 56, 255, 255, 255, 1, "таймера");
        add_text(0, -1, 90, 150, 150, 170, 1, "Кнопка - выход");
        break;
    case ST_NOSCREEN:
        add_text(0, 0, 10, 255, 255, 255, 0, "Нужен цветной");
        add_text(0, 0, 26, 255, 255, 255, 0, "экран");
        break;
    }
}

/* заставка: ракета пролетает по синусоиде */
static void title_tick(void) {
    world_move(0);
    stars_move(192);
    g.title_x += 1;
    if (g.title_x > 180) g.title_x = -20;
    g.pl_x_off = 0;
}

static void render_title(void) {
    draw_background();
    draw_stars(0, 1);
    draw_planet();
    draw_earth(earth_height(), (int)(g.frame / 3));
    draw_stars(2, 2);
    int x = g.title_x;
    int a = g.title_x * 3;
    int y = 77 + (isin(a) * 4 >> 14);
    int k = clampi(4 - rsh(icos(a) * 2, 14), 0, 8);   /* наклон по производной */
    blit(rocket_spr[k], RS, RS, x - RS_C, y - RS_C);
    for (int t = 0; t < 3; t += 1) {
        int fx = x - 11 - t, fy = y + (k - 4) * t / 3;
        px(fx, fy, t == 0 ? RGB(255, 245, 170) : RGB(255, 150, 40));
        if (rnd(2)) px(fx - 2 - rnd(3), fy + rnd_range(-1, 1), RGB(230, 70, 20));
    }
    tricolor(30, 97, 33, (int)g.frame * 10, 256);
}

/* ------------------------------------------------------------- шаг */

/* 1 - кадр изменился */
static int step(int presses) {
    g.frame += 1;
    g.st_frames += 1;
    if (presses) g.idle = 0;
    else g.idle += 1;

    switch (g.state) {
    case ST_TITLE:
        if (presses) {
            game_reset();
            set_state(ST_READY);
            break;
        }
        if (g.idle > TITLE_IDLE_FRAMES) return 0;
        title_tick();
        render_title();
        texts_for_state();
        return 1;
    case ST_READY:
        if (presses) {
            set_state(ST_PLAY);
            g.launch_text = 24;
            g.banner = 0;           /* «Уровень 1» уже был на старте */
            play_tick(presses);
            break;
        }
        g.scroll = g.speed / 2;
        world_move(g.scroll);
        effects_tick();
        g.ry = (64 << Q) + (isin((int)g.st_frames * 4) * 4 >> 6);
        g.tilt = 0;
        flame_particles();
        if (g.idle > TITLE_IDLE_FRAMES) return 0;
        break;
    case ST_PLAY:
        play_tick(presses);
        effects_tick();
        break;
    case ST_DYING:
        g.scroll = g.scroll * 7 / 8;
        world_move(g.scroll);
        effects_tick();
        if (g.st_frames >= DYING_FRAMES) {
            finish_record();
            set_state(ST_OVER);
            render_world(0);
            dim_frame(150);
            texts_for_state();
            return 1;
        }
        break;
    case ST_PAUSE:
        if (presses) {
            if (g.prev_state == ST_READY) {
                set_state(ST_READY);
                break;
            }
            g.countdown = 36;
            set_state(ST_COUNTDOWN);
            render_world(1);
            texts_for_state();
            return 1;
        }
        return 0;
    case ST_COUNTDOWN: {
        int before = (g.countdown + 11) / 12;
        g.countdown -= 1;
        if (g.countdown <= 0) {
            g.rvy = 0;
            g.burn = 0;
            set_state(ST_PLAY);
            break;
        }
        if ((g.countdown + 11) / 12 != before) {
            texts_for_state();
            return 1;
        }
        return 0;
    }
    case ST_OVER: {
        if (presses && g.st_frames > OVER_LOCK_FRAMES) {
            game_reset();
            set_state(ST_READY);
            break;
        }
        int blink_changed = g.new_record && g.st_frames <= OVER_BLINK_FRAMES + 8 && (g.st_frames & 7) == 0;
        if (blink_changed) {
            texts_for_state();
            return 1;
        }
        return 0;
    }
    default:
        return 0;
    }
    if (g.state == ST_PLAY || g.state == ST_READY || g.state == ST_DYING) {
        render_world(g.state != ST_DYING);
        texts_for_state();
        return 1;
    }
    return 0;
}

/* ------------------------------------------------------------ потоки */

/* Экран погас (простой дольше lcd_sleep_ms). hijack_ng отдает нажатие, которое
 * будит экран, и пункту меню; такое нажатие игра пропускает, чтобы MENU
 * на паузе не закрыл игру, а POWER не продолжил ее без взгляда на экран. */
static int screen_asleep(void) {
    return __atomic_load_n(&lcd_state, __ATOMIC_RELAXED) == LED_SLEEP;
}

static void orbit_tick(void) {
    int need = 0;
    pthread_mutex_lock(&g_lock);
    if (g_alive) {
        int presses = __atomic_exchange_n(&g_presses, 0, __ATOMIC_ACQ_REL);
        need = step(presses) || g.dirty;
        g.dirty = 0;
    }
    pthread_mutex_unlock(&g_lock);
    if (need) repaint();
}

void orbit_init(void) {
    pthread_mutex_lock(&g_lock);
    if (!g_tables_ready) {
        build_tables();
        g_tables_ready = 1;
    }
    int keep_timer = g_alive && g_timer;
    g_alive = 1;
    __atomic_store_n(&g_presses, 0, __ATOMIC_RELEASE);
    memset(&g, 0, sizeof(g));
    seed_rng();
    g.best = best_load();
    g.level = 1;
    g.level_len = LEVEL_FRAMES;
    level_setup(1, 1);
    g.banner = 0;
    stars_init();
    g.title_x = 10;
    g.state = ST_TITLE;
    if (is_small_screen) {
        g.state = ST_NOSCREEN;
    } else if (!keep_timer) {
        g_timer = timer_create_ex ? timer_create_ex(ORBIT_TICK_MS, 1, orbit_tick, 0) : 0;
        if (!g_timer) g.state = ST_NOTIMER;
    }
    if (g.state == ST_TITLE) {
        render_title();
    } else {
        draw_background();
        draw_stars(0, 2);
    }
    texts_for_state();
    pthread_mutex_unlock(&g_lock);
}

void orbit_deinit(void) {
    pthread_mutex_lock(&g_lock);
    uint32_t t = g_timer;
    if (g_alive && (g.state == ST_PLAY || g.state == ST_PAUSE || g.state == ST_COUNTDOWN ||
                    g.state == ST_DYING || g.state == ST_READY)) {
        finish_record();
    }
    g_alive = 0;
    g_timer = 0;
    pthread_mutex_unlock(&g_lock);
    /* поток кнопки или reset_widgets, не колбэк таймера */
    if (t && timer_delete_ex) timer_delete_ex(t);
}

void orbit_paint(void) {
    pthread_mutex_lock(&g_lock);
    if (!is_small_screen) put_raw_buffer((uint8_t *)fb, sizeof(fb));
    for (int i = 0; i < g.ntx; i += 1) {
        struct otext *t = &g.tx[i];
        uint8_t w = (uint8_t)(SW - t->x), h = (uint8_t)(SH - t->y);
        for (int k = (t->shadow && !is_small_screen) ? 0 : 1; k < 2; k += 1) {
            uint8_t x = (uint8_t)(t->x + 1 - k), y = (uint8_t)(t->y + 1 - k);
            uint8_t r = k ? t->r : 0, gg = k ? t->g : 0, b = k ? t->b : 0;
            if (t->large) put_large_text(x, y, w, h, r, gg, b, t->s);
            else put_small_text(x, y, w, h, r, gg, b, t->s);
        }
    }
    pthread_mutex_unlock(&g_lock);
}

void orbit_power_key_pressed(void) {
    pthread_mutex_lock(&g_lock);
    int st = g.state, alive = g_alive;
    pthread_mutex_unlock(&g_lock);
    if (!alive || screen_asleep()) return;
    if (st == ST_NOTIMER || st == ST_NOSCREEN) {
        leave_widget();
        return;
    }
    __atomic_add_fetch(&g_presses, 1, __ATOMIC_ACQ_REL);
}

void orbit_menu_key_pressed(void) {
    int leave = 0;
    if (screen_asleep()) return;
    pthread_mutex_lock(&g_lock);
    if (g_alive) {
        g.idle = 0;
        switch (g.state) {
        case ST_PLAY:
        case ST_READY:
        case ST_COUNTDOWN: {
            int from = g.state == ST_COUNTDOWN ? ST_PLAY : g.state;
            set_state(ST_PAUSE);
            g.prev_state = from;
            dim_frame(150);
            texts_for_state();
            __atomic_store_n(&g_presses, 0, __ATOMIC_RELEASE);
            break;
        }
        default:
            leave = 1;
            break;
        }
    }
    pthread_mutex_unlock(&g_lock);
    if (leave) leave_widget();
}
