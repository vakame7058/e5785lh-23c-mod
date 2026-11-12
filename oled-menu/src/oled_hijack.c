/*
 * Advanced OLED menu for Huawei E5785 portable LTE router.
 *
 */

#define _GNU_SOURCE
#include <stdlib.h>
#include <dlfcn.h>
#include <unistd.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

#include <sys/capability.h>

#include "oled.h"

extern uint8_t is_small_screen;

extern struct lcd_screen secret_screen;
static uint8_t is_secret_screen_active = 0;

/* язык меню, см. oled.h; скрипты получают его в переменной HIJ_LANG */
uint8_t hij_lang_ru = 1;

/* родной oled загрузил файл языка: ".../res/lang_<язык>.xml" */
static void hij_detect_lang(const char *path) {
    const char *p = path ? strstr(path, "/res/lang_") : NULL;
    if (!p) {
        return;
    }
    hij_lang_ru = (strncmp(p, "/res/lang_russian.xml", 21) == 0);
    setenv("HIJ_LANG", hij_lang_ru ? "ru" : "en", 1);
    fprintf(stderr, "menu language: %s\n", hij_lang_ru ? "ru" : "en");
}

extern struct uint32_t active_widget;
extern struct led_widget *widgets;

extern void reset_widgets();
extern void dispatch_power_key();
extern void dispatch_menu_key();

extern void switch_to_small_screen_mode();

/* загрузочная анимация, oled_bootanim.c */
extern void bootanim_prepare(void);
extern int bootanim_hold_frame(struct lcd_screen *screen);
extern void bootanim_notify(int subsystemid, int action, int subaction, int key);
extern void bootanim_native_lcd_mode(int mode);
#include "oled_home.h"

int hij_secret_active(void) {
    return is_secret_screen_active;
}

/*
 * Real handlers from oled binary and libraries
 */

int (*notify_handler_async_real)(int subsystemid, int action, int subaction) = NULL;
void (*lcd_refresh_screen_real)(struct lcd_screen* screen) = NULL;
int (*lcd_control_operate_real)(int lcd_mode) = NULL;

uint32_t (*timer_create_ex)(uint32_t, uint32_t, void (*)(), uint32_t) = 0;
uint32_t (*timer_delete_ex)(uint32_t) = 0;
uint32_t (*get_msgQ_id)(uint32_t) = 0;
uint32_t (*msgQex_send)(uint32_t, uint32_t*, uint32_t, uint32_t);


static void send_msg(uint32_t msg_type) {
    const int DEFAULT_QUEUE_ID = 1001;

    uint32_t msg_queue = get_msgQ_id(DEFAULT_QUEUE_ID);
    if (!msg_queue) {
        fprintf(stderr, "Failed to get message queue to close the menu\n");
        return;
    }
    uint32_t msg[2] = {msg_type, 0};
    msgQex_send(msg_queue, msg, 2*sizeof(uint32_t), 0);
}


#ifdef NATIVE_MENU_ITEM
/*
 * Вход в доп. меню из родного меню oled коротким нажатием POWER на пункте
 * с id NATIVE_MENU_ITEM (id пункта из WebApp/common/config/oled/menue.xml).
 *
 * Смещения только для oled E5785Lh-23c 21.191.63.02
 * (sha256 fb9d2346f3c09ff1e5db552e8840eab51bfcd0a176ebc4507dd56edc0dbf7b77).
 * На другом oled проверка сигнатур не пройдет, и остается только долгое МЕНЮ.
 */
#define OLED_ASYNC_HANDLER  0x6fd1   /* родной обработчик событий (Thumb) */
#define OLED_SYNC_HANDLER   0x6f0d
#define OLED_CUR_PAGE       0x2fcd8  /* int32: -1 меню закрыто, 0 главная страница */
#define OLED_PAGES          0x3493c  /* массив страниц, шаг 0x34 */
#define OLED_PAGE_SIZE      0x34
#define OLED_PAGE_SEL_ITEM  0x20     /* указатель на выбранный пункт, пункт+0 = id */
#define OLED_PAGE_FIRST     0x14     /* первый пункт страницы */
#define OLED_ITEM_NEXT      0x28     /* следующий пункт */
#define OLED_ITEM_VISIBLE   0x24     /* 0 - пункт скрыт */
#define OLED_ITEM_CHECKS    0x2c9cc  /* таблица {id, проверка видимости} */
#define OLED_LCD_STATE      0x2fcf0  /* int32: -1 до старта, 0 светит, 1 тускло, 2 сон */
#define OLED_PAINT_LIST     0x34614  /* видимые элементы: узел {элемент*, next*} */
#define OLED_ELEM_MENU      0xd4     /* элемент меню, +2 = id (u16) */
/*
 * Пункт 13 (Быст. загр.) этот oled прячет всегда: его проверка видимости
 * 0x1610c - "return 0", и инициализация меню 0x16a34 пишет пункт+0x24 = 0.
 * Поэтому пункт делается видимым здесь, перед каждым нажатием MENU/POWER.
 */

