/*
 * Рисование своего главного экрана по готовым данным (struct home_view).
 * Без чтения файлов и памяти oled: так же рисуется и в проверке на ПК.
 *
 *   y 0..11    строка значков: SIM, SMS, роуминг, Wi-Fi, VPN; справа заряд
 *   y 12..34   часы и дата
 *   y 37..64   сигнал: вышка с полосками, проценты, тип сети; имя оператора
 *   y 68..97   скорость приема и передачи с графиком или плашка оповещения
 *   y 100..127 трафик за сегодня, клиенты Wi-Fi, ЦП и температура батареи
 */
#include <stdio.h>
#include <string.h>

#include "oled.h"
#include "oled_text.h"
#include "oled_icons.h"
#include "oled_icons_ext.h"
#include "oled_home.h"

#define C_BG     RGB565(6, 8, 20)
#define C_BAR    RGB565(0, 0, 0)
#define C_CARD   RGB565(18, 22, 40)
#define C_TEXT   RGB565(255, 255, 255)
#define C_DIM    RGB565(150, 155, 165)
#define C_DARK   RGB565(60, 62, 76)
#define C_GREEN  RGB565(60, 210, 110)
#define C_YELLOW RGB565(250, 200, 60)
#define C_ORANGE RGB565(255, 150, 40)
#define C_RED    RGB565(230, 70, 60)
#define C_BLUE   RGB565(70, 140, 255)
#define C_VIOLET RGB565(200, 120, 255)

static const char *const WDAY_RU[7] = {"Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"};
static const char *const WDAY_EN[7] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
static const char *const MON_RU[12] = {"янв", "фев", "мар", "апр", "мая", "июн",
                                       "июл", "авг", "сен", "окт", "ноя", "дек"};
