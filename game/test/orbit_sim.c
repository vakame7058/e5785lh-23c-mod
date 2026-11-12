/*
 * Проверка игры «Орбита» на ПК, без роутера.
 *
 * Модуль включается целиком (#include "../oled_orbit.c"), чтобы автопилот
 * видел состояние игры. Вывод - настоящий oled_paint.c из hijack_ng
 * (put_raw_buffer, put_small_text, put_large_text, secret_screen_buf).
 * Заглушки: repaint (как в oled_widgets.c: clear_screen, paint, вывод),
 * leave_widget, таймеры osa (20 слотов, удаление из своего колбэка - ошибка).
 *
 * Режимы:
 *   orbit_sim shots <каталог>    кадры для PNG: <каталог>/<имя>.bin (32768 Б, как frames.bin)
 *   orbit_sim gif <файл>         кадры игры автопилотом подряд, 20 к/с
 *   orbit_sim stress <кадров>    долгий прогон: автопилот, паузы, выходы, проверки таймеров
 *   orbit_sim threads <мс>       потоки как на роутере: таймер и кнопки параллельно (для TSan)
 *   orbit_sim bench <кадров>     время тика и paint на ПК
 */
#include "../oled_orbit.c"

#include <assert.h>

extern uint16_t secret_screen_buf[];
extern void put_rect(uint8_t x, uint8_t y, uint8_t w, uint8_t h, uint8_t red, uint8_t green, uint8_t blue);

/* ------------------------------------------------------------ модель osa */

#define OSA_SLOTS 20
static struct {
    uint32_t id;
    void (*cb)();
    uint32_t ms;
    int periodic;
} osa[OSA_SLOTS];
static uint32_t osa_next_id = 0x1000;
static int osa_native = 6;              /* слоты, занятые родным oled и меню */
static int osa_self_delete = 0, osa_bad_delete = 0, osa_max_ours = 0, osa_creates = 0;
static __thread uint32_t osa_in_cb = 0;
static pthread_mutex_t osa_lock = PTHREAD_MUTEX_INITIALIZER;
static int sim_no_timers = 0;           /* timer_create_ex возвращает 0 */

static int osa_ours(void) {
    int n = 0;
    for (int i = 0; i < OSA_SLOTS; i++) n += osa[i].id != 0;
    return n;
}

static uint32_t osa_create(uint32_t ms, uint32_t periodic, void (*cb)(), uint32_t arg) {
    (void)arg;
    pthread_mutex_lock(&osa_lock);
    uint32_t id = 0;
    if (!sim_no_timers && osa_ours() + osa_native < OSA_SLOTS) {
        for (int i = 0; i < OSA_SLOTS; i++)
            if (!osa[i].id) {
                osa[i].id = id = osa_next_id++;
                osa[i].cb = cb;
                osa[i].ms = ms;
                osa[i].periodic = (int)periodic;
                break;
            }
        osa_creates += 1;
    }
    int n = osa_ours();
    if (n > osa_max_ours) osa_max_ours = n;
    pthread_mutex_unlock(&osa_lock);
    return id;
}

static uint32_t osa_delete(uint32_t id) {
    if (osa_in_cb && osa_in_cb == id) osa_self_delete += 1;   /* на роутере: pthread_exit */
    pthread_mutex_lock(&osa_lock);
    int found = 0;
    for (int i = 0; i < OSA_SLOTS; i++)
        if (osa[i].id == id) {
            osa[i].id = 0;
            found = 1;
        }
    if (!found) osa_bad_delete += 1;
    pthread_mutex_unlock(&osa_lock);
    return 0;
}

uint32_t lcd_state = LED_ON;             /* как в oled_widgets.c */
uint32_t (*timer_create_ex)(uint32_t, uint32_t, void (*)(), uint32_t) = osa_create;
uint32_t (*timer_delete_ex)(uint32_t) = osa_delete;

/* один тик всех таймеров (однопоточный режим) */
static void osa_fire_all(void) {
    for (int i = 0; i < OSA_SLOTS; i++) {
        pthread_mutex_lock(&osa_lock);
        uint32_t id = osa[i].id;
        void (*cb)() = osa[i].cb;
        pthread_mutex_unlock(&osa_lock);
        if (!id) continue;
        osa_in_cb = id;
        cb();
        osa_in_cb = 0;
    }
}

/* --------------------------------------------------------- экран и меню */

static pthread_mutex_t screen_lock = PTHREAD_MUTEX_INITIALIZER;
static uint16_t screen[SW * SH];          /* что ушло на экран последним */
static int widget_active = 0;
static long frames_shown = 0;
static int leaves = 0, enters = 0;

/* как repaint() в oled_widgets.c; мьютекс - только чтобы TSan проверял модуль,
 * в hijack_ng repaint из двух потоков не согласован */
