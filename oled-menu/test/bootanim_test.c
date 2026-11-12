/* Проверка логики oled_bootanim.c на ПК: заглушки таймеров osa и вывода на экран.
 * Родной oled: первый кадр Welcome (W), потом главный экран (H) в момент home_ms. */
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "oled.h"

void bootanim_prepare(void);
int bootanim_hold_frame(struct lcd_screen *screen);
void bootanim_notify(int subsystemid, int action, int subaction, int key);
void bootanim_native_lcd_mode(int mode);

static struct timespec t0;
static long now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (t.tv_sec - t0.tv_sec) * 1000 + (t.tv_nsec - t0.tv_nsec) / 1000000; }

static uint16_t native_buf[128 * 128];
static struct lcd_screen native = {1, 128, 1, 128, 32768, native_buf};
static volatile char native_content = 'W';     /* что сейчас в буфере родного oled */
static int anim_frames_shown = 0, welcome_after_anim = 0;
static long last_anim_ms = -1;
static long anim_t[256];
static int slow_ms = 0;                         /* имитация медленного вывода кадра */

static void refresh_stub(struct lcd_screen *s) {
    if (s == &native) {
        long t = now_ms();
        printf("%5ld ms: экран <- родной кадр %c\n", t, native_content);
        if (native_content == 'W' && anim_frames_shown > 0) welcome_after_anim = 1;
    } else {
        if (anim_frames_shown < 256) anim_t[anim_frames_shown] = now_ms();
        anim_frames_shown += 1; last_anim_ms = now_ms();
        if (slow_ms) usleep(slow_ms * 1000);
    }
}
/* модель таймеров osa (libwebsdk): 20 слотов; 0 свободен, 1 ждет, 2 истек, 3 удаляется.
 * Одноразовый после колбэка - 2 (слот занят), освобождает только delete. */
#define OSA_SLOTS 20
static int osa_state[OSA_SLOTS];
static pthread_mutex_t osa_lock = PTHREAD_MUTEX_INITIALIZER;
static int max_used = 0, create_fail = 0, self_delete = 0, native_slots = 6;
struct handle { int slot; pthread_t th; };
static struct handle *hptr[4097];
struct targ { uint32_t ms; void (*cb)(); int slot; };
static int osa_used(void) { int n = 0; for (int i = 0; i < OSA_SLOTS; i++) n += osa_state[i] != 0; return n; }
static void *timer_thread(void *a) {
    struct targ *t = a; usleep(t->ms * 1000);
    pthread_mutex_lock(&osa_lock);
    if (osa_state[t->slot] == 3) { osa_state[t->slot] = 0; pthread_mutex_unlock(&osa_lock); free(t); return NULL; }
    pthread_mutex_unlock(&osa_lock);
    t->cb();
    pthread_mutex_lock(&osa_lock);
    osa_state[t->slot] = osa_state[t->slot] == 3 ? 0 : 2;
    pthread_mutex_unlock(&osa_lock);
    free(t); return NULL;
}
static uint32_t timer_stub(uint32_t ms, uint32_t repeat, void (*cb)(), uint32_t arg) {
    (void)arg; if (repeat) { printf("ОШИБКА: периодический таймер\n"); exit(1); }
    pthread_mutex_lock(&osa_lock);
    int slot = -1;
    for (int i = 0; i < OSA_SLOTS; i++) if (osa_state[i] == 0) { slot = i; break; }
    if (slot < 0) { create_fail += 1; pthread_mutex_unlock(&osa_lock); return 0; }
    osa_state[slot] = 1;
    int u = osa_used(); if (u > max_used) max_used = u;
    static struct handle hs[4096]; static int nh = 0;    /* номер = индекс+1 (на ПК указатель не влезет в 32 бита) */
    if (nh >= 4096) { pthread_mutex_unlock(&osa_lock); return 0; }
    struct handle *h = &hs[nh]; uint32_t id = (uint32_t)++nh; h->slot = slot;
    pthread_mutex_unlock(&osa_lock);
    struct targ *t = malloc(sizeof *t); t->ms = ms; t->cb = cb; t->slot = slot;
    pthread_create(&h->th, NULL, timer_thread, t); pthread_detach(h->th);
    hptr[id] = h;
    return id;
}
static uint32_t delete_stub(uint32_t id) {
    if (id == 0 || id >= 4097 || !hptr[id]) { printf("ОШИБКА: удаление неизвестного таймера %u\n", id); return 0; }
    struct handle *h = hptr[id]; hptr[id] = NULL;
    if (pthread_equal(h->th, pthread_self())) { self_delete += 1; printf("ОШИБКА: удаление таймера из его колбэка\n"); }
    pthread_mutex_lock(&osa_lock);
    if (osa_state[h->slot] == 2) osa_state[h->slot] = 0; else osa_state[h->slot] = 3;
    pthread_mutex_unlock(&osa_lock);
    return 0;
}
void (*lcd_refresh_screen_real)(struct lcd_screen *screen) = refresh_stub;
uint32_t (*timer_create_ex)(uint32_t, uint32_t, void (*)(), uint32_t) = timer_stub;
uint32_t (*timer_delete_ex)(uint32_t) = delete_stub;

