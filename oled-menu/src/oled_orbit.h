/*
 * «Орбита» - игра для секретного меню hijack_ng (экран 128x128, RGB565).
 *
 * Одна кнопка: POWER - импульс тяги вверх, гравитация тянет вниз.
 * MENU - пауза; на паузе, заставке и экране «Конец» - выход из игры.
 *
 * Пункт меню (oled_widgets.c, массив widgets[]):
 *     {
 *         .name = "orbit",
 *         .lcd_sleep_ms = 60000,
 *         .init = orbit_init,
 *         .deinit = orbit_deinit,
 *         .paint = orbit_paint,
 *         .menu_key_handler = orbit_menu_key_pressed,
 *         .power_key_handler = orbit_power_key_pressed,
 *         .parent_idx = 0
 *     },
 *
 * Модуль берет из hijack_ng: repaint, leave_widget, lcd_state (oled_widgets.c),
 * put_raw_buffer, put_small_text, put_large_text, is_small_screen (oled_paint.c),
 * timer_create_ex, timer_delete_ex (oled_hijack.c), шрифты oled_font.h.
 *
 * Нажатие, которое будит погасший экран, игра пропускает.
 *
 * Таймер один: периодический ORBIT_TICK_MS, создается в orbit_init, удаляется
 * в orbit_deinit (не из своего колбэка). Кадр считается в колбэке таймера,
 * orbit_paint только копирует готовый кадр и выводит надписи.
 *
 * Рекорд - ORBIT_BEST_FILE, одно число текстом. Не прочитался или не
 * записался - игра идет без рекорда.
 */
#ifndef OLED_ORBIT_H
#define OLED_ORBIT_H

#ifndef ORBIT_BEST_FILE
#define ORBIT_BEST_FILE "/online/mod/conf/orbit_best"
#endif

/* период таймера кадра, мс: 50 = 20 кадров в секунду */
#ifndef ORBIT_TICK_MS
#define ORBIT_TICK_MS 50
#endif

void orbit_init(void);
void orbit_deinit(void);
void orbit_paint(void);
void orbit_power_key_pressed(void);
void orbit_menu_key_pressed(void);

#endif