void repaint(void) {
    pthread_mutex_lock(&screen_lock);
    put_rect(0, 0, SW, SH, 0, 0, 0);
    if (__atomic_load_n(&widget_active, __ATOMIC_ACQUIRE)) orbit_paint();
    memcpy(screen, secret_screen_buf, sizeof(screen));
    frames_shown += 1;
    pthread_mutex_unlock(&screen_lock);
}

void leave_widget(void) {
    orbit_deinit();
    __atomic_store_n(&widget_active, 0, __ATOMIC_RELEASE);
    leaves += 1;
    repaint();
}

static void enter_game(void) {
    __atomic_store_n(&widget_active, 1, __ATOMIC_RELEASE);
    enters += 1;
    orbit_init();
    repaint();
}

static void key_power(void) {
    if (!__atomic_load_n(&widget_active, __ATOMIC_ACQUIRE)) return;
    orbit_power_key_pressed();
    repaint();
}

static void key_menu(void) {
    if (!__atomic_load_n(&widget_active, __ATOMIC_ACQUIRE)) return;
    orbit_menu_key_pressed();
    repaint();
}

static void save_screen(const char *path) {
    FILE *f = fopen(path, "wb");
    if (!f) {
        perror(path);
        exit(1);
    }
    fwrite(screen, 1, sizeof(screen), f);
    fclose(f);
}

/* повторяемый прогон: тот же сид - те же кадры (звезды тоже из генератора игры) */
static void sim_seed(uint32_t seed) {
    g.rng = seed | 1u;
    stars_init();
}

/* ----------------------------------------------------------- автопилот */

static int ap_kamikaze = 0;
static int ap_last = 64;
static int ap_noise = 0;                 /* % случайных лишних нажатий */

static int ap_target(void) {
    int cur = g.ry >> Q;
    int32_t rel = g.speed > 0 ? g.speed : 256;
    if (ap_kamikaze) {
        int best = -1, bx = 1000;
        for (int i = 0; i < MAX_OBST; i++) {
            struct obst *o = &g.ob[i];
            if (o->type != OB_AST) continue;
            int ox = o->x >> Q;
            if (ox > ROCKET_X + 8 && ox < bx) {
                int32_t vrel = rel - o->vx;
                int t = vrel > 32 ? ((ox - ROCKET_X) << Q) / vrel : 0;
                bx = ox;
                best = (o->y + o->vy * t) >> Q;
            }
        }
        if (best >= 0) {
            ap_last = best;
            return best;
        }
    }
    int best_y = cur, best_cost = 1 << 30;
    for (int y = 14; y <= 116; y += 2) {
        int cost = abs(y - cur) / 3;
        if (y < 20) cost += (20 - y) * 3;
        if (y > 106) cost += (y - 106) * 6;
        for (int i = 0; i < MAX_OBST; i++) {
            struct obst *o = &g.ob[i];
            if (o->type == OB_NONE) continue;
            int ox = o->x >> Q;
            int ahead = ox - ROCKET_X;
            if (o->type == OB_WALL) {
                if (ahead < -14 || ahead > 80) continue;
                int c = o->y >> Q, top = c - o->r, bot = c + o->r;
                if (y < top + 9 || y > bot - 9) cost += 3000;
                cost += abs(y - c) * 4;
                continue;
            }
            int reach = o->r + 26;
            if (ahead < -reach || ahead > 78) continue;
            int32_t vrel = rel - o->vx;
            int t = vrel > 32 ? (ahead * 256) / vrel : 0;
            if (t < 0) t = 0;
            int oy = (o->y + o->vy * t) >> Q;
            int margin = o->type == OB_AST ? o->r + 10 : (o->type == OB_SAT ? o->r + 8 : 8);
            int d = abs(y - oy);
            if (d < margin) cost += (margin - d) * (ahead < 30 ? 90 : 40);
            /* путь от текущей высоты к цели не должен идти сквозь близкое препятствие */
            if (ahead < 40) {
                int lo = cur < y ? cur : y, hi = cur < y ? y : cur;
                int cy0 = (o->y >> Q) - margin, cy1 = (o->y >> Q) + margin;
                if (hi > cy0 && lo < cy1 && !(cur > cy0 && cur < cy1)) cost += 15 * (44 - ahead);
            }
        }
        for (int i = 0; i < MAX_BONUS; i++) {
            struct bonus *b = &g.bn[i];
            if (b->type == BN_NONE) continue;
            int ahead = (b->x >> Q) - ROCKET_X;
            if (ahead < 0 || ahead > 60) continue;
            int d = abs(y - (b->y >> Q));
            int want = b->type == BN_FUEL ? (g.fuel < FUEL_MAX / 2 ? 120 : 40) : 30;
            if (d < 8) cost -= want;
        }
        if (y == ap_last) cost -= 40;      /* не метаться между двумя целями */
        if (cost < best_cost) {
            best_cost = cost;
            best_y = y;
        }
    }
    ap_last = best_y;
    return best_y;
}