static const char *const MON_EN[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
#define DASH "\xe2\x80\x94"   /* — */

static void put_mono(const struct mono_icon *ic, int x, int y, uint16_t color) {
    for (int yy = 0; yy < ic->h; yy += 1) {
        for (int xx = 0; xx < ic->w; xx += 1) {
            int a = ic->a[yy * ic->w + xx];
            if (a) {
                aa_blend_pixel(x + xx, y + yy, color, a);
            }
        }
    }
}

/* линия с полутоном по краям не нужна: график 1 px */
static void line(int x0, int y0, int x1, int y1, uint16_t c) {
    int dx = x1 > x0 ? x1 - x0 : x0 - x1, sx = x0 < x1 ? 1 : -1;
    int dy = y1 > y0 ? y0 - y1 : y1 - y0, sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    for (;;) {
        aa_blend_pixel(x0, y0, c, 15);
        if (x0 == x1 && y0 == y1) {
            break;
        }
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

int home_signal_pct(int net, int rsrp, int sinr, int rscp, int ecio, int rssi, int bars) {
    /*
     * Проценты сигнала (HOME_UNKNOWN - значения нет).
     * LTE: RSRP от -120 (0 %) до -75 дБм (100 %) и SINR от -5 (0 %) до 25 дБ (100 %);
     * итог = (3*RSRP% + 2*SINR%) / 5, но не больше худшего из двух + 30.
     * 3G: RSCP -115..-75 дБм и Ec/Io -20..-3 дБ так же. 2G: RSSI -110..-60 дБм.
     * Нет измерений - по полоскам oled: 20 % за полоску.
     */
#define CLAMP(v) ((v) < 0 ? 0 : ((v) > 100 ? 100 : (v)))
#define HAVE(v) ((v) != HOME_UNKNOWN)
    int a = -1, b = -1;
    if (net >= 4 && HAVE(rsrp)) {
        a = CLAMP((rsrp + 120) * 100 / 45);
        if (HAVE(sinr)) {
            b = CLAMP((sinr + 5) * 100 / 30);
        }
    } else if (net == 3 && HAVE(rscp)) {
        a = CLAMP((rscp + 115) * 100 / 40);
        if (HAVE(ecio)) {
            b = CLAMP((ecio + 20) * 100 / 17);
        }
    } else if (net >= 2 && HAVE(rssi)) {
        a = CLAMP((rssi + 110) * 100 / 50);
    }
    if (a < 0) {
        return bars >= 0 ? CLAMP(bars * 20) : -1;
    }
    if (b < 0) {
        return a;
    }
    int p = (3 * a + 2 * b) / 5;
    int worst = a < b ? a : b;
    if (p > worst + 30) {
        p = worst + 30;
    }
    return p;
#undef HAVE
#undef CLAMP
}

static uint16_t pct_color(int p) {
    return p >= 60 ? C_GREEN : (p >= 30 ? C_YELLOW : C_RED);
}

/* вышка и 4 полоски: 11 px высотой */
static void put_tower(int x, int y, int pct) {
    uint16_t c = pct < 0 ? C_DARK : pct_color(pct);
    put_mono(&ST_TOWER, x, y, pct < 0 ? C_DIM : C_TEXT);
    int bars = pct >= 75 ? 4 : pct >= 50 ? 3 : pct >= 25 ? 2 : pct > 0 ? 1 : 0;
    for (int i = 0; i < 4; i += 1) {
        int h = 3 + i * 2 + (i == 3);
        aa_fill_rect(x + 9 + i * 3, y + 11 - h, 2, h, i < bars ? c : C_DARK);
    }
}

static void fmt_rate(char *buf, int len, int kbps) {
    if (kbps < 0) {
        snprintf(buf, len, DASH);
    } else if (kbps < 10000) {
        snprintf(buf, len, "%d,%d", kbps / 1000, (kbps % 1000) / 100);
    } else {
        snprintf(buf, len, "%d", (kbps + 500) / 1000);
    }
}

static void fmt_bytes(char *buf, int len, long long b) {
    if (b < 0) {
        snprintf(buf, len, DASH);
    } else if (b < 1000LL * 1024) {
        snprintf(buf, len, "%lld %s", b / 1024, TR("KB", "КБ"));
    } else if (b < 1000LL * 1024 * 1024) {
        snprintf(buf, len, "%lld %s", b / (1024 * 1024), TR("MB", "МБ"));
    } else {
        long long t = (b * 10 + 512LL * 1024 * 1024) / (1024LL * 1024 * 1024);
        snprintf(buf, len, "%lld,%lld %s", t / 10, t % 10, TR("GB", "ГБ"));
    }
}

static void paint_status(const struct home_view *v) {
    char buf[16];
    aa_fill_rect(0, 0, 128, 12, C_BAR);
    int x = 2;
    if (v->sim == HSIM_ABSENT || v->sim == HSIM_INVALID) {
        put_mono(&ST_NOSIM, x, 1, C_RED);
        x += 11;
    } else if (v->sim != HSIM_READY) {
        put_mono(&ST_LOCK, x, 2, C_YELLOW);
        x += 9;
    }
    if (v->sms_full || v->sms_unread > 0) {
        uint16_t c = v->sms_full ? C_RED : C_YELLOW;
        put_mono(&ST_SMS, x, 2, c);
        x += 12;
        if (v->sms_unread > 0) {
            snprintf(buf, sizeof(buf), v->sms_unread > 9 ? "9+" : "%d", v->sms_unread);
            x = aa_put_text(&font_s, x, 0, c, buf) + 3;
        } else {
            x += 1;
        }
    }
    if (v->roaming) {
        put_mono(&ST_ROAM, x, 2, C_ORANGE);
        x += 10;
    }
    if (v->ext_power) {
        /* раздача заряда другому устройству (внешний аккумулятор) */
        put_mono(&ST_PLUG, x, 2, C_YELLOW);
        x += 9;
    }
    if (v->wifi_on) {
        /* значок Wi-Fi голубой, если работает 5 ГГц; число - клиенты */
        put_mono(&ST_WIFI, x, 2, v->wifi_band ? RGB565(90, 200, 255) : C_TEXT);
        x += 12;
        if (v->wifi_users > 0) {
            snprintf(buf, sizeof(buf), "%d", v->wifi_users);
            x = aa_put_text(&font_s, x, 0, C_DIM, buf) + 3;
        }
    }
    if (v->vpn == 1 || v->vpn == 2) {
        /* зеленый - связь есть, серый - туннель поднят, но рукопожатия нет или оно старое;
         * выключен или нет помощника - ничего */
        x = aa_put_text(&font_s, x, 0, v->vpn == 1 ? C_GREEN : C_DIM, "VPN") + 3;
    }

    /* батарея справа: 15x9 и носик 2x4 */
    int bx = 109;
    aa_round_rect(bx, 1, 16, 10, 1, C_TEXT, 0);
    aa_fill_rect(bx + 16, 4, 2, 4, C_TEXT);
    if (v->bat_pct >= 0) {
        int p = v->bat_pct > 100 ? 100 : v->bat_pct;
        uint16_t c = p > 30 ? C_GREEN : (p > 15 ? C_YELLOW : C_RED);
        int w = (p * 12 + 50) / 100;
        if (w < 1 && p > 0) {
            w = 1;
        }
        aa_fill_rect(bx + 2, 3, w, 6, c);
        snprintf(buf, sizeof(buf), "%d%%", p);
    } else {
        snprintf(buf, sizeof(buf), DASH);
    }
    int tw = aa_text_width(&font_s, buf);
    int tx = bx - 2 - tw;
    if (v->bat_charging) {
        put_mono(&ST_BOLT, bx + 6, 2, C_YELLOW);
    }
    if (tx > x) {
        aa_put_text(&font_s, tx, 0, C_TEXT, buf);
    }
}

static void paint_clock(const struct home_view *v) {
    char buf[16];
    if (v->time_ok) {
        snprintf(buf, sizeof(buf), "%d:%02d", v->hh, v->mm);
    } else {
        snprintf(buf, sizeof(buf), "--:--");
    }
    int end = aa_put_text(&font_xl, 3, 9, v->time_ok ? C_TEXT : C_DIM, buf);
    int dx = end + 8 > 82 ? end + 8 : 82;
    if (v->time_ok) {
        snprintf(buf, sizeof(buf), "%s %d", TR(WDAY_EN, WDAY_RU)[v->wday % 7], v->mday);
        aa_put_text(&font_m, dx, 13, C_DIM, buf);
        aa_put_text(&font_m, dx, 25, C_DIM, TR(MON_EN, MON_RU)[v->mon % 12]);
    }
}

static void paint_signal(const struct home_view *v) {
    char buf[16];
    aa_round_rect(2, 37, 124, 28, 4, C_CARD, 1);
    int x;
    if (v->sim != HSIM_READY) {
        put_tower(6, 41, -1);
        const char *t = v->sim == HSIM_ABSENT ? TR("No SIM", "Нет SIM") :
                        v->sim == HSIM_INVALID ? TR("SIM error", "Ошибка SIM") :
                        v->sim == HSIM_PIN ? TR("PIN needed", "Нужен PIN") :
                        v->sim == HSIM_PUK ? TR("PUK needed", "Нужен PUK") : "SIM-lock";
        aa_put_text(&font_mb, 30, 38, v->sim == HSIM_PIN ? C_YELLOW : C_RED, t);
    } else if (v->reg == HREG_NONE || v->reg == HREG_LIMITED) {
        put_tower(6, 41, -1);
        aa_put_text(&font_mb, 30, 38, C_RED, TR("No service", "Нет сети"));
    } else if (v->reg == HREG_SEARCH) {
        put_tower(6, 41, -1);
        aa_put_text(&font_mb, 30, 38, C_YELLOW, TR("Searching\xe2\x80\xa6", "Поиск сети\xe2\x80\xa6"));
    } else {
        put_tower(6, 41, v->sig_pct);
        if (v->sig_pct >= 0) {
            snprintf(buf, sizeof(buf), "%d%%", v->sig_pct);
            x = aa_put_text(&font_mb, 30, 38, pct_color(v->sig_pct), buf);
        } else {
            x = aa_put_text(&font_mb, 30, 38, C_DIM, DASH);
        }
        const char *t = v->net == 5 ? "4G+" : v->net == 4 ? "4G" : v->net == 3 ? "3G" : v->net == 2 ? "2G" : "";
        if (*t) {
            aa_put_text(&font_mb, x + 8, 38, C_TEXT, t);
        }
    }
    aa_put_text_fit(&font_s, 6, 51, 116, v->op[0] ? C_DIM : C_DARK, v->op[0] ? v->op : DASH);
}

static void paint_traffic(const struct home_view *v) {
    char buf[16];
    aa_round_rect(2, 68, 124, 30, 4, C_CARD, 1);
    aa_put_text(&font_mb, 6, 68, C_BLUE, "\xe2\x86\x93");
    fmt_rate(buf, sizeof(buf), v->rx_kbps);
    aa_put_text(&font_mb, 15, 68, C_TEXT, buf);
    aa_put_text(&font_mb, 52, 68, C_VIOLET, "\xe2\x86\x91");
    fmt_rate(buf, sizeof(buf), v->tx_kbps);
    aa_put_text(&font_mb, 61, 68, C_TEXT, buf);
    const char *unit = TR("Mbit/s", "Мбит/с");
    aa_put_text(&font_s, 123 - aa_text_width(&font_s, unit), 70, C_DIM, unit);

    /* график приема: заливка под линией полутоном */
    const int gx = 6, gy = 84, gw = 116, gh = 12;
    int n = v->spark_n > HOME_SPARK ? HOME_SPARK : v->spark_n;
    if (n < 2) {
        aa_fill_rect(gx, gy + gh - 1, gw, 1, C_DARK);
        return;
    }
    int mx = 1;
    for (int i = 0; i < n; i += 1) {
        if (v->spark[HOME_SPARK - n + i] > mx) {
            mx = v->spark[HOME_SPARK - n + i];
        }
    }
    int px = -1, py = 0;
    for (int i = 0; i < n; i += 1) {
        int val = v->spark[HOME_SPARK - n + i];
        int x = gx + (gw - 1) * i / (HOME_SPARK - 1) + (gw - 1) * (HOME_SPARK - n) / (HOME_SPARK - 1);
        int y = gy + gh - 1 - (val * (gh - 1) + mx / 2) / mx;
        if (px >= 0) {
            for (int xx = px; xx <= x; xx += 1) {
                int yy = py + (y - py) * (xx - px) / (x - px ? x - px : 1);
                for (int k = yy + 1; k < gy + gh; k += 1) {
                    aa_blend_pixel(xx, k, C_BLUE, 4);
                }
            }
            line(px, py, x, y, C_BLUE);
        }
        px = x;
        py = y;
    }
}

struct plate_text { const char *en1, *ru1, *en2, *ru2; };

static void paint_plate(const struct home_view *v, int kind) {
    char title[32];
    const uint16_t *icon = PLATE_LOWBAT;
    uint16_t c = C_RED;
    const char *t1 = "", *t2 = "";
    switch (kind) {
    case HPLATE_POWEROFF:
        t1 = TR("Powering off", "Выключается"); t2 = TR("battery is empty", "батарея разряжена"); break;
    case HPLATE_LOWBAT:
        t1 = TR("Low battery", "Мало заряда"); t2 = TR("connect the charger", "подключите зарядку"); break;
    case HPLATE_HOT:
        icon = PLATE_HOT; t1 = TR("Overheated", "Перегрев"); t2 = TR("battery is too hot", "аккумулятор горячий"); break;
    case HPLATE_COLD:
        icon = PLATE_HOT; c = C_BLUE; t1 = TR("Too cold", "Холодно"); t2 = TR("battery is too cold", "аккумулятор остыл"); break;
    case HPLATE_SIM:
        icon = PLATE_NOSIM;
        switch (v->sim) {
        case HSIM_ABSENT: t1 = TR("No SIM", "Нет SIM"); t2 = TR("insert SIM and restart", "вставьте и перезагрузите"); break;
        case HSIM_INVALID: t1 = TR("SIM error", "Ошибка SIM"); t2 = TR("card is not read", "карта не читается"); break;
        case HSIM_PIN: c = C_YELLOW; t1 = TR("PIN needed", "Нужен PIN"); t2 = TR("enter in web interface", "введите в веб-интерфейсе"); break;
        case HSIM_PUK: t1 = TR("PUK needed", "Нужен PUK"); t2 = TR("SIM is blocked", "SIM заблокирована"); break;
        default: t1 = TR("SIM lock", "SIM-lock"); t2 = TR("modem is locked", "модем заблокирован"); break;
        }
        break;
    case HPLATE_ROAM_NODATA:
        icon = PLATE_ROAM; c = C_ORANGE; t1 = TR("Roaming", "Роуминг"); t2 = TR("roaming data is off", "данные в роуминге выкл."); break;
    case HPLATE_SMS_FULL:
        icon = ICON_SMS; t1 = TR("SMS full", "SMS: нет места"); t2 = TR("delete old messages", "удалите старые SMS"); break;
    case HPLATE_SMS_NEW:
        icon = ICON_SMS; c = C_YELLOW;
        snprintf(title, sizeof(title), TR("New SMS: %d", "Новые SMS: %d"), v->sms_unread);
        t1 = title; t2 = TR("menu: SMS & USSD", "меню: SMS и USSD"); break;
    case HPLATE_ROAM:
        icon = PLATE_ROAM; c = C_ORANGE; t1 = TR("Roaming", "Роуминг"); t2 = v->op[0] ? v->op : ""; break;
    }
    aa_round_rect(2, 68, 124, 30, 4, C_CARD, 1);
    aa_round_rect(2, 68, 124, 30, 4, c, 0);
    /* значок слева от заголовка, пояснение - на всю ширину под ними */
    aa_put_icon(6, 69, icon, 16, 16);
    aa_put_text_fit(&font_mb, 26, 68, 97, c, t1);
    aa_put_text_fit(&font_s, 6, 84, 116, C_TEXT, t2);
}

static void paint_bottom(const struct home_view *v) {
    char buf[48], val[24];
    fmt_bytes(val, sizeof(val), v->today_bytes);
    snprintf(buf, sizeof(buf), "%s %s", TR("Today", "Сегодня"), val);
    aa_put_text(&font_s, 4, 100, C_DIM, buf);
    if (v->wifi_on) {
        if (v->wifi_users >= 0) {
            snprintf(buf, sizeof(buf), "Wi-Fi: %d", v->wifi_users);
        } else {
            snprintf(buf, sizeof(buf), "Wi-Fi: " DASH);
        }
    } else {
        snprintf(buf, sizeof(buf), TR("Wi-Fi off", "Wi-Fi выкл."));
    }
    aa_put_text(&font_s, 124 - aa_text_width(&font_s, buf), 100, C_DIM, buf);

    char cpu[16], temp[16];
    if (v->cpu >= 0) {
        snprintf(cpu, sizeof(cpu), "%d%%", v->cpu);
    } else {
        snprintf(cpu, sizeof(cpu), DASH);
    }
    if (v->temp_c != HOME_UNKNOWN) {
        snprintf(temp, sizeof(temp), "%d \xc2\xb0" "C", v->temp_c);
    } else {
        snprintf(temp, sizeof(temp), DASH);
    }
    snprintf(buf, sizeof(buf), "%s %s \xc2\xb7 %s", TR("CPU", "ЦП"), cpu, temp);
    int end = aa_put_text(&font_s, 4, 113, C_DIM, buf);
    /* родная статистика трафика (если oled ее показывает): справа, сколько влезет */
    if (v->flux[0]) {
        int w = aa_text_width(&font_s, v->flux);
        int room = 124 - (end + 6);
        if (room > 20) {
            aa_put_text_fit(&font_s, w <= room ? 124 - w : end + 6, 113, room, C_DIM, v->flux);
        }
    }
}

void home_paint(const struct home_view *v) {
    aa_fill_rect(0, 0, 128, 128, C_BG);
    paint_status(v);
    paint_clock(v);
    paint_signal(v);

    int act[HPLATE_COUNT], n = 0;
    for (int k = 1; k < HPLATE_COUNT; k += 1) {
        if (v->plates[k]) {
            act[n++] = k;
        }
    }
    if (n) {
        paint_plate(v, act[(v->plate_tick / 2) % n]);
    } else {
        paint_traffic(v);
    }
    paint_bottom(v);
}
