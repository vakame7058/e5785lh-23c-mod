#ifndef OLED_HOME_H
#define OLED_HOME_H
#include <stdint.h>
#include "oled.h"

/* сим-карта */
enum { HSIM_READY = 0, HSIM_ABSENT, HSIM_INVALID, HSIM_PIN, HSIM_PUK, HSIM_LOCK };
/* регистрация в сети */
enum { HREG_OK = 0, HREG_NONE, HREG_SEARCH, HREG_LIMITED };
/* плашки вместо карточки трафика, по убыванию важности */
enum {
    HPLATE_POWEROFF = 1, HPLATE_LOWBAT, HPLATE_HOT, HPLATE_COLD,
    HPLATE_SIM, HPLATE_ROAM_NODATA, HPLATE_SMS_FULL, HPLATE_SMS_NEW, HPLATE_ROAM,
    HPLATE_COUNT
};

#define HOME_SPARK 40
#define HOME_UNKNOWN (-1000)

/* все, что рисует главный экран; HOME_UNKNOWN или -1 - нет данных (прочерк) */
struct home_view {
    int time_ok;                  /* время синхронизировано (год >= 2024) */
    int hh, mm, wday, mday, mon;  /* mon 0..11, wday 0 - воскресенье */
    int sig_pct;                  /* 0..100 или -1 */
    int net;                      /* 0 нет, 2, 3, 4, 5 - 4G+ */
    int reg;                      /* HREG_* */
    char op[64];                  /* подпись оператора */
    char flux[32];                /* родная строка трафика (статистика, "использовано/лимит") */
    int roaming;
    int sim;                      /* HSIM_* */
    int sms_unread, sms_full;
    int wifi_on, wifi_users;      /* wifi_users -1 - неизвестно */
    int wifi_band;                /* 0 не показан, 1 - 5 ГГц, 2 - 2,4 и 5 ГГц */
    int ext_power;                /* значки внешнего аккумулятора oled (16, 17) */
    int bat_pct, bat_charging;    /* bat_pct -1 - нет данных */
    int vpn;                      /* 1 связь есть, 2 туннель поднят без свежего рукопожатия, 0/-1 нет */
    int rx_kbps, tx_kbps;         /* -1 - нет данных */
    int spark[HOME_SPARK];        /* скорость приема, кбит/с, старые первыми */
    int spark_n;
    long long today_bytes;        /* -1 - нет данных */
    int cpu;                      /* % или -1 */
    int temp_c;                   /* HOME_UNKNOWN - нет */
    int plates[HPLATE_COUNT];     /* какие плашки сейчас нужны (1) */
    int plate_tick;               /* для смены плашек по кругу */
};

void home_paint(const struct home_view *v);
int home_signal_pct(int net, int rsrp, int sinr, int rscp, int ecio, int rssi, int bars);
const char *home_operator_name(const char *mccmnc, const char *net_name, char *buf, int len);

/* oled_hijack.c */
void home_start(uintptr_t oled_base);
void home_notify(int subsystemid, int action, int subaction);
int home_frame(struct lcd_screen *screen);
int home_active(void);
int home_takes_power(void);

#endif