static uintptr_t oled_base = 0;

static const uint8_t oled_sig_16dbc[8] = {0x0c, 0x4b, 0x70, 0xb5, 0x7b, 0x44, 0x18, 0x68};
static const uint8_t oled_sig_18150[8] = {0x3f, 0x4b, 0x30, 0xb5, 0x7b, 0x44, 0x85, 0xb0};
/* 0x18e44: список пунктов (ldr [r0,#0x14] ... ldr r3,[r0]; cmp; beq; ldr r0,[r0,#0x28]) */
static const uint8_t oled_sig_18e44[12] = {0x40, 0x69, 0x03, 0xe0, 0x03, 0x68, 0x9e, 0x42, 0x02, 0xd0, 0x80, 0x6a};
/* 0x1698c: str r7, [r6, #0x24] - видимость пункта */
static const uint8_t oled_sig_1698c[2] = {0x77, 0x62};
/* 0x1b1ac: геттер состояния экрана (0x1b1b2 + 0x14b3e = 0x2fcf0) */
static const uint8_t oled_sig_1b1ac[12] = {0x01, 0x4b, 0x7b, 0x44, 0x18, 0x68, 0x70, 0x47, 0x3e, 0x4b, 0x01, 0x00};
/* 0x10c54: "показан ли элемент" по списку видимых (0x10c5c + 0x239b8 = 0x34614) */
static const uint8_t oled_sig_10c54[8] = {0x10, 0x4b, 0x13, 0xb5, 0x7b, 0x44, 0x1c, 0x68};

static void native_menu_init(void *sync_handler, void *async_handler) {
    uintptr_t base = (uintptr_t)async_handler - OLED_ASYNC_HANDLER;

    if ((base & 0xfff) != 0 || (uintptr_t)sync_handler != base + OLED_SYNC_HANDLER ||
        memcmp((const void *)(base + 0x16dbc), oled_sig_16dbc, sizeof(oled_sig_16dbc)) != 0 ||
        memcmp((const void *)(base + 0x18150), oled_sig_18150, sizeof(oled_sig_18150)) != 0 ||
        memcmp((const void *)(base + 0x18e44), oled_sig_18e44, sizeof(oled_sig_18e44)) != 0 ||
        memcmp((const void *)(base + 0x1698c), oled_sig_1698c, sizeof(oled_sig_1698c)) != 0 ||
        memcmp((const void *)(base + 0x1b1ac), oled_sig_1b1ac, sizeof(oled_sig_1b1ac)) != 0 ||
        memcmp((const void *)(base + 0x10c54), oled_sig_10c54, sizeof(oled_sig_10c54)) != 0 ||
        *(const uint32_t *)(base + 0x10c98) != 0x000239b8 ||
        *(const int32_t *)(base + OLED_ITEM_CHECKS + 8 * NATIVE_MENU_ITEM) != NATIVE_MENU_ITEM) {
        fprintf(stderr, "native menu item: unknown oled build, disabled\n");
        return;
    }
    oled_base = base;
    fprintf(stderr, "native menu item: enabled, item id %d\n", NATIVE_MENU_ITEM);
}

/* сделать пункт NATIVE_MENU_ITEM видимым на главной странице родного меню */
static void native_menu_show_item(void) {
    if (!oled_base) {
        return;
    }
    uint8_t *page0 = (uint8_t *)(oled_base + OLED_PAGES);
    uint8_t *item = *(uint8_t * volatile *)(page0 + OLED_PAGE_FIRST);
    for (int n = 0; item && n < 64; n += 1) {
        if (*(volatile int32_t *)item == NATIVE_MENU_ITEM) {
            volatile int32_t *visible = (volatile int32_t *)(item + OLED_ITEM_VISIBLE);
            if (*visible == 0) {
                *visible = 1;
            }
            return;
        }
        item = *(uint8_t * volatile *)(item + OLED_ITEM_NEXT);
    }
}

/* то же, что родной 0x10c54: элемент id есть в списке видимых */
static int native_elem_shown(uint16_t id) {
    void *const *node = *(void *const *volatile *)(oled_base + OLED_PAINT_LIST);
    for (int n = 0; node && n < 96; n += 1) {
        const uint8_t *elem = node[0];
        if (!elem) {
            break;
        }
        if (*(const volatile uint16_t *)(elem + 2) == id) {
            return 1;
        }
        node = (void *const *)node[1];
    }
    return 0;
}

/*
 * id выбранного пункта на главной странице родного меню или -1.
 * Страница oled не сбрасывается при закрытии меню (таймер, гашение экрана, выход из
 * секретного меню): без проверки показанного меню короткое POWER на главном экране
 * или при погасшем экране открывало бы секретное меню. Экран спит - нажатие отдается
 * oled, он только зажигает экран.
 */