static int ap_decide(void) {
    if (g.state != ST_PLAY) return 0;
    if (ap_noise && rnd(100) < ap_noise) return 1;
    int ty = ap_target();
    if (ap_kamikaze) {
        /* держаться на высоте цели без перелета: жать только при падении */
        int32_t y4 = g.ry + g.rvy * 4;
        return g.burn == 0 && g.rvy > -60 && y4 > (ty << Q);
    }
    int32_t y = g.ry, vy = g.rvy;
    int burn = g.burn;
    for (int k = 0; k < 7; k++) {
        vy += GRAVITY;
        if (burn > 0) {
            vy -= THRUST;
            burn -= 1;
        }
        y += vy;
    }
    if (y > ((ty + 22) << Q) && burn < 2) return 1;     /* сильно ниже цели - жать чаще */
    return burn == 0 && y > (ty << Q);
}

/* Автопилот с перебором: решения каждые 3 кадра на 27 кадров вперед, препятствия
 * движутся по прямой (спутник - с поворотом панелей), ракета - три круга. */
#define AP_H 27
#define AP_STEP 3
struct apo { int type, r; int32_t x[AP_H], y[AP_H]; int ang[AP_H]; };
static struct apo apo[MAX_OBST];
static int napo;
static struct { int32_t x[AP_H], y[AP_H]; int type; } apb[MAX_BONUS];
static int napb;

static void ap_predict(void) {
    napo = 0;
    for (int i = 0; i < MAX_OBST; i++) {
        struct obst *o = &g.ob[i];
        if (o->type == OB_NONE) continue;
        struct apo *a = &apo[napo++];
        a->type = o->type;
        a->r = o->r;
        int32_t x = o->x, y = o->y, vy = o->vy;
        int ang = o->ang, ph = o->phase;
        for (int t = 0; t < AP_H; t++) {
            x += o->vx - g.speed;
            ang += o->angv;
            if (o->type == OB_AST || o->type == OB_DEB) {
                y += vy;
                if (o->type == OB_AST && (((y >> Q) - o->r < 10 && vy < 0) || ((y >> Q) + o->r > SH - 2 && vy > 0))) vy = -vy;
            } else if (o->type == OB_SAT || (o->type == OB_WALL && o->amp)) {
                ph += o->type == OB_SAT ? 3 : 2;
                y = (o->base_y << Q) + (isin(ph) * o->amp >> 6);
            }
            a->x[t] = x;
            a->y[t] = y;
            a->ang[t] = ang & 255;
        }
    }
    napb = 0;
    for (int i = 0; i < MAX_BONUS; i++) {
        struct bonus *b = &g.bn[i];
        if (b->type == BN_NONE) continue;
        apb[napb].type = b->type;
        int32_t x = b->x;
        for (int t = 0; t < AP_H; t++) {
            x -= g.speed;
            apb[napb].x[t] = x;
            apb[napb].y[t] = b->y;
        }
        napb++;
    }
}

/* столкнется ли ракета с центром на высоте y (пикс) в кадре t */
static int ap_hit(int y, int t) {
    if (y > 124) return 1;
    static const int RX[3] = {ROCKET_X - 6, ROCKET_X, ROCKET_X + 7};
    for (int i = 0; i < napo; i++) {
        struct apo *a = &apo[i];
        int ox = a->x[t] >> Q, oy = a->y[t] >> Q;
        if (a->type == OB_WALL) {
            if (ROCKET_X + 13 < ox - 2 || ROCKET_X - 13 > ox + 10) continue;
            if (y - 4 < oy - a->r + 1 || y + 4 > oy + a->r) return 1;
            continue;
        }
        if (abs(ox - ROCKET_X) > a->r + 20) continue;
        for (int k = 0; k < 3; k++) {
            int dx = RX[k] - ox, dy = y - oy;
            int rr = (a->type == OB_AST ? a->r * 218 / 256 : (a->type == OB_SAT ? 4 : 2)) + 4;
            if (dx * dx + dy * dy < rr * rr) return 1;
            if (a->type == OB_SAT) {
                int c = icos(a->ang[t]), sn = isin(a->ang[t]);
                for (int u = 6; u <= a->r; u += 3)
                    for (int sg = -1; sg <= 1; sg += 2) {
                        int qx = ox + sg * (c * u >> 14), qy = oy + sg * (sn * u >> 14);
                        int ex = RX[k] - qx, ey = y - qy;
                        if (ex * ex + ey * ey < 36) return 1;
                    }
            }
        }
    }
    return 0;
}