static void set_content(char c) { native_content = c; memset(native_buf, c, sizeof native_buf); }
static void native_refresh(void) { if (!bootanim_hold_frame(&native)) refresh_stub(&native); }

int main(int argc, char **argv) {
    const char *mode = argc > 1 ? argv[1] : "full";
    long home_ms = argc > 2 ? atol(argv[2]) : 2000;   /* когда родной oled рисует главный экран */
    long key_ms = argc > 3 ? atol(argv[3]) : -1;
    long end_ms = argc > 4 ? atol(argv[4]) : 15000;
    slow_ms = argc > 5 ? atoi(argv[5]) : 0;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    if (getenv("NATIVE_SLOTS")) native_slots = atoi(getenv("NATIVE_SLOTS"));
    for (int i = 0; i < native_slots; i++) osa_state[i] = 1;   /* таймеры родного oled */
    set_content('W');
    bootanim_prepare();
    if (!strcmp(mode, "sleep")) bootanim_native_lcd_mode(2);
    native_refresh();                                   /* Welcome */
    int home_done = 0;
    for (long t = 100; t <= end_ms; t += 100) {
        usleep(100 * 1000);
        if (key_ms >= 0 && t == key_ms) { printf("%5ld ms: нажата кнопка\n", now_ms()); bootanim_notify(21002, 9, 0, 1); }
        if (!strcmp(mode, "lcdoff") && t == 1500) { printf("%5ld ms: родной oled выключил экран\n", now_ms()); bootanim_native_lcd_mode(2); }
        if (home_ms >= 0 && !home_done && t >= home_ms) { set_content('H'); native_refresh(); home_done = 1; continue; }
        if (!home_done && t % 1000 == 0) native_refresh();   /* Welcome перерисовывается раз в секунду */
        if (home_done && t % 5000 == 0) native_refresh();     /* главный экран обновляется редко */
    }
    /* отклонение показа кадров от расписания durations */
    FILE *f = fopen(DUR_FILE, "r"); long sched = 0, maxdev = 0; unsigned ms;
    for (int i = 0; f && i < anim_frames_shown && i < 256; i += 1) {
        long dev = anim_t[i] - anim_t[0] - sched; if (dev < 0) dev = -dev; if (dev > maxdev) maxdev = dev;
        if (fscanf(f, "%u", &ms) != 1) break; sched += ms;
    }
    if (f) fclose(f);
    printf("расписание: кадр %d показан в %ld мс от первого, наибольшее отклонение от durations %ld мс\n",
           anim_frames_shown - 1, anim_frames_shown ? anim_t[anim_frames_shown - 1] - anim_t[0] : 0, maxdev);
    printf("ИТОГ: кадров анимации %d, последний в %ld мс, Welcome после анимации: %s, слотов osa занято макс %d (чужих %d), в конце %d, отказов создания %d, удалений из своего колбэка %d\n",
           anim_frames_shown, last_anim_ms, welcome_after_anim ? "ДА" : "нет", max_used, native_slots, (pthread_mutex_lock(&osa_lock), osa_used()), create_fail, self_delete);
    return 0;
}
