#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include "oled.h"
void (*lcd_refresh_screen_real)(struct lcd_screen *screen);
uint32_t (*timer_create_ex)(uint32_t, uint32_t, void (*)(), uint32_t);
uint32_t (*timer_delete_ex)(uint32_t);
int hij_secret_active(void) { return 0; }
void hij_become_root(void) {}
void hij_log(const char *fmt, ...) { va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); fputc('\n', stderr); va_end(ap); }