static int ap_best;
/* кадры t..t+AP_STEP-1 по физике игры, затем выбор: жать или нет */
static int ap_roll(int t, int32_t y, int32_t vy, int burn, int fuel, int gain) {
    for (int k = 0; k < AP_STEP && t < AP_H; k++, t++) {
        vy += GRAVITY;
        if (burn > 0) {
            vy -= THRUST;
            burn--;
        }
        vy = clampi(vy, VY_UP_MAX, VY_DOWN_MAX);
        y += vy;
        if (y < CEIL_Y) {
            y = CEIL_Y;
            if (vy < 0) vy = -vy / 4;
        }
        int py = y >> Q;
        if (ap_hit(py, t)) return t * 1000 - 100000;
        for (int i = 0; i < napb; i++) {
            int dx = (apb[i].x[t] >> Q) - ROCKET_X, dy = (apb[i].y[t] >> Q) - py;
            if (dx * dx + dy * dy < 64) gain |= 1 << i;
        }
    }
    if (t >= AP_H) {
        int py = y >> Q, bonus = 0;
        for (int i = 0; i < napb; i++)
            if (gain & (1 << i)) bonus += apb[i].type == BN_FUEL ? (g.fuel < FUEL_MAX / 2 ? 400 : 120) : 90;
        return AP_H * 1000 + bonus - abs(py - 66) * 2 - abs((int)vy) / 16;
    }
    int best = -(1 << 30);
    for (int pw = 0; pw <= 1; pw++) {
        int b2 = burn, f2 = fuel;
        if (pw) {
            if (f2 <= 0) continue;
            b2 = clampi(b2 + BURN_PER_PRESS, 0, BURN_MAX);
            f2 -= FUEL_PER_PRESS;
        }
        int sc = ap_roll(t, y, vy, b2, f2, gain) - pw * 3;
        if (sc > best) best = sc;
    }
    return best;
}

static int ap_search(void) {
    if (g.state != ST_PLAY) return 0;
    if (ap_kamikaze) return ap_decide();
    ap_predict();
    int best_pw = 0, best = -(1 << 30);
    for (int pw = 0; pw <= 1; pw++) {
        int burn = g.burn, fuel = g.fuel;
        if (pw) {
            if (fuel <= 0) continue;
            burn = clampi(burn + BURN_PER_PRESS, 0, BURN_MAX);
            fuel -= FUEL_PER_PRESS;
        }
        int sc = ap_roll(0, g.ry, g.rvy, burn, fuel, 0) - pw * 3;
        if (sc > best) {
            best = sc;
            best_pw = pw;
        }
    }
    ap_best = best;
    return best_pw;
}

/* один кадр: кнопки по решению сценария, затем тик таймера */
static void sim_frame(int power, int menu) {
    if (menu) key_menu();
    if (power) key_power();
    osa_fire_all();
}

static void check_timers(const char *where) {
    int n = osa_ours();
    int act = __atomic_load_n(&widget_active, __ATOMIC_ACQUIRE);
    if (osa_self_delete || osa_bad_delete || n > 1 || (!act && n != 0) ||
        (act && n != 1 && g.state != ST_NOTIMER)) {
        fprintf(stderr, "FAIL таймеры (%s): своих %d, игра %d, из своего колбэка %d, лишних delete %d\n",
                where, n, act, osa_self_delete, osa_bad_delete);
        exit(2);
    }
}

/* -------------------------------------------------------------- shots */

static char outdir[512];
static void shot(const char *name) {
    char p[700];
    snprintf(p, sizeof(p), "%s/%s.bin", outdir, name);
    save_screen(p);
    printf("кадр %-16s state %d level %d score %u fuel %d%% shield %d\n", name, g.state, g.level, g.score,
           g.fuel * 100 / FUEL_MAX, g.shield);
}

static int shots_restart = 1;           /* погиб раньше нужного кадра - новая партия */
static void run_until(int max, int (*cond)(void)) {
    for (int i = 0; i < max; i++) {
        int pw = ap_search();
        if (shots_restart && g.state == ST_OVER) pw = g.st_frames > OVER_LOCK_FRAMES;
        if (shots_restart && (g.state == ST_READY || g.state == ST_TITLE)) pw = 1;
        sim_frame(pw, 0);
        if (cond()) return;
    }
    printf("  (условие не наступило за %d кадров)\n", max);
}
static void run_frames(int n) {
    for (int i = 0; i < n; i++) sim_frame(ap_search(), 0);
}

static int c_star_ring(void) {
    for (int i = 0; i < MAX_RING; i++)
        if (g.rg[i].t == g.rg[i].max - 2 && g.rg[i].color == RGB(255, 220, 80)) return 1;
    return 0;
}
static int c_wall_near(void) {
    for (int i = 0; i < MAX_OBST; i++)
        if (g.ob[i].type == OB_WALL && (g.ob[i].x >> Q) < ROCKET_X + 20 && (g.ob[i].x >> Q) > ROCKET_X + 4) return 1;
    return 0;
}
static int c_sat_near(void) {
    int n = 0;
    for (int i = 0; i < MAX_OBST; i++)
        if (g.ob[i].type == OB_SAT && (g.ob[i].x >> Q) < 100 && (g.ob[i].x >> Q) > ROCKET_X + 16) n++;
    return n >= 1;
}
static int c_debris_near(void) {
    int n = 0;
    for (int i = 0; i < MAX_OBST; i++)
        if (g.ob[i].type == OB_DEB && (g.ob[i].x >> Q) < 110 && (g.ob[i].x >> Q) > ROCKET_X + 10) n++;
    return n >= 4;
}
static int c_dying2(void) { return g.state == ST_DYING && g.st_frames == 5; }
static int c_shield_hit(void) { return g.invuln == 34; }
static int c_over(void) { return g.state == ST_OVER && g.st_frames > 2; }
static int c_never(void) { return 0; }
static int c_banner(void) { return g.state == ST_PLAY && g.banner == BANNER_FRAMES - 14; }

