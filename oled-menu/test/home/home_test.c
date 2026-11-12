/* Главный экран на ПК: home_paint по набору сценариев -> <dir>/<имя>.raw */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include "oled.h"
#include "oled_home.h"

uint8_t hij_lang_ru = 1;
extern uint16_t secret_screen_buf[];

static void snap(const char *dir, const char *name) {
    char p[512];
    snprintf(p, sizeof p, "%s/%s.raw", dir, name);
    FILE *f = fopen(p, "wb");
    fwrite(secret_screen_buf, 2, 128 * 128, f);
    fclose(f);
}

static struct home_view base(void) {
    struct home_view v;
    memset(&v, 0, sizeof v);
    v.time_ok = 1; v.hh = 14; v.mm = 32; v.wday = 4; v.mday = 29; v.mon = 9;
    v.net = 5; v.reg = HREG_OK; v.sig_pct = 78;
    strcpy(v.op, "Tele2");
    v.wifi_on = 1; v.wifi_users = 3; v.bat_pct = 87; v.vpn = 1;
    v.rx_kbps = 12400; v.tx_kbps = 1800;
    int sp[] = {1, 3, 2, 5, 9, 12, 8, 11, 12, 10, 6, 4, 7, 12, 14, 9, 6, 8, 10, 13};
    for (int i = 0; i < HOME_SPARK; i += 1) v.spark[i] = sp[i % 20] * 1000;
    v.spark_n = HOME_SPARK;
    v.today_bytes = 1288490188LL;  /* 1,2 ГБ */
    v.cpu = 12; v.temp_c = 37;
    return v;
}

