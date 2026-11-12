/*
 * Цветная загрузочная анимация при старте oled.
 *
 * Файлы (нет frames.bin - анимации нет, работает родной Welcome):
 *   BOOTANIM_DIR/frames.bin  - кадры 128x128 подряд, RGB565, старший байт
 *                              первым (как secret_screen_buf в put_pixel),
 *                              32768 байт на кадр, не больше BOOTANIM_MAX_FRAMES;
 *   BOOTANIM_DIR/durations   - длительность кадров в мс, по числу на строку;
 *                              нет строки - BOOTANIM_DEFAULT_MS;
 *   BOOTANIM_DIR/debug       - есть файл: журнал в BOOTANIM_LOG (до BOOTANIM_LOG_MAX байт).
 *
 * Анимация показывается один раз за загрузку роутера: при подготовке
 * создается BOOTANIM_FLAG в /var (/var в оперативной памяти). Не
 * показывается в режиме зарядки выключенного роутера и если родной oled
 * уже выключил экран.
 *
 * Работа: подготовка в register_notify_handler (frames.bin только
 * открывается и проверяется по размеру); каждый кадр читается pread в буфер
 * 32 КБ перед показом; первый кадр - вместо первого кадра родного oled;
 * дальше цепочка одноразовых таймеров osa_timer_create_ex; срок следующего
 * кадра считается от начала анимации. Кадры родного oled на это время не
 * выводятся, последний запоминается.
 *
 * Таймеры osa (libwebsdk): в процессе 20 слотов; одноразовый таймер после
 * срабатывания НЕ освобождает слот (состояние 2), слот освобождает только
 * osa_timer_delete_ex. Удаление таймера из его же колбэка завершает поток
 * (pthread_exit). Поэтому каждый колбэк удаляет таймер ПРЕДЫДУЩЕГО шага, а
 * последний таймер удаляется позже из другого потока (кадр oled, кнопка,
 * lcd_control_operate или следующий таймер). Одновременно занято не больше
 * двух слотов.
 *
 * Конец анимации (последний кадр отыграл или нажата кнопка): последний кадр
 * анимации остается на экране до первого кадра родного oled, отличного от
 * Welcome (Welcome = первый кадр родного oled после старта). Если такой не
 * пришел, выводится запомненный кадр родного oled: через BOOTANIM_HOLD_MS,
 * когда запомненный - не Welcome, и через BOOTANIM_WAIT_WELCOME_MS, когда
 * запомненный - Welcome.
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
#include <unistd.h>
#include <sys/types.h>
#include <time.h>

#include "oled.h"

#ifndef BOOTANIM_DIR
#define BOOTANIM_DIR "/app/hijacks/bootanim"
#endif

#ifndef BOOTANIM_FLAG
#define BOOTANIM_FLAG "/var/hijack_bootanim_shown"
#endif

#ifndef BOOTANIM_LOG
#define BOOTANIM_LOG "/var/hijack_bootanim.log"
#endif
#define BOOTANIM_LOG_MAX (64 * 1024)
/* журнал событий notify, кадров oled и lcd - первые столько мс после старта */
#define BOOTANIM_LOG_EVENTS_MS 30000

#define BOOTANIM_FRAME_SIZE (LCD_MAX_WIDTH * LCD_MAX_HEIGHT * 2)
#define BOOTANIM_MAX_FRAMES 128
#define BOOTANIM_DEFAULT_MS 250
#define BOOTANIM_MIN_MS 20
#define BOOTANIM_MAX_MS 10000
/* первый кадр родного oled позже этого срока после старта - анимацию не начинать */
#define BOOTANIM_START_WINDOW_MS 15000
/* после анимации ждать новый кадр родного oled, не дольше */
#ifndef BOOTANIM_HOLD_MS
#define BOOTANIM_HOLD_MS 1500          /* запомненный кадр - не Welcome */
#endif
#ifndef BOOTANIM_WAIT_WELCOME_MS
#define BOOTANIM_WAIT_WELCOME_MS 8000  /* запомненный кадр - Welcome */
#endif