static int native_menu_selected_item(void) {
    if (!oled_base) {
        return -1;
    }
    if (*(volatile int32_t *)(oled_base + OLED_LCD_STATE) == 2 || !native_elem_shown(OLED_ELEM_MENU)) {
        return -1;
    }
    int32_t page = *(volatile int32_t *)(oled_base + OLED_CUR_PAGE);
    if (page != 0) {
        return -1;
    }
    uint8_t *page_ptr = (uint8_t *)(oled_base + OLED_PAGES) + OLED_PAGE_SIZE * page;
    volatile int32_t *item = *(int32_t * volatile *)(page_ptr + OLED_PAGE_SEL_ITEM);
    if (!item) {
        return -1;
    }
    return *item;
}
#endif

/*
 * The main hijacked handler function.
 */
int notify_handler_async(int subsystemid, int action, int subaction) {
    fprintf(stderr, "notify_handler_async: %d, %d, %x\n", subsystemid, action, subaction);

    // журнал анимации; кнопка прерывает ее, нажатие обрабатывается дальше как обычно
    home_notify(subsystemid, action, subaction);
    bootanim_notify(subsystemid, action, subaction,
                    subsystemid == SUBSYSTEM_GPIO &&
                    (action == BUTTON_POWER || action == BUTTON_MENU || action == BUTTON_LONGMENU ||
                     action == BUTTON_LONGPOWER || action == BUTTON_LONGLONGPOWER));

    if (subsystemid == SUBSYSTEM_GPIO) {
#ifdef NATIVE_MENU_ITEM
        if (!is_secret_screen_active && (action == BUTTON_MENU || action == BUTTON_POWER)) {
            // до того, как oled откроет меню или сдвинет выбор
            native_menu_show_item();
        }
        if (!is_secret_screen_active && action == BUTTON_POWER &&
            (native_menu_selected_item() == NATIVE_MENU_ITEM || home_takes_power())) {
            // POWER на "нашем" пункте родного меню или на своем главном экране
            // (экран горит, меню и окон oled нет) работает как долгое МЕНЮ.
            // Экран спит, родное меню или окно - нажатие уходит в oled как есть.
            action = BUTTON_LONGMENU;
        }
#endif
        if (action == BUTTON_LONGMENU) {
            is_secret_screen_active = !is_secret_screen_active;
            reset_widgets();
            send_msg(UI_MENU_EXIT);
            // force restarting the led brightness timer if already fired
            if (!is_small_screen) {
                notify_handler_async_real(SUBSYSTEM_GPIO, BUTTON_POWER, 0);
            } else {
                notify_handler_async_real(SUBSYSTEM_GPIO, BUTTON_MENU, 0);
            }

            return 0;
        }

        if (is_secret_screen_active) {
            if (action == BUTTON_MENU) {
                dispatch_menu_key();
            } else if (action == BUTTON_POWER) {
                dispatch_power_key();
            }
            return 0;
        }
    }

    return notify_handler_async_real(subsystemid, action, subaction);
}

/*
 * Hijacked functions from various libraries.
 */

int lcd_control_operate(int lcd_mode) {
    if (!lcd_control_operate_real) {
        lcd_control_operate_real = dlsym(RTLD_NEXT, "lcd_control_operate");
        if (!lcd_control_operate_real) {
            return -1;
        }
    }
    if (!is_secret_screen_active && lcd_mode < 100) {
        // вызов родного oled: запомнить состояние экрана для загрузочной анимации
        bootanim_native_lcd_mode(lcd_mode);
    }
    // we use other values in secret mode to have full control on lcd
    if (is_secret_screen_active) {
        if(lcd_mode < 100) {
            return 0;
        } else {
            return lcd_control_operate_real(lcd_mode - 100);
        }
    } else {
        if(lcd_mode >= 100) {
            return 0;
        } else {
            return lcd_control_operate_real(lcd_mode);
        }
    }
}

void lcd_refresh_screen(struct lcd_screen* screen) {
    if (!lcd_refresh_screen_real) {
        lcd_refresh_screen_real = dlsym(RTLD_NEXT, "lcd_refresh_screen");
        if (!lcd_refresh_screen_real) {
            return;
        }
    }
    if (!is_secret_screen_active && screen == &secret_screen) {
        return;
    }
    if (!is_secret_screen_active && bootanim_hold_frame(screen)) {
        // экран занят загрузочной анимацией
        return;
    }
    if (!is_secret_screen_active && home_frame(screen)) {
        // вместо родного главного экрана выведен свой
        return;
    }
    if (is_secret_screen_active && screen != &secret_screen) {
        return;
    }
    if (!is_secret_screen_active && screen && screen->buf_len == 1024) {
        if (!is_small_screen) {
            switch_to_small_screen_mode();
        }
    }
    lcd_refresh_screen_real(screen);
}