int main(int argc, char **argv) {
    const char *dir = argc > 1 ? argv[1] : ".";
    char opbuf[64];
    struct home_view v;

    /* формула процентов: проверка крайних точек */
    printf("pct LTE -75/25=%d -120/-5=%d -95/13=%d -105/0=%d -80/-3=%d only_rsrp -100=%d 3G -95/-8=%d 2G -85=%d bars3=%d none=%d\n",
           home_signal_pct(4, -75, 25, 0, 0, 0, -1), home_signal_pct(4, -120, -5, 0, 0, 0, -1),
           home_signal_pct(4, -95, 13, 0, 0, 0, -1), home_signal_pct(4, -105, 0, 0, 0, 0, -1),
           home_signal_pct(4, -80, -3, 0, 0, 0, -1), home_signal_pct(4, -100, HOME_UNKNOWN, 0, 0, 0, -1),
           home_signal_pct(3, HOME_UNKNOWN, HOME_UNKNOWN, -95, -8, 0, -1), home_signal_pct(2, HOME_UNKNOWN, HOME_UNKNOWN, HOME_UNKNOWN, HOME_UNKNOWN, -85, -1),
           home_signal_pct(4, HOME_UNKNOWN, HOME_UNKNOWN, HOME_UNKNOWN, HOME_UNKNOWN, HOME_UNKNOWN, 3),
           home_signal_pct(4, HOME_UNKNOWN, HOME_UNKNOWN, HOME_UNKNOWN, HOME_UNKNOWN, HOME_UNKNOWN, -1));

    /* операторы: по MCC-MNC из таблицы, иначе имя сети */
    struct { const char *mcc, *net, *file; } ops[] = {
        {"25020", "Tele2", "01_t2"}, {"25002", "MegaFon", "02_megafon"}, {"25099", "Beeline", "03_beeline"},
        {"25001", "MTS RUS", "04_mts"}, {"25011", "YOTA", "05_yota"}, {"40101", "Beeline KZ", "06_beeline_kz"},
        {"40177", "Tele2 KZ", "07_tele2_kz"}, {"25702", "MTS BY", "08_mts_by"},
        {"99999", "Very Long Operator Name Mobile Telecom", "09_unknown_long"}, {"", "", "10_no_name"},
    };
    int pcts[] = {92, 64, 41, 18, 78, 55, 33, 8, 70, -1};
    int nets[] = {5, 4, 4, 3, 4, 5, 4, 2, 4, 4};
    for (unsigned i = 0; i < sizeof(ops) / sizeof(ops[0]); i += 1) {
        v = base();
        home_operator_name(ops[i].mcc, ops[i].net, opbuf, sizeof opbuf);
        strcpy(v.op, opbuf);
        v.sig_pct = pcts[i];
        v.net = nets[i];
        printf("%s: %s %s -> %s\n", ops[i].file, ops[i].mcc, ops[i].net, opbuf);
        home_paint(&v);
        snap(dir, ops[i].file);
    }

    v = base(); v.sms_unread = 2; v.plates[HPLATE_SMS_NEW] = 1; home_paint(&v); snap(dir, "20_sms_new");
    v = base(); v.bat_pct = 7; v.plates[HPLATE_LOWBAT] = 1; home_paint(&v); snap(dir, "21_low_battery");
    v = base(); v.roaming = 1; strcpy(v.op, "Kcell"); v.plates[HPLATE_ROAM] = 1; home_paint(&v); snap(dir, "22_roaming");
    v = base(); v.sim = HSIM_ABSENT; v.op[0] = 0; v.sig_pct = -1; v.net = 0; v.rx_kbps = v.tx_kbps = 0; v.spark_n = 0;
    v.plates[HPLATE_SIM] = 1; home_paint(&v); snap(dir, "23_no_sim");
    v = base(); v.sim = HSIM_PIN; v.op[0] = 0; v.plates[HPLATE_SIM] = 1; home_paint(&v); snap(dir, "24_pin");
    v = base(); v.roaming = 1; v.plates[HPLATE_ROAM_NODATA] = 1; home_paint(&v); snap(dir, "25_roam_nodata");
    v = base(); v.sms_full = 1; v.sms_unread = 12; v.plates[HPLATE_SMS_FULL] = 1; home_paint(&v); snap(dir, "26_sms_full");
    v = base(); v.temp_c = 61; v.plates[HPLATE_HOT] = 1; home_paint(&v); snap(dir, "27_hot");
    v = base(); v.reg = HREG_SEARCH; home_paint(&v); snap(dir, "28_searching");
    v = base(); v.reg = HREG_NONE; v.op[0] = 0; home_paint(&v); snap(dir, "29_no_service");
    v = base(); v.time_ok = 0; v.cpu = -1; v.temp_c = HOME_UNKNOWN; v.today_bytes = -1; v.rx_kbps = v.tx_kbps = -1;
    v.spark_n = 0; v.bat_pct = -1; v.wifi_users = -1; v.vpn = -1; home_paint(&v); snap(dir, "30_no_data");
    v = base(); v.bat_charging = 1; v.bat_pct = 45; v.vpn = 0; v.wifi_on = 0; v.hh = 9; v.mm = 5; strcpy(v.flux, "1.25GB/10GB"); home_paint(&v); snap(dir, "31_charging_wifi_off");
    v = base(); v.wifi_band = 2; v.ext_power = 1; v.sms_unread = 1; home_paint(&v); snap(dir, "34_band_extpower");
    v = base(); v.sms_unread = 3; v.roaming = 1; v.plates[HPLATE_SMS_NEW] = 1; v.plates[HPLATE_ROAM] = 1;
    v.plate_tick = 0; home_paint(&v); snap(dir, "32_two_plates_a");
    v.plate_tick = 2; home_paint(&v); snap(dir, "33_two_plates_b");
    v = base(); v.vpn = 1; home_paint(&v); snap(dir, "35_vpn_green");
    v = base(); v.vpn = 2; home_paint(&v); snap(dir, "36_vpn_gray");
    v = base(); v.vpn = 0; home_paint(&v); snap(dir, "37_vpn_off");
    hij_lang_ru = 0;
    v = base(); v.sms_unread = 1; v.plates[HPLATE_SMS_NEW] = 1; home_paint(&v); snap(dir, "40_en");
    return 0;
}