/* режимы родного lcd_control_operate: 0 вкл, 1 тускло, 2 выкл */
#define NATIVE_LCD_SLEEP 2

#define HIDDEN __attribute__((visibility("hidden")))

extern void (*lcd_refresh_screen_real)(struct lcd_screen *screen);
extern uint32_t (*timer_create_ex)(uint32_t, uint32_t, void (*)(), uint32_t);
extern uint32_t (*timer_delete_ex)(uint32_t);

/* OFF - не готовилась; READY - ждет первого кадра oled; RUNNING - идет;
 * HOLD - кончилась, держит последний кадр; DONE - экран у родного oled */
enum { BA_OFF = 0, BA_READY, BA_RUNNING, BA_HOLD, BA_DONE };
static const char *ba_state_name[] = {"off", "ready", "running", "hold", "done"};

static int ba_state = BA_OFF;          /* читать и писать через BA_GET/BA_SET */
static pthread_mutex_t ba_lock = PTHREAD_MUTEX_INITIALIZER;
static int ba_fd = -1;                 /* открытый frames.bin */
static uint16_t ba_buf[LCD_MAX_WIDTH * LCD_MAX_HEIGHT];
static uint32_t ba_nframes = 0;
static uint32_t ba_ms[BOOTANIM_MAX_FRAMES];
static struct timespec ba_started_at;  /* показ первого кадра */
static uint32_t ba_end_ms = 0;          /* конец текущего кадра от начала анимации */
static uint32_t ba_cur = 0;
static struct lcd_screen *ba_last_native = NULL;
static uint32_t ba_last_hash = 0;
static uint32_t ba_welcome_hash = 0;
static int ba_have_welcome = 0;
static uint32_t ba_native_frames = 0;
static struct lcd_screen ba_screen = {1, LCD_MAX_HEIGHT, 1, LCD_MAX_WIDTH, BOOTANIM_FRAME_SIZE, NULL};
static int ba_native_lcd_mode = -1;    /* так же, атомарно */
static struct timespec ba_prepared_at;

/* таймеры: ждущие (еще не сработали) и сработавшие, но не удаленные (их
 * удаляет следующий колбэк или другой поток, свой колбэк - никогда) */
static uint32_t ba_frame_timer = 0;
static uint32_t ba_hold_timer = 0;
static uint32_t ba_fired[2] = {0, 0};
static int ba_need_reap = 0;           /* атомарно: в ba_fired что-то есть */

static int ba_log_fd = -1;
static uint32_t ba_log_size = 0;

#define BA_GET(v) __atomic_load_n(&(v), __ATOMIC_ACQUIRE)
#define BA_SET(v, x) __atomic_store_n(&(v), (x), __ATOMIC_RELEASE)

static void ba_tick(void);
static void ba_hold_timeout(void);

static uint32_t ba_ms_since(const struct timespec *t) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    int64_t ms = (int64_t)(now.tv_sec - t->tv_sec) * 1000 + (now.tv_nsec - t->tv_nsec) / 1000000;
    return ms < 0 ? 0 : (uint32_t)ms;
}

/* журнал: строка "мс_от_старта событие" */
static void ba_log(const char *fmt, ...) {
    if (ba_log_fd < 0 || __atomic_load_n(&ba_log_size, __ATOMIC_RELAXED) >= BOOTANIM_LOG_MAX) {
        return;
    }
    char line[256];
    int n = snprintf(line, sizeof(line), "%6u ", ba_ms_since(&ba_prepared_at));
    va_list ap;
    va_start(ap, fmt);
    n += vsnprintf(line + n, sizeof(line) - n - 1, fmt, ap);
    va_end(ap);
    if (n > (int)sizeof(line) - 2) {
        n = sizeof(line) - 2;
    }
    line[n++] = '\n';
    if (write(ba_log_fd, line, n) == n) {
        __atomic_add_fetch(&ba_log_size, n, __ATOMIC_RELAXED);
    }
}

/* тот же журнал для других частей библиотеки (главный экран) */
void hij_log(const char *fmt, ...) {
    if (ba_log_fd < 0 || __atomic_load_n(&ba_log_size, __ATOMIC_RELAXED) >= BOOTANIM_LOG_MAX) {
        return;
    }
    char line[200];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    ba_log("%s", line);
}

