/*
 * Логика своего главного экрана на ПК с поддельной памятью oled:
 * код oled.orig скопирован (сверка FNV), глобалы и список видимых элементов - свои.
 * Проверки: когда свой экран, когда родной кадр; плашки; MCC-MNC из события 19012;
 * таймер в своем потоке параллельно с кадрами oled и перерисовкой меню (TSan).
 */
#define _GNU_SOURCE
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <time.h>

#include "oled.h"
#include "oled_home.h"

uint8_t hij_lang_ru = 1;
extern uint16_t secret_screen_buf[];
extern struct lcd_screen secret_screen;
extern void home_lock(void);
extern void home_unlock(void);
extern int home_takes_power(void);
extern int home_vpn_state(void);

static int secret = 0;
int hij_secret_active(void) { return __atomic_load_n(&secret, __ATOMIC_ACQUIRE); }
void hij_become_root(void) {}
static int logs = 0;
void hij_log(const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    fprintf(stderr, "  log: "); vfprintf(stderr, fmt, ap); fputc('\n', stderr);
    va_end(ap);
    logs += 1;
}

static int refresh_n = 0;
static const char *png_dir;
static void refresh(struct lcd_screen *s) {
    (void)s;
    __atomic_add_fetch(&refresh_n, 1, __ATOMIC_RELAXED);
}
void (*lcd_refresh_screen_real)(struct lcd_screen *screen) = refresh;

/* периодический таймер: свой поток */
static void (*tcb)(void);
static int tstop = 0, tperiod = 0;
static void *tthread(void *a) {
    (void)a;
    while (!__atomic_load_n(&tstop, __ATOMIC_ACQUIRE)) {
        usleep(tperiod * 1000);
        tcb();
    }
    return 0;
}
static pthread_t tth;
static uint32_t t_create(uint32_t ms, uint32_t per, void (*cb)(), uint32_t arg) {
    (void)per; (void)arg;
    tcb = cb; tperiod = getenv("TICK_MS") ? atoi(getenv("TICK_MS")) : (int)ms;
    pthread_create(&tth, 0, tthread, 0);
    return 1;
}
static uint32_t t_delete(uint32_t t) { (void)t; return 0; }
uint32_t (*timer_create_ex)(uint32_t, uint32_t, void (*)(), uint32_t) = t_create;
uint32_t (*timer_delete_ex)(uint32_t) = t_delete;

static uint8_t *mem;
#define I32(off) (*(int32_t *)(mem + (off)))
static uint8_t *el(int id) { return mem + 0x2fd58 + 0x50 * id; }
static void mkel(int id, int prio, int textid) {
    uint8_t *e = el(id);
    *(uint16_t *)(e + 2) = id; *(uint16_t *)(e + 4) = prio; *(uint16_t *)(e + 0x1e) = textid;
}
/* список видимых: узлы {элемент*, next*} */
static void *nodes[64][2];
static void shown(const int *ids, int n) {
    for (int i = 0; i < n; i += 1) {
        nodes[i][0] = el(ids[i]);
        nodes[i][1] = i + 1 < n ? nodes[i + 1] : 0;
    }
    *(void **)(mem + 0x34614) = n ? nodes[0] : 0;
}

static void snap(const char *name) {
    char p[512];
    snprintf(p, sizeof p, "%s/%s.raw", png_dir, name);
    FILE *f = fopen(p, "wb");
    fwrite(secret_screen_buf, 2, 128 * 128, f);
    fclose(f);
}

static int fails = 0;
#define CHECK(c, msg) do { if (c) printf("ok   %s\n", msg); else { printf("FAIL %s\n", msg); fails += 1; } } while (0)

static struct lcd_screen native = {1, 128, 1, 128, 32768, 0};

