#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include "oled.h"
void (*lcd_refresh_screen_real)(struct lcd_screen *screen);
int hij_secret_active(void) { return 1; }
void hij_become_root(void) {}
void hij_log(const char *fmt, ...) { (void)fmt; }