static void warp_level(int level, int frame) {
    level_setup(level, 1);
    g.level_frame = frame;
    g.pl_kind = lap_of(level) & 1;
    g.banner = 0;
}

static int c_play(void) { return g.state == ST_PLAY; }

static int mode_shots(const char *dir) {
    snprintf(outdir, sizeof(outdir), "%s", dir);
    enter_game();
    sim_seed(12345);
    for (int i = 0; i < 30; i++) sim_frame(0, 0);
    shot("01_title");
    sim_frame(1, 0);
    for (int i = 0; i < 14; i++) sim_frame(0, 0);
    shot("02_start");
    sim_frame(1, 0);
    for (int i = 0; i < 9; i++) sim_frame(ap_search(), 0);
    shot("03_launch");
    run_until(2000, c_star_ring);
    shot("04_bonus");
    run_frames(70);
    shot("05_flight");
    key_menu();
    shot("06_pause");
    sim_frame(1, 0);
    for (int i = 0; i < 4; i++) sim_frame(0, 0);
    shot("07_countdown");
    run_frames(40);
    /* дальше - уровни с переносом: так короче, чем долетать */
    run_until(10, c_play);
    warp_level(2, 100);
    run_until(1500, c_sat_near);
    shot("08_satellites");
    warp_level(3, 20);
    g.wall_cd = 0;
    run_until(1500, c_debris_near);
    shot("09_debris");
    run_until(2500, c_wall_near);
    shot("10_wall");
    warp_level(5, 560);
    g.fuel = FUEL_MAX;
    g.shield = 1;
    run_frames(50);
    shot("11_moon_shield");
    shots_restart = 0;
    ap_kamikaze = 1;
    run_until(1500, c_shield_hit);
    shot("12_shield_hit");
    ap_kamikaze = 0;
    shots_restart = 1;
    run_until(10, c_play);
    warp_level(5, 680);
    g.fuel = FUEL_MAX;
    run_until(1500, c_banner);
    shot("13_flyby");
    run_frames(30);
    g.fuel = FUEL_MAX;
    shots_restart = 0;
    ap_kamikaze = 1;
    run_until(1500, c_dying2);
    shot("14_crash");
    ap_kamikaze = 0;
    run_until(200, c_over);
    shot("15_over");
    /* новый рекорд: в файле меньше, чем наберет партия; вход заново читает файл */
    leave_widget();
    FILE *bf = fopen(ORBIT_BEST_FILE, "w");
    if (bf) { fputs("120\n", bf); fclose(bf); }
    enter_game();
    sim_seed(555);
    sim_frame(1, 0);
    sim_frame(1, 0);
    shots_restart = 1;
    run_frames(500);
    shots_restart = 0;
    ap_kamikaze = 1;
    run_until(1500, c_over);
    ap_kamikaze = 0;
    shot("16_new_record");
    (void)c_never;
    leave_widget();
    check_timers("shots");
    printf("кадров выведено %ld, создано таймеров %d, своих слотов max %d\n", frames_shown, osa_creates, osa_max_ours);
    return 0;
}

/* ---------------------------------------------------------------- gif */

static int mode_gif(const char *path) {
    FILE *f = fopen(path, "wb");
    if (!f) {
        perror(path);
        return 1;
    }
    enter_game();
    sim_seed(getenv("SIM_SEED") ? (uint32_t)atol(getenv("SIM_SEED")) : 777);
    g.level_len = 80;               /* уровни укорочены до 4 с, чтобы в 15 с показать три */
    int total = 0, play = 0, over = 0;
    const int LIMIT = 300;          /* 15 с */
    while (total < LIMIT) {
        int pw = 0;
        if (g.state == ST_TITLE && total == 10) pw = 1;
        else if (g.state == ST_READY && g.st_frames == 6) pw = 1;
        else if (g.state == ST_PLAY) {
            play += 1;
            ap_kamikaze = play > 205;
            pw = ap_search();
            if (getenv("SIM_DEBUG") && play > 190 && play % 4 == 0) {
                int nx = -1, ny = -1, nt = -1;
                for (int i = 0; i < MAX_OBST; i++)
                    if (g.ob[i].type && (g.ob[i].x >> Q) > ROCKET_X && (nx < 0 || (g.ob[i].x >> Q) < nx)) {
                        nx = g.ob[i].x >> Q; ny = g.ob[i].y >> Q; nt = g.ob[i].type;
                    }
                fprintf(stderr, "play %d y %d vy %d target %d next obst type %d at %d,%d shield %d inv %d st %d\n", play, g.ry >> Q, g.rvy, ap_last, nt, nx, ny, g.shield, g.invuln, g.state);
            }
        }
        sim_frame(pw, 0);
        if (g.state == ST_OVER) over += 1;
        fwrite(screen, 1, sizeof(screen), f);
        total += 1;
        if (over > 36) break;
    }
    fclose(f);
    printf("gif: %d кадров, игра %d кадров, уровень %d, очки %u, причина %d\n", total, play, g.level, g.score, g.cause);
    leave_widget();
    check_timers("gif");
    return 0;
}