int main(int argc, char **argv) {
    png_dir = argc > 2 ? argv[2] : ".";
    mem = aligned_alloc(4096, 0x40000);
    memset(mem, 0, 0x40000);
    FILE *f = fopen(argv[1], "rb");
    size_t n = fread(mem, 1, 0x29a72, f);
    fclose(f);
    printf("oled.orig: %zu Б\n", n);

    /* строка оператора и глобалы как в рабочем oled */
    static char plmn[64] = "Tele2";
    *(char **)(el(0xb9) + 0x38) = plmn;
    static char flux[32] = "0.52GB/10GB";
    *(char **)(el(0xbb) + 0x38) = flux;
    I32(0x2fbc4) = 1; I32(0x2fcf0) = 0; I32(0x2fbc0) = 4; I32(0x2fbbc) = 0; I32(0x2fbb0) = 14;
    I32(0x342a8) = 13; I32(0x3429c) = 0x132; I32(0x342a4) = 0; I32(0x342a0) = 0; I32(0x2fbdc) = 0xfa;
    mem[0x345e8] = 3; I32(0x2fc0c) = 87; I32(0x34638) = 0;
    mkel(0x00, 0, 0); mkel(0xb9, 0, 0); mkel(0xbb, 1, 0); mkel(0x73, 24, 10); mkel(0x76, 24, 19);
    mkel(0xd4, 6, 0); mkel(0x8c, 8, 0); mkel(0x59, 30, 0); mkel(0x7a, 2, 14); mkel(0x71, 5, 1);
    int home_ids[] = {0x00, 0xb9, 0xbb};
    shown(home_ids, 3);

    /* неизвестная сборка: экран не включается */
    uint8_t save = mem[0x5000];
    mem[0x5000] ^= 0xff;
    home_start((uintptr_t)mem);
    CHECK(home_frame(&native) == 0, "чужая сборка oled: свой экран выключен");
    mem[0x5000] = save;

    home_start((uintptr_t)mem);
    CHECK(home_frame(&native) == 1, "главный экран oled -> свой экран");
    snap("50_logic_home");

    /* MCC-MNC из события 19012: структура в нижних 4 ГБ (action - int) */
    char *ev = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_32BIT, -1, 0);
    strcpy(ev + 0xa, "25020");
    home_notify(19012, (int)(uintptr_t)ev, 0);
    CHECK(home_frame(&native) == 1, "после 19012 свой экран");
    snap("51_logic_mccmnc_t2");

    /* r8: короткое POWER на своем главном экране */
    CHECK(home_takes_power() == 1, "POWER: свой экран, экран горит -> секретное меню");
    I32(0x2fcf0) = 1;
    CHECK(home_takes_power() == 1, "POWER: экран тусклый -> секретное меню");
    I32(0x2fcf0) = 2;
    CHECK(home_takes_power() == 0, "POWER: экран спит -> oled (только зажечь)");
    I32(0x2fcf0) = 0;
    int menu_ids0[] = {0x00, 0xb9, 0xd4};
    shown(menu_ids0, 3);
    CHECK(home_takes_power() == 0, "POWER: открыто родное меню (до кадра oled) -> oled");
    int upd_ids0[] = {0x00, 0x8c};
    shown(upd_ids0, 2);
    CHECK(home_takes_power() == 0, "POWER: окно обновления ПО (до кадра oled) -> oled");
    home_frame(&native);
    CHECK(home_takes_power() == 0, "POWER: окно обновления ПО на экране -> oled");
    int chg_ids0[] = {0x00, 0xb9, 0x73};
    shown(chg_ids0, 3);
    home_frame(&native);
    CHECK(home_takes_power() == 1, "POWER: плашка 'мало заряда' на своем экране -> секретное меню");
    shown(home_ids, 3);
    home_frame(&native);
    I32(0x2fbc4) = 3;
    CHECK(home_takes_power() == 0, "POWER: выключение (состояние 3) -> oled");
    I32(0x2fbc4) = 1;

    int menu_ids[] = {0x00, 0xb9, 0xd4};
    shown(menu_ids, 3);
    CHECK(home_frame(&native) == 0, "родное меню (0xd4) -> родной кадр");
    int upd_ids[] = {0x00, 0x8c};
    shown(upd_ids, 2);
    CHECK(home_frame(&native) == 0, "окно обновления ПО (priority 8) -> родной кадр");
    int chg_ids[] = {0x00, 0xb9, 0x73};
    shown(chg_ids, 3);
    CHECK(home_frame(&native) == 1, "окно 'мало заряда' (0x73) -> свой экран с плашкой");
    snap("52_logic_lowbat");
    int temp_ids[] = {0x00, 0xb9, 0x76};
    shown(temp_ids, 3);
    CHECK(home_frame(&native) == 1, "окно 'перегрев' (0x76) -> свой экран с плашкой");
    snap("53_logic_hot");
    int roam_ids[] = {0x00, 0xb9, 0x7a};
    shown(roam_ids, 3);
    I32(0x2fbbc) = 1;
    CHECK(home_frame(&native) == 1, "роуминг без данных (0x7a, priority 2) -> свой экран");
    snap("54_logic_roam_nodata");
    I32(0x2fbbc) = 0;
    shown(home_ids, 3);
    I32(0x2fbc4) = 0;
    CHECK(home_frame(&native) == 0, "Welcome (состояние 0) -> родной кадр");
    I32(0x2fbc4) = 3;
    CHECK(home_frame(&native) == 0, "выключение (состояние 3) -> родной кадр");
    I32(0x2fbc4) = 1;
    I32(0x3429c) = 0x12c;
    int sim_ids[] = {0x00, 0x71};
    shown(sim_ids, 2);
    CHECK(home_frame(&native) == 1, "нет SIM (0x71, priority 5) -> свой экран с плашкой");
    snap("55_logic_nosim");
    I32(0x3429c) = 0x132;
    shown(home_ids, 3);
    I32(0x342a4) = 2;
    CHECK(home_frame(&native) == 1, "новые SMS -> свой экран");
    snap("56_logic_sms");
    I32(0x342a4) = 0;
    plmn[0] = ' '; plmn[1] = 0;
    static char idle[64] = "MegaFon";
    *(char **)(el(0xca) + 0x38) = idle;
    memset(ev, 0, 32);
    CHECK(home_frame(&native) == 1, "имя в idleplmn, когда plmn пустой");
    snap("57_logic_idleplmn");
    strcpy(plmn, "Tele2");

    /* потоки: таймер (свой поток), кадры oled и перерисовка меню одновременно */
    int before = refresh_n;
    for (int i = 0; i < 300; i += 1) {
        home_frame(&native);
        if (i % 50 == 25) {
            __atomic_store_n(&secret, 1, __ATOMIC_RELEASE);
        }
        if (i % 50 == 40) {
            __atomic_store_n(&secret, 0, __ATOMIC_RELEASE);
        }
        home_lock();
        memset(secret_screen_buf, 0, 64);    /* как repaint() меню */
        home_unlock();
        usleep(2000);
    }
    __atomic_store_n(&tstop, 1, __ATOMIC_RELEASE);
    pthread_join(tth, 0);
    printf("кадров: %d (из них таймером ~%d)\n", refresh_n - before, refresh_n - before - 300);
    CHECK(refresh_n - before > 300, "таймер тоже выводил свой экран");
    const char *ve = getenv("VPN_EXPECT");
    if (ve) {
        printf("значок VPN: %d\n", home_vpn_state());
        CHECK(home_vpn_state() == atoi(ve), "значок VPN по svc.sh brief");
    }
    snap("58_logic_after_threads");
    printf("%s\n", fails ? "ЕСТЬ ОШИБКИ" : "все проверки пройдены");
    return fails != 0;
}