static int ba_log_events(void) {
    return ba_log_fd >= 0 && ba_ms_since(&ba_prepared_at) < BOOTANIM_LOG_EVENTS_MS;
}

/* FNV-1a по буферу кадра родного oled */
static uint32_t ba_hash(const struct lcd_screen *s) {
    if (!s || !s->buf) {
        return 0;
    }
    const uint8_t *p = (const uint8_t *)s->buf;
    uint32_t n = s->buf_len, h = 2166136261u;
    for (uint32_t i = 0; i < n; i += 1) {
        h = (h ^ p[i]) * 16777619u;
    }
    return h;
}

/* под ba_lock: удалить сработавшие таймеры; вызывать не из их колбэков */
static void ba_reap_locked(void) {
    BA_SET(ba_need_reap, 0);
    for (int i = 0; i < 2; i += 1) {
        if (ba_fired[i]) {
            uint32_t t = ba_fired[i];
            ba_fired[i] = 0;
            timer_delete_ex(t);
            ba_log("timer %08x deleted", t);
        }
    }
}

/* под ba_lock: свой сработавший таймер - удалит кто-то другой */
static void ba_defer_locked(uint32_t own) {
    if (!own) {
        return;
    }
    for (int i = 0; i < 2; i += 1) {
        if (!ba_fired[i]) {
            ba_fired[i] = own;
            BA_SET(ba_need_reap, 1);
            return;
        }
    }
    ba_log("timer %08x: no room to defer delete", own);
}

/* под ba_lock: удалить таймер, который еще не сработал (из другого потока) */
static void ba_cancel_locked(uint32_t *t) {
    if (*t) {
        timer_delete_ex(*t);
        ba_log("timer %08x cancelled", *t);
        *t = 0;
    }
}

/* режим запуска: 1 - зарядка выключенного роутера или особый режим */
static int ba_special_boot_mode(void) {
    char c = 0;
    int fd = open("/proc/gAppStartMode", O_RDONLY);
    if (fd >= 0) {
        if (read(fd, &c, 1) != 1) {
            c = 0;
        }
        close(fd);
    }
    int32_t power_on = 0;
    fd = open("/proc/power_on", O_RDONLY);
    if (fd >= 0) {
        if (read(fd, &power_on, sizeof(power_on)) != sizeof(power_on)) {
            power_on = 0;
        }
        close(fd);
    }
    ba_log("boot mode: gAppStartMode '%c' power_on %d", c ? c : '-', power_on);
    if (c == '1') {
        return 1;                  /* libplatform drvStartModeGet: режим 3 */
    }
    return power_on == 2;          /* drvStartModeGet: 2 - зарядка выключенного */
}

static void ba_close_frames(void) {
    if (ba_fd >= 0) {
        close(ba_fd);
    }
    ba_fd = -1;
}

static int ba_load(void) {
    int fd = open(BOOTANIM_DIR "/frames.bin", O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        ba_log("frames.bin open error %d", errno);
        return 0;
    }

    /* размер через lseek: не зависит от устройства struct stat */
    off_t size = lseek(fd, 0, SEEK_END);
    if (size <= 0 || size % BOOTANIM_FRAME_SIZE != 0 ||
        size / BOOTANIM_FRAME_SIZE > BOOTANIM_MAX_FRAMES || lseek(fd, 0, SEEK_SET) != 0) {
        ba_log("frames.bin bad size %ld", (long)size);
        fprintf(stderr, "bootanim: bad frames.bin size\n");
        close(fd);
        return 0;
    }

    /* кадры не читаются здесь: каждый читается pread перед показом */
    ba_fd = fd;
    ba_nframes = size / BOOTANIM_FRAME_SIZE;

    for (uint32_t i = 0; i < ba_nframes; i += 1) {
        ba_ms[i] = BOOTANIM_DEFAULT_MS;
    }
    FILE *f = fopen(BOOTANIM_DIR "/durations", "r");
    if (f) {
        for (uint32_t i = 0; i < ba_nframes; i += 1) {
            unsigned int ms;
            if (fscanf(f, "%u", &ms) != 1) {
                break;
            }
            if (ms < BOOTANIM_MIN_MS) {
                ms = BOOTANIM_MIN_MS;
            }
            if (ms > BOOTANIM_MAX_MS) {
                ms = BOOTANIM_MAX_MS;
            }
            ba_ms[i] = ms;
        }
        fclose(f);
    }
    return 1;
}