/* ------------------------------------------------------------- stress */

static int mode_stress(long frames) {
    long games = 0, pauses = 0, exits = 0, warps = 0, causes[8] = {0};
    int max_level = 0;
    uint32_t max_score = 0;
    int reenter_in = 0;
    enter_game();
    sim_seed(getenv("SIM_SEED") ? (uint32_t)atol(getenv("SIM_SEED")) : 99);
    g.level_len = 240;
    for (long fr = 0; fr < frames; fr++) {
        int act = __atomic_load_n(&widget_active, __ATOMIC_ACQUIRE);
        if (!act) {
            if (--reenter_in <= 0) {
                uint32_t keep = g.rng;          /* init берет сид от часов - вернуть свой */
                enter_game();
                sim_seed(keep);
                g.level_len = 240;
            }
            osa_fire_all();
            check_timers("вне игры");
            continue;
        }
        int pw = 0, mn = 0;
        uint32_t r = rnd32();
        switch (g.state) {
        case ST_TITLE:
            pw = (r % 20) == 0;
            break;
        case ST_READY:
            pw = (r % 8) == 0;
            mn = (r % 400) == 1;
            break;
        case ST_PLAY:
            ap_noise = (fr / 1000) % 3 == 2 ? 15 : 2;
            ap_kamikaze = (r % 1000) < 3 ? 1 : (ap_kamikaze && (r % 50) != 0);
            pw = ap_decide();
            mn = (r % 700) == 5;
            if ((r % 1500) == 7) {
                warp_level(rnd_range(1, 14), rnd(200));
                warps += 1;
            }
            break;
        case ST_PAUSE:
            pauses += (g.st_frames == 1);
            if (g.st_frames > 6) {
                pw = (r % 5) == 0;
                mn = (r % 23) == 0;
            }
            break;
        case ST_COUNTDOWN:
            mn = (r % 90) == 0;
            break;
        case ST_DYING:
            mn = (r % 300) == 0;
            break;
        case ST_OVER:
            if (g.st_frames == 1) {
                games += 1;
                causes[clampi(g.cause, 0, 7)] += 1;
            }
            pw = g.st_frames > 10 && (r % 4) == 0;
            mn = (r % 40) == 0;
            break;
        }
        if (g.level > max_level) max_level = g.level;
        if (g.score > max_score) max_score = g.score;
        sim_frame(pw, mn);
        if (!__atomic_load_n(&widget_active, __ATOMIC_ACQUIRE)) {
            exits += 1;
            reenter_in = 3 + (int)(r % 10);
        }
        check_timers("игра");
    }
    if (__atomic_load_n(&widget_active, __ATOMIC_ACQUIRE)) leave_widget();
    check_timers("конец");
    printf("stress: кадров %ld, партий %ld, пауз %ld, выходов %ld, переносов уровня %ld, max уровень %d, max очки %u\n",
           frames, games, pauses, exits, warps, max_level, max_score);
    printf("  причины: астероид %ld, спутник %ld, обломки %ld, стена %ld, падение %ld, топливо %ld\n",
           causes[1], causes[2], causes[3], causes[4], causes[5], causes[6]);
    printf("  таймеры: создано %d, своих слотов max %d, удалений из своего колбэка %d, лишних delete %d\n",
           osa_creates, osa_max_ours, osa_self_delete, osa_bad_delete);
    printf("  входов %d, выходов %d, вывод кадров %ld, рекорд в памяти %u\n", enters, leaves, frames_shown, g.best);
    return 0;
}

/* ------------------------------------------------------------ threads */

static int th_stop = 0;

static void *th_timer(void *arg) {
    (void)arg;
    while (!__atomic_load_n(&th_stop, __ATOMIC_ACQUIRE)) {
        pthread_mutex_lock(&osa_lock);
        uint32_t id = 0;
        void (*cb)() = NULL;
        for (int i = 0; i < OSA_SLOTS; i++)
            if (osa[i].id) {
                id = osa[i].id;
                cb = osa[i].cb;
            }
        pthread_mutex_unlock(&osa_lock);
        if (id) {
            osa_in_cb = id;
            cb();
            osa_in_cb = 0;
        }
        usleep(200);
    }
    return NULL;
}