int register_notify_handler(int subsystemid, void *notify_handler_sync, void *notify_handler_async_orig) {
    unsetenv("LD_PRELOAD");

    static int (*register_notify_handler_real)(int, void *, void *) = NULL;
    register_notify_handler_real = dlsym(RTLD_NEXT, "register_notify_handler");
    lcd_refresh_screen_real = dlsym(RTLD_NEXT, "lcd_refresh_screen");
    lcd_control_operate_real = dlsym(RTLD_NEXT, "lcd_control_operate");

    timer_create_ex = dlsym(RTLD_DEFAULT, "osa_timer_create_ex");
    timer_delete_ex = dlsym(RTLD_DEFAULT, "osa_timer_delete_ex");

    get_msgQ_id = dlsym(RTLD_DEFAULT, "osa_get_msgQ_id");
    msgQex_send = dlsym(RTLD_DEFAULT, "osa_msgQex_send");

    if (!register_notify_handler_real || !lcd_refresh_screen_real ||
        !lcd_control_operate_real || !timer_create_ex || !timer_delete_ex || !get_msgQ_id ||
        !msgQex_send) {
        fprintf(stderr, "The program is not compatible with this device\n");
        return 1;
    }

    notify_handler_async_real = notify_handler_async_orig;
#ifdef NATIVE_MENU_ITEM
    native_menu_init(notify_handler_sync, notify_handler_async_orig);
#endif
    if (!getenv("HIJ_LANG")) {
        setenv("HIJ_LANG", hij_lang_ru ? "ru" : "en", 1);
    }
    bootanim_prepare();
#ifdef NATIVE_MENU_ITEM
    if (((uintptr_t)notify_handler_async_orig & 0xfff) == (OLED_ASYNC_HANDLER & 0xfff)) {
        home_start((uintptr_t)notify_handler_async_orig - OLED_ASYNC_HANDLER);
    }
#endif
    return register_notify_handler_real(subsystemid, notify_handler_sync, notify_handler_async);
}

#ifdef OLED_CFG_OVERRIDE_DIR
/*
 * Подмена файлов родного меню без перепрошивки WebUI: если файл
 * OLED_CFG_OVERRIDE_DIR/<имя> существует (например res/lang_russian.xml),
 * oled читает его вместо /app/webroot/WebApp/common/config/oled/<имя>.
 * Нет файла - читается родной.
 */
int cl_xmlParseFile(const char *path, void *a1, void *a2, void *a3) {
    static int (*cl_xmlParseFile_real)(const char *, void *, void *, void *) = NULL;
    static const char OLED_CFG[] = "/config/oled/";

    if (!cl_xmlParseFile_real) {
        cl_xmlParseFile_real = dlsym(RTLD_NEXT, "cl_xmlParseFile");
        if (!cl_xmlParseFile_real) {
            return -1;
        }
    }

    hij_detect_lang(path);

    const char *rel = path ? strstr(path, OLED_CFG) : NULL;
    if (rel) {
        char alt[256];
        rel += sizeof(OLED_CFG) - 1;
        int n = snprintf(alt, sizeof(alt), "%s/%s", OLED_CFG_OVERRIDE_DIR, rel);
        if (n > 0 && n < (int)sizeof(alt) && access(alt, R_OK) == 0) {
            fprintf(stderr, "oled config override: %s\n", alt);
            return cl_xmlParseFile_real(alt, a1, a2, a3);
        }
    }
    return cl_xmlParseFile_real(path, a1, a2, a3);
}
#endif

int setuid(uid_t u) {
    // put uid to saved to be able to restore it when needed
    return setresuid(u, u, 0);
}

int setgid(gid_t g) {
    return setresgid(g, g, 0);
}

int prctl(int option, unsigned long arg2, unsigned long arg3,
                 unsigned long arg4, unsigned long arg5) {
    // not allowing to drop capabilities
    UNUSED(option);
    UNUSED(arg2);
    UNUSED(arg3);
    UNUSED(arg4);
    UNUSED(arg5);
    return -1;
}

int capset(cap_user_header_t hdrp, const cap_user_data_t datap) {
    datap[0].effective   |= (1 << CAP_NET_RAW) | (1 << CAP_NET_ADMIN);
    datap[0].permitted   |= (1 << CAP_NET_RAW) | (1 << CAP_NET_ADMIN);
    datap[0].inheritable |= (1 << CAP_NET_RAW) | (1 << CAP_NET_ADMIN);
    int (*capset_real)(cap_user_header_t, cap_user_data_t) = dlsym(RTLD_NEXT, "capset");
    if (!capset_real) {
        return -1;
    }

    return capset_real(hdrp, datap);
}