/* флаг "уже показана в эту загрузку"; 1 - флаг создан сейчас */
static int ba_take_flag(void) {
    int fd = open(BOOTANIM_FLAG, O_WRONLY | O_CREAT | O_EXCL, 0644);
    if (fd < 0) {
        ba_log("flag %s: %s", BOOTANIM_FLAG, errno == EEXIST ? "exists, skip" : strerror(errno));
        if (errno != EEXIST) {
            fprintf(stderr, "bootanim: can't create %s: %s\n", BOOTANIM_FLAG, strerror(errno));
        }
        return 0;
    }
    close(fd);
    return 1;
}

/* Вызывается из register_notify_handler, когда таймеры уже найдены */
HIDDEN void bootanim_prepare(void) {
    if (BA_GET(ba_state) != BA_OFF || !timer_create_ex || !timer_delete_ex || !lcd_refresh_screen_real) {
        return;
    }
    BA_SET(ba_state, BA_DONE);
    clock_gettime(CLOCK_MONOTONIC, &ba_prepared_at);

    /* oled к этому моменту работает с euid 1000, сохраненный uid 0 (хук setuid) */
    uid_t euid = geteuid();
    int raised = (euid != 0 && seteuid(0) == 0);

    if (access(BOOTANIM_DIR "/debug", F_OK) == 0) {
        ba_log_fd = open(BOOTANIM_LOG, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
        ba_log("---- oled start, pid %d, euid %d, raised %d", getpid(), euid, raised);
    }

    int ok = access(BOOTANIM_DIR "/frames.bin", F_OK) == 0 &&
             !ba_special_boot_mode() && ba_take_flag() && ba_load();

    if (raised) {
        seteuid(euid);
    }

    if (ok) {
        ba_log("prepared: %u frames", ba_nframes);
        fprintf(stderr, "bootanim: %u frames ready\n", ba_nframes);
        BA_SET(ba_state, BA_READY);
    } else {
        ba_log("not shown");
    }
}

/* Дочерний процесс скрипта меню, перед exec: записать, с какими правами он стартует */
HIDDEN void bootanim_debug_child(const char *what) {
    if (ba_log_fd < 0) {
        return;
    }
    uid_t r, e, s;
    gid_t gr, ge, gs;
    getresuid(&r, &e, &s);
    getresgid(&gr, &ge, &gs);
    gid_t g[8];
    int n = getgroups(8, g);
    ba_log("script uid %d/%d/%d gid %d/%d/%d groups %d [%d %d] %.80s",
           r, e, s, gr, ge, gs, n, n > 0 ? g[0] : -1, n > 1 ? g[1] : -1, what);
}

/* под ba_lock: прочитать и показать кадр ba_cur, завести таймер до его конца */
static int ba_show_and_schedule_locked(void) {
    off_t off = (off_t)ba_cur * BOOTANIM_FRAME_SIZE;
    size_t done = 0;
    while (done < BOOTANIM_FRAME_SIZE) {
        ssize_t r = pread(ba_fd, (uint8_t *)ba_buf + done, BOOTANIM_FRAME_SIZE - done, off + done);
        if (r <= 0) {
            if (r < 0 && errno == EINTR) {
                continue;
            }
            ba_log("frame %u pread error %d (%d)", ba_cur, (int)r, errno);
            fprintf(stderr, "bootanim: frame %u read error\n", ba_cur);
            return 0;
        }
        done += r;
    }
    if (ba_cur == 0) {
        clock_gettime(CLOCK_MONOTONIC, &ba_started_at);
        ba_end_ms = 0;
    }
    ba_screen.buf = ba_buf;
    lcd_refresh_screen_real(&ba_screen);

    /* срок от начала анимации: чтение и вывод не сдвигают следующие кадры */
    ba_end_ms += ba_ms[ba_cur];
    uint32_t elapsed = ba_ms_since(&ba_started_at);
    uint32_t delay = ba_end_ms > elapsed + BOOTANIM_MIN_MS ? ba_end_ms - elapsed : BOOTANIM_MIN_MS;
    uint32_t t = timer_create_ex(delay, 0, ba_tick, 0);
    ba_log("frame %u shown at %u, next in %u, timer %08x", ba_cur, elapsed, delay, t);
    if (!t) {
        return 0;
    }
    ba_frame_timer = t;
    return 1;
}

/* под ba_lock: экран родному oled; restore - вывести запомненный кадр */
static void ba_done_locked(int restore, const char *why) {
    BA_SET(ba_state, BA_DONE);
    int shown = 0;
    if (restore && ba_last_native && BA_GET(ba_native_lcd_mode) != NATIVE_LCD_SLEEP) {
        lcd_refresh_screen_real(ba_last_native);
        shown = 1;
    }
    ba_log("done: %s, native frame restored %d", why, shown);
    ba_last_native = NULL;
    ba_screen.buf = NULL;
    ba_close_frames();
}

/* под ba_lock: анимация кончилась (отыграла или прервана); why - причина */
static void ba_finish_locked(const char *why) {
    ba_screen.buf = NULL;
    ba_close_frames();         /* последний кадр уже на экране, кадры больше не нужны */
    ba_log("finish: %s at frame %u", why, ba_cur);

    if (BA_GET(ba_native_lcd_mode) == NATIVE_LCD_SLEEP) {
        ba_done_locked(0, "lcd sleep at finish");
        return;
    }
    /* держать последний кадр анимации до нового кадра родного oled */
    int on_welcome = !ba_last_native || (ba_have_welcome && ba_last_hash == ba_welcome_hash);
    BA_SET(ba_state, BA_HOLD);       /* бывает один раз за запуск oled */
    uint32_t t = timer_create_ex(on_welcome ? BOOTANIM_WAIT_WELCOME_MS : BOOTANIM_HOLD_MS, 0,
                                 ba_hold_timeout, 0);
    ba_log("hold: native on welcome %d, timer %08x", on_welcome, t);
    if (!t) {
        ba_done_locked(1, "no timer for hold");
        return;
    }
    ba_hold_timer = t;
}

/* колбэк таймера кадра */
static void ba_tick(void) {
    pthread_mutex_lock(&ba_lock);
    /* этот таймер сработал: удалить прошлые сработавшие, а этот - позже */
    ba_reap_locked();
    ba_defer_locked(ba_frame_timer);
    ba_frame_timer = 0;

    if (BA_GET(ba_state) == BA_RUNNING) {
        if (BA_GET(ba_native_lcd_mode) == NATIVE_LCD_SLEEP) {
            ba_done_locked(0, "lcd sleep");
        } else {
            ba_cur += 1;
            if (ba_cur >= ba_nframes) {
                ba_finish_locked("last frame played");
            } else if (!ba_show_and_schedule_locked()) {
                ba_finish_locked("frame error or no timer");
            }
        }
    }
    pthread_mutex_unlock(&ba_lock);
}

/* новый кадр родного oled так и не пришел - вывести запомненный */
static void ba_hold_timeout(void) {
    pthread_mutex_lock(&ba_lock);
    ba_reap_locked();                 /* таймер последнего кадра */
    ba_defer_locked(ba_hold_timer);   /* этот (таймер ожидания) - удалит другой поток */
    ba_hold_timer = 0;
    if (BA_GET(ba_state) == BA_HOLD) {
        ba_done_locked(1, "hold timeout");
    }
    pthread_mutex_unlock(&ba_lock);
}

/*
 * Из хука lcd_refresh_screen для кадров родного oled.
 * 1 - кадр не выводить (экран занят анимацией).
 */
HIDDEN int bootanim_hold_frame(struct lcd_screen *screen) {
    int state = BA_GET(ba_state);
    if (state == BA_OFF) {
        return 0;
    }
    if (state == BA_DONE) {
        if (BA_GET(ba_need_reap) || ba_log_events()) {
            pthread_mutex_lock(&ba_lock);
            ba_reap_locked();         /* последний таймер анимации */
            pthread_mutex_unlock(&ba_lock);
            ba_native_frames += 1;
            if (ba_log_events() && ba_native_frames <= 200) {
                ba_log("native frame %u (done) hash %08x", ba_native_frames, ba_hash(screen));
            }
        }
        return 0;
    }

    int hold = 0;
    uint32_t h = ba_hash(screen);
    pthread_mutex_lock(&ba_lock);
    ba_native_frames += 1;
    ba_log("native frame %u (%s) hash %08x", ba_native_frames, ba_state_name[BA_GET(ba_state)], h);
    switch (BA_GET(ba_state)) {
    case BA_READY:
        if (BA_GET(ba_native_lcd_mode) == NATIVE_LCD_SLEEP ||
            ba_ms_since(&ba_prepared_at) > BOOTANIM_START_WINDOW_MS) {
            ba_done_locked(0, "lcd sleep or late start");
            break;
        }
        /* первый кадр родного oled после старта - Welcome */
        ba_welcome_hash = h;
        ba_have_welcome = 1;
        ba_last_native = screen;
        ba_last_hash = h;
        ba_cur = 0;
        BA_SET(ba_state, BA_RUNNING);
        if (ba_show_and_schedule_locked()) {
            hold = 1;
        } else {
            ba_done_locked(0, "first frame failed");   /* кадр родного oled идет как есть */
        }
        break;
    case BA_RUNNING:
        ba_last_native = screen;
        ba_last_hash = h;
        hold = 1;
        break;
    case BA_HOLD:
        ba_last_native = screen;
        ba_last_hash = h;
        ba_reap_locked();             /* таймер последнего кадра */
        if (ba_have_welcome && h == ba_welcome_hash) {
            hold = 1;                 /* все еще Welcome - держать кадр анимации */
        } else {
            ba_cancel_locked(&ba_hold_timer);
            ba_done_locked(0, "new native frame");
        }
        break;
    }
    pthread_mutex_unlock(&ba_lock);
    return hold;
}

/* Из notify_handler_async: журнал событий; key - нажатие кнопки (прервать анимацию) */
HIDDEN void bootanim_notify(int subsystemid, int action, int subaction, int key) {
    if (ba_log_events()) {
        ba_log("notify %d %d %x%s (%s)", subsystemid, action, subaction, key ? " key" : "",
               ba_state_name[BA_GET(ba_state)]);
    }
    if (!key) {
        return;
    }
    int state = BA_GET(ba_state);
    if (state != BA_READY && state != BA_RUNNING) {
        return;
    }
    pthread_mutex_lock(&ba_lock);
    if (BA_GET(ba_state) == BA_RUNNING) {
        ba_reap_locked();
        ba_cancel_locked(&ba_frame_timer);   /* таймер следующего кадра не нужен */
        ba_finish_locked("key");
    } else if (BA_GET(ba_state) == BA_READY) {
        ba_done_locked(0, "key before start");
    }
    pthread_mutex_unlock(&ba_lock);
}

/* Из хука lcd_control_operate для вызовов родного oled */
HIDDEN void bootanim_native_lcd_mode(int mode) {
    BA_SET(ba_native_lcd_mode, mode);
    if (ba_log_events()) {
        ba_log("lcd_control_operate %d (%s)", mode, ba_state_name[BA_GET(ba_state)]);
    }
    if (mode == NATIVE_LCD_SLEEP && BA_GET(ba_state) == BA_HOLD) {
        pthread_mutex_lock(&ba_lock);
        if (BA_GET(ba_state) == BA_HOLD) {
            ba_reap_locked();
            ba_cancel_locked(&ba_hold_timer);
            ba_done_locked(0, "lcd sleep in hold");
        }
        pthread_mutex_unlock(&ba_lock);
    }
}
