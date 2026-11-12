/*
 * Проверка меню на ПК: настоящие oled_widgets.c + oled_paint.c, заглушки oled.
 * Скрипты меню запускаются настоящие (из дерева сборки), svc.sh - заглушка.
 * menu_test <каталог_сборки> <svc.sh> <каталог_png> сценарий...
 *   сценарий: m - MENU, p - POWER, s<имя> - снимок экрана в <имя>.raw, busy/idle - процесс жив/нет
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dlfcn.h>
#include "oled.h"

uint8_t hij_lang_ru = 1;
uint32_t (*timer_create_ex)(uint32_t, uint32_t, void (*)(), uint32_t);
uint32_t (*timer_delete_ex)(uint32_t);
static uint32_t t_create(uint32_t a, uint32_t b, void (*f)(), uint32_t c) { (void)a; (void)b; (void)f; (void)c; return 1; }
static uint32_t t_delete(uint32_t a) { (void)a; return 0; }
void lcd_refresh_screen(struct lcd_screen *s) { (void)s; }
int lcd_control_operate(int x) { (void)x; return 0; }
int notify_handler_async(int a, int b, int c) { (void)a; (void)b; (void)c; return 0; }

extern uint16_t secret_screen_buf[];
extern uint32_t active_widget;
extern void enter_widget(uint32_t);
extern void repaint(void);
extern void dispatch_power_key(void);
extern void dispatch_menu_key(void);

static const char *build_dir, *svc_path;
static int alive = 0;
int process_is_alive() { return alive; }
void destroy_process() {}
void destroy_process_pooler() {}
int ncalls = 0;

/* пути роутера -> файлы в дереве сборки */
static const char *map_path(const char *p, char *buf, size_t n) {
    if (strcmp(p, "/online/mod/pkg/awg/svc.sh") == 0) return svc_path;
    const char *on = "/online/scripts/", *od = getenv("HIJ_TEST_ONLINE");
    if (od && strncmp(p, on, strlen(on)) == 0) {
        snprintf(buf, n, "%s/%s", od, p + strlen(on));
        return buf;
    }
    const char *pre = "/app/hijacks/scripts/";
    if (strncmp(p, pre, strlen(pre)) == 0) {
        snprintf(buf, n, "%s/scripts/%s", build_dir, p + strlen(pre));
        return buf;
    }
    return p;
}

int access(const char *p, int m) {
    static int (*real)(const char *, int);
    if (!real) real = dlsym(RTLD_NEXT, "access");
    char buf[512];
    return real(map_path(p, buf, sizeof buf), m);
}

static int hold_next = 0;
int create_process(char *command, void (*cb)(int, char *)) {
    if (hold_next) { hold_next = 0; alive = 1; fprintf(stderr, "[held] %s\n", command); return 0; }
    char script[512], buf[512], cmd[2048];
    const char *args = strchr(command, ' ');
    size_t sl = args ? (size_t)(args - command) : strlen(command);
    snprintf(script, sizeof script, "%.*s", (int)sl, command);
    const char *extra = getenv("HIJ_TEST_ENV");
    snprintf(cmd, sizeof cmd, "HIJ_B=/usr/bin/busybox HIJ_LANG=%s HIJ_VPN_SVC=%s %s busybox sh %s%s",
             hij_lang_ru ? "ru" : "en", svc_path, extra ? extra : "", map_path(script, buf, sizeof buf), args ? args : "");
    ncalls += 1;
    fprintf(stderr, "[create_process] %s\n", command);
    static char out[65536];
    FILE *f = popen(cmd, "r");
    size_t len = f ? fread(out, 1, sizeof out - 1, f) : 0;
    int rc = f ? pclose(f) : -1;
    out[len] = 0;
    if (getenv("HIJ_TEST_DUMP")) fprintf(stderr, "--- rc=%d\n%s---\n", rc, out);
    /* вывод с путями ПК -> пути роутера: HIJ_TEST_REWRITE="откуда=куда;..." */
    const char *rw = getenv("HIJ_TEST_REWRITE");
    if (rw) {
        char spec[1024];
        snprintf(spec, sizeof spec, "%s", rw);
        char *sp, *pair = strtok_r(spec, ";", &sp);
        while (pair) {
            char *eq = strchr(pair, '=');
            if (eq) {
                *eq = 0;
                const char *from = pair, *to = eq + 1;
                static char tmp[65536];
                size_t o = 0, fl = strlen(from), tl = strlen(to);
                for (size_t i = 0; out[i] && o < sizeof tmp - tl - 1; ) {
                    if (strncmp(out + i, from, fl) == 0) { memcpy(tmp + o, to, tl); o += tl; i += fl; }
                    else tmp[o++] = out[i++];
                }
                tmp[o] = 0;
                strcpy(out, tmp);
            }
            pair = strtok_r(NULL, ";", &sp);
        }
    }
    cb(rc != -1, out);
    return 0;
}

static void snap(const char *dir, const char *name) {
    char p[512];
    snprintf(p, sizeof p, "%s/%s.raw", dir, name);
    FILE *f = fopen(p, "wb");
    fwrite(secret_screen_buf, 2, 128 * 128, f);
    fclose(f);
}

int main(int argc, char **argv) {
    if (argc < 4) return 2;
    build_dir = argv[1];
    svc_path = argv[2];
    timer_create_ex = t_create;
    timer_delete_ex = t_delete;
    if (getenv("HIJ_TEST_EN")) hij_lang_ru = 0;
    enter_widget(0);
    for (int i = 4; i < argc; i += 1) {
        const char *a = argv[i];
        if (strcmp(a, "hold") == 0) { hold_next = 1; continue; }
        if (strcmp(a, "busy") == 0) { alive = 1; continue; }
        if (strcmp(a, "idle") == 0) { alive = 0; continue; }
        if (a[0] == 's') {
            memset(secret_screen_buf, 0, 128 * 128 * 2);
            repaint();
            snap(argv[3], a + 1);
            printf("snap %s widget=%u\n", a + 1, active_widget);
            continue;
        }
        for (const char *c = a; *c; c += 1) {
            memset(secret_screen_buf, 0, 128 * 128 * 2);
            if (*c == 'm') dispatch_menu_key();
            if (*c == 'p') dispatch_power_key();
        }
    }
    printf("calls=%d widget=%u\n", ncalls, active_widget);
    return 0;
}