static int mode_threads(long ms) {
    enter_game();
    pthread_t t;
    pthread_create(&t, NULL, th_timer, NULL);
    uint32_t r = 1;
    long n = ms * 2;
    for (long i = 0; i < n; i++) {
        r = r * 1103515245u + 12345u;
        int act = __atomic_load_n(&widget_active, __ATOMIC_ACQUIRE);
        if (!act) {
            if ((r >> 8) % 4 == 0) enter_game();
        } else if ((r >> 8) % 3 == 0) {
            key_power();
        } else if ((r >> 8) % 13 == 0) {
            key_menu();
        }
        usleep(500);
    }
    __atomic_store_n(&th_stop, 1, __ATOMIC_RELEASE);
    pthread_join(t, NULL);
    if (__atomic_load_n(&widget_active, __ATOMIC_ACQUIRE)) leave_widget();
    check_timers("threads");
    printf("threads: %ld мс, входов %d, выходов %d, кадров %ld, своих слотов max %d, из своего колбэка %d\n",
           ms, enters, leaves, frames_shown, osa_max_ours, osa_self_delete);
    return 0;
}

/* -------------------------------------------------------------- bench */

static long ns_now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000000000L + ts.tv_nsec;
}

static int mode_bench(long frames) {
    enter_game();
    sim_seed(4242);
    g.level_len = 300;
    long t_step = 0, t_paint = 0, n_step = 0, n_paint = 0, max_step = 0;
    for (long fr = 0; fr < frames; fr++) {
        int pw = 0;
        if (g.state == ST_TITLE || g.state == ST_READY) pw = (fr % 10) == 0;
        else if (g.state == ST_PLAY) pw = ap_decide();
        else if (g.state == ST_OVER) pw = g.st_frames > 20;
        if (pw) __atomic_add_fetch(&g_presses, 1, __ATOMIC_ACQ_REL);
        long a = ns_now();
        pthread_mutex_lock(&g_lock);
        int presses = __atomic_exchange_n(&g_presses, 0, __ATOMIC_ACQ_REL);
        int need = step(presses);
        pthread_mutex_unlock(&g_lock);
        long b = ns_now();
        t_step += b - a;
        n_step += 1;
        if (b - a > max_step) max_step = b - a;
        if (need) {
            long c = ns_now();
            orbit_paint();
            t_paint += ns_now() - c;
            n_paint += 1;
        }
    }
    leave_widget();
    printf("bench (ПК): тик %.1f мкс в среднем, max %.1f мкс; paint %.1f мкс; кадров с выводом %ld из %ld\n",
           t_step / 1000.0 / n_step, max_step / 1000.0, n_paint ? t_paint / 1000.0 / n_paint : 0.0, n_paint, n_step);
    return 0;
}

/* партии автопилотом без помех: сколько живет, какой уровень, от чего гибнет */
static int mode_play(long games) {
    enter_game();
    sim_seed(2024);
    long sum_frames = 0;
    int causes[8] = {0}, lv_hist[16] = {0};
    for (long n = 0; n < games; n++) {
        while (g.state != ST_PLAY) sim_frame(g.state == ST_OVER ? g.st_frames > OVER_LOCK_FRAMES : 1, 0);
        long fr = 0;
        int presses = 0;
        static uint16_t hist[4][SW * SH];
        while (g.state == ST_PLAY && fr < 20 * 60 * 15) {
            int pw = ap_search();
            presses += pw;
            memcpy(hist[fr & 3], screen, sizeof(screen));
            sim_frame(pw, 0);
            fr++;
        }
        if (getenv("SIM_DEATHS") && n < 16) {
            char p[600];
            for (int k = 0; k < 4; k++) {
                snprintf(p, sizeof(p), "%s/death%ld_%d.bin", getenv("SIM_DEATHS"), n, k);
                FILE *f = fopen(p, "wb");
                if (f) { fwrite(hist[(fr + k) & 3], 1, sizeof(screen), f); fclose(f); }
            }
            snprintf(p, sizeof(p), "%s/death%ld_9.bin", getenv("SIM_DEATHS"), n);
            FILE *f = fopen(p, "wb");
            if (f) { fwrite(screen, 1, sizeof(screen), f); fclose(f); }
        }
        int capped = g.state == ST_PLAY;    /* дошел до предела времени */
        sum_frames += fr;
        causes[clampi(g.cause, 0, 7)]++;
        lv_hist[clampi(g.level, 0, 15)]++;
        printf("партия %2ld: %5.1f с, уровень %d, очки %4u, нажатий в с %.2f, топливо %3d%%, причина %s\n", n + 1, fr / 20.0,
               g.level, g.score, presses * 20.0 / (fr ? fr : 1), g.fuel * 100 / FUEL_MAX,
               capped ? "жив, предел 15 мин" : CAUSE_TEXT[clampi(g.cause, 0, 6)]);
        if (capped) {
            game_reset();
            set_state(ST_READY);
        }
        while (g.state == ST_DYING) sim_frame(0, 0);
    }
    printf("в среднем %.1f с; уровни:", sum_frames / 20.0 / games);
    for (int i = 1; i < 16; i++)
        if (lv_hist[i]) printf(" %d:%d", i, lv_hist[i]);
    printf("\n");
    leave_widget();
    return 0;
}

/* крайние случаи: нет таймера, монохромный экран, двойной init, deinit без init, простой без вывода */
#define EXPECT(c, msg) do { if (!(c)) { fprintf(stderr, "FAIL %s\n", msg); return 3; } printf("ok   %s\n", msg); } while (0)
static int mode_edge(void) {
    orbit_deinit();                                     /* reset_widgets до первого входа */
    EXPECT(osa_ours() == 0, "deinit до init: таймеров нет");

    sim_no_timers = 1;
    enter_game();
    EXPECT(g.state == ST_NOTIMER && osa_ours() == 0, "нет свободного таймера: экран-сообщение");
    key_power();
    EXPECT(!widget_active && leaves == 1, "нет таймера: POWER - выход");
    sim_no_timers = 0;

    is_small_screen = 1;
    enter_game();
    EXPECT(g.state == ST_NOSCREEN && osa_ours() == 0, "монохромный экран: сообщение, без таймера");
    key_menu();
    EXPECT(!widget_active, "монохромный экран: MENU - выход");
    is_small_screen = 0;

    enter_game();
    orbit_init();                                       /* повторный init без deinit */
    EXPECT(osa_ours() == 1, "двойной init: один таймер");
    for (int i = 0; i < TITLE_IDLE_FRAMES + 10; i++) sim_frame(0, 0);
    long f0 = frames_shown;
    for (int i = 0; i < 100; i++) sim_frame(0, 0);
    EXPECT(frames_shown == f0, "заставка без нажатий: после 30 с кадры не выводятся");

    sim_frame(1, 0);
    sim_frame(1, 0);
    for (int i = 0; i < 30; i++) sim_frame(ap_search(), 0);
    EXPECT(g.state == ST_PLAY, "старт: полет");
    key_menu();
    EXPECT(g.state == ST_PAUSE, "MENU в полете - пауза");
    lcd_state = LED_SLEEP;                              /* экран погас на паузе */
    key_menu();
    EXPECT(widget_active && g.state == ST_PAUSE, "погасший экран: MENU только будит, игра не закрыта");
    key_power();
    sim_frame(0, 0);
    EXPECT(g.state == ST_PAUSE, "погасший экран: POWER только будит, пауза осталась");
    lcd_state = LED_ON;
    f0 = frames_shown;
    for (int i = 0; i < 200; i++) sim_frame(0, 0);
    EXPECT(frames_shown - f0 <= 1, "пауза: кадры не выводятся");
    sim_frame(1, 0);
    EXPECT(g.state == ST_COUNTDOWN, "POWER на паузе - отсчет 3-2-1");
    for (int i = 0; i < 40; i++) sim_frame(0, 0);
    EXPECT(g.state == ST_PLAY || g.state == ST_DYING, "после отсчета - полет");
    while (g.state == ST_PLAY) sim_frame(0, 0);         /* без тяги - падение */
    EXPECT(g.cause == CAUSE_FALL || g.cause == CAUSE_AST || g.cause == CAUSE_SAT || g.cause == CAUSE_DEB ||
           g.cause == CAUSE_WALL, "без нажатий ракета гибнет");
    while (g.state != ST_OVER) sim_frame(0, 0);
    sim_frame(1, 0);
    EXPECT(g.state == ST_OVER, "«Конец»: первое нажатие сразу не перезапускает");
    for (int i = 0; i < OVER_BLINK_FRAMES + 20; i++) sim_frame(0, 0);
    f0 = frames_shown;
    for (int i = 0; i < 100; i++) sim_frame(0, 0);
    EXPECT(frames_shown == f0, "«Конец»: после мигания кадры не выводятся");
    sim_frame(1, 0);
    EXPECT(g.state == ST_READY, "POWER на «Конец» - новая партия");
    key_menu();
    EXPECT(g.state == ST_PAUSE && g.prev_state == ST_READY, "MENU на старте - пауза");
    key_menu();
    EXPECT(!widget_active && osa_ours() == 0, "MENU на паузе - выход, таймер удален");
    EXPECT(osa_self_delete == 0, "таймер ни разу не удален из своего колбэка");
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "usage: %s shots|gif|stress|threads|bench ARG\n", argv[0]);
        return 1;
    }
    if (getenv("SIM_NO_TIMERS")) sim_no_timers = 1;
    if (!strcmp(argv[1], "shots")) return mode_shots(argv[2]);
    if (!strcmp(argv[1], "gif")) return mode_gif(argv[2]);
    if (!strcmp(argv[1], "stress")) return mode_stress(atol(argv[2]));
    if (!strcmp(argv[1], "threads")) return mode_threads(atol(argv[2]));
    if (!strcmp(argv[1], "bench")) return mode_bench(atol(argv[2]));
    if (!strcmp(argv[1], "play")) return mode_play(atol(argv[2]));
    if (!strcmp(argv[1], "edge")) return mode_edge();
    fprintf(stderr, "unknown mode %s\n", argv[1]);
    return 1;
}
