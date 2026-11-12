/*
 * Свой главный экран oled: данные и подмена кадра.
 *
 * Когда показывать (решается в потоке oled, в хуке lcd_refresh_screen, по его же данным):
 * общее состояние oled = 1, среди видимых элементов нет меню (0xd4) и окон с priority 6
 * и выше. Окна "мало заряда" и "температура" (0x73, 0x76) рисуются своей плашкой,
 * остальные окна и меню - родным кадром как есть.
 *
 * Данные: значки и строки oled - из его памяти (адреса - W/hij/r7/research/r7_oled.txt);
 * скорость и трафик - /proc/net/dev; ЦП - /proc/stat; температура -
 * /sys/class/power_supply/battery/temp; RSRP/SINR - сокет /var/webhook (device signal);
 * VPN - svc.sh brief раз в 15 с; MCC-MNC - событие 19012.
 * Адреса верны только для oled.orig 23c: при старте сверяется FNV-1a кода 0x3000..0x1b400.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>

#include "oled.h"
#include "oled_text.h"
#include "oled_home.h"

extern struct lcd_screen secret_screen;
extern void (*lcd_refresh_screen_real)(struct lcd_screen *screen);
extern uint32_t (*timer_create_ex)(uint32_t, uint32_t, void (*)(), uint32_t);
extern uint32_t (*timer_delete_ex)(uint32_t);
extern int hij_secret_active(void);
extern void hij_become_root(void);
extern void hij_log(const char *fmt, ...);

/* память oled.orig 23c */
#define O_STATE       0x2fbc4   /* int: 1 - обычная работа */
#define O_LCD         0x2fcf0   /* int: 0 светит, 1 тускло, 2 сон */
#define O_SHOWN       0x34614   /* видимые элементы: узел {элемент*, next*} */
#define O_ELEMS       0x2fd58   /* элементы по 0x50 Б, индекс - id */
#define O_SIG         0x2fbc0   /* int: полоски 0..5, -1 */
#define O_ROAM        0x2fbbc   /* int: 1 роуминг */
#define O_NETTYPE     0x2fbb0   /* int: кадр mode_type, -1 скрыт */
#define O_REG         0x342a8   /* int: 10 нет сети, 11 поиск, 12 ограничено, 13 есть */
#define O_SIM         0x3429c   /* int: последнее UI_SIM_* */
#define O_SMS_UNREAD  0x342a4   /* int */
#define O_SMS_FULL    0x342a0   /* int: 1 память полна */
#define O_WLAN        0x2fbdc   /* int: 0xfa Wi-Fi включен */
#define O_WIFI_USERS  0x345e8   /* u8 */
#define O_BAT_PCT     0x2fc0c   /* int */
#define O_BAT_CHARGE  0x34638   /* int: 1 идет зарядка */
#define E_SIZE        0x50
#define E_ID          0x02      /* u16 */
#define E_PRIO        0x04      /* u16 */
#define E_TEXTID      0x1e      /* u16: номер строки ID_* */
#define E_STR         0x38      /* char*: строка dynamic */
#define EL_SIMTXT     0x71
#define EL_NETTXT     0x72
#define EL_CHARGE     0x73
#define EL_TEMP       0x76
#define EL_ROAMTXT    0x7a
#define EL_PLMN       0xb9
#define EL_IDLEPLMN   0xca
#define EL_FLUX       0xbb
#define EL_MENU       0xd4
#define OLED_TEXT_FNV 0x62776060u

#define HOME_TICK_MS  2000
#define SVC "/online/mod/pkg/awg/svc.sh"
#define WEBHOOK "/var/webhook"
/* рукопожатие старше - "нет связи": REJECT_AFTER_TIME WireGuard (180 с), те же таймеры
 * в amneziawg-go; свой rejectaftertime профиля (AWG 2.0+) svc.sh brief не отдает */
#define VPN_HS_FRESH_S 180

static uintptr_t ob = 0;
static pthread_mutex_t home_mx;
static int home_mode = 0;               /* 1 - на экране свой главный экран */
static uint32_t home_timer = 0;

/* снимок строк и окон oled, делается в потоке oled */
static struct {
    char plmn[64];
    char flux[32];
    int charge_id, temp_id, roam_nodata;
    int wifi_band, ext_power;
} sn = {"", "", -1, -1, 0, 0, 0};

static char mccmnc[8];                  /* из события 19012 */

/* данные, которые собирает таймер: ct - его рабочая копия, cl - для рисования (под замком) */
static struct coll {
    int rx_kbps, tx_kbps;
    int spark[HOME_SPARK], spark_n;
    long long today_bytes;
    int cpu, temp_c;
    int rsrp, sinr, rscp, ecio, rssi;
    int vpn;
} cl, ct;

/* ---------- память oled ---------- */

static int rd_int(uintptr_t off) { return *(volatile int32_t *)(ob + off); }
static uint8_t *elem(int id) { return (uint8_t *)(ob + O_ELEMS + E_SIZE * id); }

static uint32_t fnv(const uint8_t *p, size_t n) {
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < n; i += 1) {
        h = (h ^ p[i]) * 16777619u;
    }
    return h;
}

static void copy_str(char *dst, int len, const char *src) {
    int i = 0;
    if (src) {
        for (; i < len - 1 && src[i]; i += 1) {
            dst[i] = src[i];
        }
    }
    dst[i] = 0;
    /* обрезать пробелы по краям */
    while (i > 0 && dst[i - 1] == ' ') {
        dst[--i] = 0;
    }
    int s = 0;
    while (dst[s] == ' ') {
        s += 1;
    }
    if (s) {
        memmove(dst, dst + s, strlen(dst + s) + 1);
    }
}

/* в потоке oled: показывать ли свой экран; заодно снимок строк */
static int decide_locked(void) {
    if (rd_int(O_STATE) != 1) {
        return 0;
    }
    sn.charge_id = sn.temp_id = -1;
    sn.roam_nodata = 0;
    int flux_shown = 0;
    sn.wifi_band = sn.ext_power = 0;
    void *const *node = *(void *const *volatile *)(ob + O_SHOWN);
    for (int n = 0; node && n < 96; n += 1) {
        const uint8_t *e = node[0];
        if (!e) {
            break;
        }
        int id = *(const volatile uint16_t *)(e + E_ID);
        int prio = *(const volatile uint16_t *)(e + E_PRIO);
        int tid = *(const volatile uint16_t *)(e + E_TEXTID);
        if (id == EL_MENU) {
            return 0;
        }
        if (id == EL_CHARGE) {
            sn.charge_id = tid;
        } else if (id == EL_TEMP) {
            sn.temp_id = tid;
        } else if (prio >= 6) {
            return 0;               /* родное окно: показать как есть */
        } else if (id == EL_ROAMTXT) {
            sn.roam_nodata = 1;
        } else if (id == EL_FLUX) {
            flux_shown = 1;
        } else if (id == 27) {
            sn.wifi_band = 1;           /* wifi_band_5g */
        } else if (id == 61) {
            sn.wifi_band = 2;           /* wifi_band_5g_and_2g */
        } else if (id == 16 || id == 17) {
            sn.ext_power = 1;           /* extcharge_battery_level, extcharge_flight_mode */
        }
        node = (void *const *)node[1];
    }
    const char *p = *(char *const volatile *)(elem(EL_PLMN) + E_STR);
    if (!p || !p[0] || (p[0] == ' ' && !p[1])) {
        p = *(char *const volatile *)(elem(EL_IDLEPLMN) + E_STR);
    }
    copy_str(sn.plmn, sizeof(sn.plmn), p);
    copy_str(sn.flux, sizeof(sn.flux), flux_shown ? *(char *const volatile *)(elem(EL_FLUX) + E_STR) : 0);
    return 1;
}

/* ---------- оператор по таблице ---------- */

struct op_entry { char code[8]; char name[40]; };
static struct op_entry ops[192];
static int ops_n = -1;
static time_t ops_mtime[2];

static const char *op_files[2] = {"/online/mod/conf/operators.txt", "/app/hijacks/conf/operators.txt"};

static void ops_load(void) {
    struct stat st;
    time_t mt[2] = {0, 0};
    for (int i = 0; i < 2; i += 1) {
        const char *f = (i == 1 && getenv("HIJ_OPERATORS")) ? getenv("HIJ_OPERATORS") : op_files[i];
        if (stat(f, &st) == 0) {
            mt[i] = st.st_mtime;
        }
    }
    if (ops_n >= 0 && mt[0] == ops_mtime[0] && mt[1] == ops_mtime[1]) {
        return;
    }
    ops_mtime[0] = mt[0];
    ops_mtime[1] = mt[1];
    ops_n = 0;
    for (int i = 0; i < 2; i += 1) {
        const char *f = (i == 1 && getenv("HIJ_OPERATORS")) ? getenv("HIJ_OPERATORS") : op_files[i];
        FILE *fp = fopen(f, "re");
        if (!fp) {
            continue;
        }
        char line[128];
        while (fgets(line, sizeof(line), fp) && ops_n < (int)(sizeof(ops) / sizeof(ops[0]))) {
            char *s = line;
            while (*s == ' ' || *s == '\t') s += 1;
            if (*s < '0' || *s > '9') continue;
            int k = 0;
            while (s[k] >= '0' && s[k] <= '9' && k < 7) k += 1;
            if (k < 5 || (s[k] != ' ' && s[k] != '\t')) continue;
            struct op_entry *o = &ops[ops_n];
            memcpy(o->code, s, k);
            o->code[k] = 0;
            s += k;
            while (*s == ' ' || *s == '\t') s += 1;
            s[strcspn(s, "\r\n")] = 0;
            copy_str(o->name, sizeof(o->name), s);
            if (o->name[0]) {
                ops_n += 1;
            }
        }
        fclose(fp);
    }
}

const char *home_operator_name(const char *code, const char *net_name, char *buf, int len) {
    ops_load();
    if (code && code[0]) {
        for (int i = 0; i < ops_n; i += 1) {
            if (strcmp(ops[i].code, code) == 0) {
                copy_str(buf, len, ops[i].name);
                return buf;
            }
        }
    }
    copy_str(buf, len, net_name);
    return buf;
}

/* ---------- сбор данных ---------- */

static long long rd_ll(const char *path) {
    char b[32];
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        return HOME_UNKNOWN;
    }
    int n = read(fd, b, sizeof(b) - 1);
    close(fd);
    if (n <= 0) {
        return HOME_UNKNOWN;
    }
    b[n] = 0;
    return atoll(b);
}

static int rd_file(const char *path, char *buf, int len) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        return -1;
    }
    int n = 0, r;
    while (n < len - 1 && (r = read(fd, buf + n, len - 1 - n)) > 0) {
        n += r;
    }
    close(fd);
    buf[n] = 0;
    return n;
}

static char wan_if[16];

static void find_wan(void) {
    char buf[2048];
    wan_if[0] = 0;
    if (rd_file("/proc/net/route", buf, sizeof(buf)) <= 0) {
        return;
    }
    char *save, *l = strtok_r(buf, "\n", &save);
    while ((l = strtok_r(NULL, "\n", &save))) {
        char ifn[16], dst[16];
        if (sscanf(l, "%15s %15s", ifn, dst) == 2 && strcmp(dst, "00000000") == 0) {
            snprintf(wan_if, sizeof(wan_if), "%s", ifn);
            return;
        }
    }
}

static int wan_bytes(unsigned long long *rx, unsigned long long *tx) {
    char buf[4096];
    if (!wan_if[0] || rd_file("/proc/net/dev", buf, sizeof(buf)) <= 0) {
        return -1;
    }
    char *save, *l = strtok_r(buf, "\n", &save);
    while (l) {
        char *c = strchr(l, ':');
        if (c) {
            char *n = l;
            while (*n == ' ') n += 1;
            if ((size_t)(c - n) == strlen(wan_if) && strncmp(n, wan_if, c - n) == 0) {
                unsigned long long v[9];
                if (sscanf(c + 1, "%llu %llu %llu %llu %llu %llu %llu %llu %llu",
                           &v[0], &v[1], &v[2], &v[3], &v[4], &v[5], &v[6], &v[7], &v[8]) == 9) {
                    *rx = v[0];
                    *tx = v[8];
                    return 0;
                }
            }
        }
        l = strtok_r(NULL, "\n", &save);
    }
    return -1;
}

static int cpu_pct(void) {
    static unsigned long long pt = 0, pi = 0;
    char buf[256];
    if (rd_file("/proc/stat", buf, sizeof(buf)) <= 0) {
        return -1;
    }
    unsigned long long u, n, s, i, w, q, sq;
    if (sscanf(buf, "cpu %llu %llu %llu %llu %llu %llu %llu", &u, &n, &s, &i, &w, &q, &sq) != 7) {
        return -1;
    }
    unsigned long long t = u + n + s + i + w + q + sq, idle = i + w;
    int r = -1;
    if (pt && t > pt) {
        r = (int)(100 - (idle - pi) * 100 / (t - pt));
    }
    pt = t;
    pi = idle;
    return r;
}

static int parse_xml_int(const char *buf, const char *tag, int *out) {
    char open_tag[24];
    snprintf(open_tag, sizeof(open_tag), "<%s>", tag);
    const char *p = strstr(buf, open_tag);
    if (!p) {
        return 0;
    }
    p += strlen(open_tag);
    while (*p && (*p == '&' || *p == ';' || *p == 'g' || *p == 'l' || *p == 't' || *p == '=' || *p == ' ')) {
        p += 1;     /* &gt;= и &lt;= */
    }
    if ((*p < '0' || *p > '9') && *p != '-') {
        return 0;
    }
    *out = atoi(p);
    return 1;
}

/* device signal через сокет хука; от root только connect (сокет создан root) */
static void query_signal(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        return;
    }
    struct timeval tv = {0, 500000};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    struct sockaddr_un a;
    memset(&a, 0, sizeof(a));
    a.sun_family = AF_UNIX;
    snprintf(a.sun_path, sizeof(a.sun_path), "%s", getenv("HIJ_WEBHOOK") ? getenv("HIJ_WEBHOOK") : WEBHOOK);
    uid_t eu = geteuid();
    int r = connect(fd, (struct sockaddr *)&a, sizeof(a));
    if (r < 0 && errno == EACCES && eu != 0 && seteuid(0) == 0) {
        r = connect(fd, (struct sockaddr *)&a, sizeof(a));
        if (seteuid(eu) != 0) {
            hij_log("home: seteuid back failed");
        }
    }
    int rsrp = HOME_UNKNOWN, sinr = HOME_UNKNOWN, rscp = HOME_UNKNOWN, ecio = HOME_UNKNOWN, rssi = HOME_UNKNOWN;
    if (r == 0) {
        static const char req[] = "device|signal|1|1\n";
        if (write(fd, req, sizeof(req) - 1) == (ssize_t)(sizeof(req) - 1)) {
            char buf[2048];
            int n = 0, k;
            while (n < (int)sizeof(buf) - 1 && (k = read(fd, buf + n, sizeof(buf) - 1 - n)) > 0) {
                n += k;
            }
            buf[n] = 0;
            parse_xml_int(buf, "rsrp", &rsrp);
            parse_xml_int(buf, "sinr", &sinr);
            parse_xml_int(buf, "rscp", &rscp);
            parse_xml_int(buf, "ecio", &ecio);
            parse_xml_int(buf, "rssi", &rssi);
        }
    }
    close(fd);
    ct.rsrp = rsrp; ct.sinr = sinr; ct.rscp = rscp; ct.ecio = ecio; ct.rssi = rssi;
}

/* svc.sh brief в фоне: pid и канал, читается на следующих тиках */
static pid_t vpn_pid = 0;
static int vpn_fd = -1;
static int vpn_age = 0;
static char vpn_buf[256];
static int vpn_len = 0;

static void vpn_poll(void) {
    if (vpn_pid > 0) {
        int k;
        while (vpn_len < (int)sizeof(vpn_buf) - 1 &&
               (k = read(vpn_fd, vpn_buf + vpn_len, sizeof(vpn_buf) - 1 - vpn_len)) > 0) {
            vpn_len += k;
        }
        int st;
        pid_t p = waitpid(vpn_pid, &st, WNOHANG);
        vpn_age += 1;
        if (p == vpn_pid || p < 0 || vpn_age > 5) {
            if (p == 0) {
                kill(vpn_pid, SIGKILL);
                waitpid(vpn_pid, &st, 0);
            }
            vpn_buf[vpn_len] = 0;
            /*
             * 0 - значка нет (running=0 или нет профиля); 2 - серый: туннель поднят, но
             * рукопожатия не было или оно старше VPN_HS_FRESH_S; 1 - зеленый
             */
            const char *r = strstr(vpn_buf, "running=");
            const char *pr = strstr(vpn_buf, "profile=");
            const char *hs = strstr(vpn_buf, "handshake=");
            int has_profile = pr && pr[8] && pr[8] != '|' && pr[8] != '\n' && pr[8] != '\r';
            int fresh = hs && hs[10] >= '0' && hs[10] <= '9' && atoi(hs + 10) <= VPN_HS_FRESH_S;
            ct.vpn = (r && r[8] == '1' && has_profile) ? (fresh ? 1 : 2) : 0;
            close(vpn_fd);
            vpn_fd = -1;
            vpn_pid = 0;
        }
        return;
    }
}

static void vpn_start(void) {
    const char *svc = getenv("HIJ_VPN_SVC") ? getenv("HIJ_VPN_SVC") : SVC;
    if (access(svc, F_OK) != 0) {
        ct.vpn = -1;
        return;
    }
    int p[2];
    if (vpn_pid > 0 || pipe2(p, O_CLOEXEC) != 0) {
        return;
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(p[0]);
        close(p[1]);
        return;
    }
    if (pid == 0) {
        hij_become_root();
        dup2(p[1], 1);
        int nul = open("/dev/null", O_RDWR);
        if (nul >= 0) {
            dup2(nul, 0);
            dup2(nul, 2);
        }
        const char *bb = access("/system/bin/busyboxx", X_OK) == 0 ? "/system/bin/busyboxx" : "/bin/sh";
        if (strstr(bb, "busyboxx")) {
            execl(bb, "busyboxx", "sh", svc, "brief", (char *)NULL);
        } else {
            execl(bb, "sh", svc, "brief", (char *)NULL);
        }
        _exit(127);
    }
    close(p[1]);
    fcntl(p[0], F_SETFL, O_NONBLOCK);
    vpn_fd = p[0];
    vpn_pid = pid;
    vpn_age = 0;
    vpn_len = 0;
}

/* ---------- вид для рисования ---------- */

static int sms_seen = 0, roam_seen = 0;
static time_t sms_until = 0, roam_until = 0;

static void build_view_locked(struct home_view *v) {
    memset(v, 0, sizeof(*v));
    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    v->time_ok = tm.tm_year + 1900 >= 2024;
    v->hh = tm.tm_hour; v->mm = tm.tm_min; v->wday = tm.tm_wday; v->mday = tm.tm_mday; v->mon = tm.tm_mon;

    int nf = rd_int(O_NETTYPE);
    v->net = nf < 0 || nf > 14 ? 0 : (nf <= 2 ? 2 : (nf == 12 ? 4 : (nf == 14 ? 5 : 3)));
    int reg = rd_int(O_REG);
    v->reg = reg == 10 ? HREG_NONE : reg == 11 ? HREG_SEARCH : reg == 12 ? HREG_LIMITED :
             (reg == 13 || v->net) ? HREG_OK : HREG_SEARCH;
    int bars = rd_int(O_SIG);
    v->sig_pct = home_signal_pct(v->net, cl.rsrp, cl.sinr, cl.rscp, cl.ecio, cl.rssi, bars > 5 ? 5 : bars);
    home_operator_name(mccmnc, sn.plmn, v->op, sizeof(v->op));
    memcpy(v->flux, sn.flux, sizeof(v->flux));
    v->wifi_band = sn.wifi_band;
    v->ext_power = sn.ext_power;
    v->roaming = rd_int(O_ROAM) == 1;
    int sim = rd_int(O_SIM);
    v->sim = sim == 0x12c ? HSIM_ABSENT : sim == 0x12d ? HSIM_INVALID :
             (sim == 0x12e || sim == 0x130) ? HSIM_PIN : (sim == 0x12f || sim == 0x131) ? HSIM_PUK :
             sim == 0x133 ? HSIM_LOCK : HSIM_READY;
    v->sms_unread = rd_int(O_SMS_UNREAD);
    if (v->sms_unread < 0 || v->sms_unread > 999) {
        v->sms_unread = 0;
    }
    v->sms_full = rd_int(O_SMS_FULL) == 1;
    v->wifi_on = rd_int(O_WLAN) == 0xfa;
    v->wifi_users = *(volatile uint8_t *)(ob + O_WIFI_USERS);
    int bp = rd_int(O_BAT_PCT);
    v->bat_pct = bp >= 0 && bp <= 100 ? bp : -1;
    v->bat_charging = rd_int(O_BAT_CHARGE) == 1;
    v->vpn = cl.vpn;
    v->rx_kbps = cl.rx_kbps;
    v->tx_kbps = cl.tx_kbps;
    memcpy(v->spark, cl.spark, sizeof(v->spark));
    v->spark_n = cl.spark_n;
    v->today_bytes = cl.today_bytes;
    v->cpu = cl.cpu;
    v->temp_c = cl.temp_c;

    /* плашки */
    if (sn.charge_id == 61) v->plates[HPLATE_POWEROFF] = 1;
    else if (sn.charge_id >= 0) v->plates[HPLATE_LOWBAT] = 1;
    if (sn.temp_id == 20) v->plates[HPLATE_COLD] = 1;
    else if (sn.temp_id >= 0) v->plates[HPLATE_HOT] = 1;
    if (v->sim != HSIM_READY) v->plates[HPLATE_SIM] = 1;
    if (sn.roam_nodata) v->plates[HPLATE_ROAM_NODATA] = 1;
    if (v->sms_full) v->plates[HPLATE_SMS_FULL] = 1;
    if (v->sms_unread > sms_seen) sms_until = now + 20;
    sms_seen = v->sms_unread;
    if (v->sms_unread > 0 && now < sms_until) v->plates[HPLATE_SMS_NEW] = 1;
    if (v->roaming && !roam_seen) roam_until = now + 15;
    roam_seen = v->roaming;
    if (v->roaming && now < roam_until && !sn.roam_nodata) v->plates[HPLATE_ROAM] = 1;
    v->plate_tick = (int)(now / 2);
}

static void render_locked(void) {
    struct home_view v;
    build_view_locked(&v);
    home_paint(&v);
    lcd_refresh_screen_real(&secret_screen);
}

/* ---------- таймер ---------- */

static unsigned long long last_rx, last_tx;
static struct timespec last_ts;
static int have_last = 0, tick_n = 0, today_yday = -1;

static void home_tick(void) {
    tick_n += 1;
    if (tick_n % 15 == 1) {
        find_wan();
    }
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    unsigned long long rx, tx;
    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    if (wan_bytes(&rx, &tx) == 0) {
        if (have_last) {
            long long ms = (ts.tv_sec - last_ts.tv_sec) * 1000LL + (ts.tv_nsec - last_ts.tv_nsec) / 1000000;
            long long drx = rx >= last_rx ? (long long)(rx - last_rx) : 0;
            long long dtx = tx >= last_tx ? (long long)(tx - last_tx) : 0;
            if (ms > 0) {
                ct.rx_kbps = (int)(drx * 8 / ms);
                ct.tx_kbps = (int)(dtx * 8 / ms);
            }
            if (today_yday != tm.tm_yday) {
                today_yday = tm.tm_yday;
                ct.today_bytes = 0;
            }
            ct.today_bytes += drx + dtx;
        } else {
            /* первый замер: если загрузка была сегодня, счетчики с загрузки - сегодняшние */
            struct timespec up;
            clock_gettime(CLOCK_MONOTONIC, &up);
            long since_midnight = tm.tm_hour * 3600L + tm.tm_min * 60L + tm.tm_sec;
            today_yday = tm.tm_yday;
            ct.today_bytes = (tm.tm_year + 1900 >= 2024 && up.tv_sec < since_midnight) ? (long long)(rx + tx) : 0;
        }
        last_rx = rx;
        last_tx = tx;
        last_ts = ts;
        have_last = 1;
        memmove(ct.spark, ct.spark + 1, sizeof(ct.spark) - sizeof(ct.spark[0]));
        ct.spark[HOME_SPARK - 1] = ct.rx_kbps > 0 ? ct.rx_kbps : 0;
        if (ct.spark_n < HOME_SPARK) {
            ct.spark_n += 1;
        }
    } else {
        ct.rx_kbps = ct.tx_kbps = -1;
        have_last = 0;
    }
    ct.cpu = cpu_pct();
    if (tick_n % 5 == 1) {
        long long t = rd_ll("/sys/class/power_supply/battery/temp");
        ct.temp_c = t == HOME_UNKNOWN ? HOME_UNKNOWN : (int)(t > 1000 ? t / 1000 : t / 10);
    }
    /* сокет и svc.sh - только когда свой экран виден */
    int lcd = rd_int(O_LCD);
    int visible = __atomic_load_n(&home_mode, __ATOMIC_ACQUIRE) && lcd != 2 && !hij_secret_active();
    if (visible && tick_n % 2 == 1) {
        query_signal();
    }
    vpn_poll();
    if (visible && tick_n % 8 == 1) {
        vpn_start();
    }
    pthread_mutex_lock(&home_mx);
    cl = ct;
    if (visible && home_mode && !hij_secret_active()) {
        render_locked();
    }
    pthread_mutex_unlock(&home_mx);
}

/* ---------- вход из oled_hijack.c ---------- */

void home_lock(void) { if (ob) pthread_mutex_lock(&home_mx); }
void home_unlock(void) { if (ob) pthread_mutex_unlock(&home_mx); }

void home_start(uintptr_t base) {
    /* выключатель без перепрошивки: файл /online/mod/conf/oled_home_off (нужен перезапуск oled) */
    if (!base || access("/online/mod/conf/oled_home_off", F_OK) == 0) {
        fprintf(stderr, "home: off by file\n");
        return;
    }
    uint32_t h = fnv((const uint8_t *)(base + 0x3000), 0x1b400 - 0x3000);
    if (h != OLED_TEXT_FNV) {
        hij_log("home: unknown oled build (fnv %08x), off", h);
        fprintf(stderr, "home: unknown oled build, disabled\n");
        return;
    }
    pthread_mutexattr_t at;
    pthread_mutexattr_init(&at);
    pthread_mutexattr_settype(&at, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(&home_mx, &at);
    cl.rx_kbps = cl.tx_kbps = cl.cpu = -1;
    cl.today_bytes = -1;
    cl.temp_c = cl.rsrp = cl.sinr = cl.rscp = cl.ecio = cl.rssi = HOME_UNKNOWN;
    cl.vpn = access(SVC, F_OK) == 0 ? 0 : -1;
    ct = cl;
    ob = base;
    hij_log("home: on");
}

/*
 * Короткое POWER открывает секретное меню: на экране свой главный экран, экран горит
 * (0 - светит, 1 - тускло), oled в обычной работе и меню 0xd4 не показано.
 * Список видимых читается из потока кнопок, как это делает сам oled (0x10c54).
 */
int home_takes_power(void) {
    if (!ob || !__atomic_load_n(&home_mode, __ATOMIC_ACQUIRE)) {
        return 0;
    }
    int lcd = rd_int(O_LCD);
    if ((lcd != 0 && lcd != 1) || rd_int(O_STATE) != 1) {
        return 0;
    }
    void *const *node = *(void *const *volatile *)(ob + O_SHOWN);
    for (int n = 0; node && n < 96; n += 1) {
        const uint8_t *e = node[0];
        if (!e) {
            break;
        }
        int id = *(const volatile uint16_t *)(e + E_ID);
        int prio = *(const volatile uint16_t *)(e + E_PRIO);
        if (id == EL_MENU || (prio >= 6 && id != EL_CHARGE && id != EL_TEMP)) {
            return 0;
        }
        node = (void *const *)node[1];
    }
    return 1;
}

/* для проверки на ПК и журнала: 1 - значок VPN горит */
int home_vpn_state(void) {
    return __atomic_load_n(&cl.vpn, __ATOMIC_RELAXED);
}

int home_active(void) {
    return ob && __atomic_load_n(&home_mode, __ATOMIC_ACQUIRE);
}

void home_notify(int subsystemid, int action, int subaction) {
    (void)subaction;
    if (!ob || subsystemid != 19012 || !action) {
        return;
    }
    const char *p = (const char *)(uintptr_t)action + 0xa;
    char b[8];
    int i = 0;
    for (; i < 7 && p[i] >= '0' && p[i] <= '9'; i += 1) {
        b[i] = p[i];
    }
    b[i] = 0;
    if (i >= 5) {
        pthread_mutex_lock(&home_mx);
        memcpy(mccmnc, b, sizeof(b));
        pthread_mutex_unlock(&home_mx);
        hij_log("home: plmn %s", b);
    }
}

int home_frame(struct lcd_screen *screen) {
    if (!ob || screen == &secret_screen) {
        return 0;
    }
    pthread_mutex_lock(&home_mx);
    int mode = decide_locked();
    if (mode != home_mode) {
        hij_log("home: %s", mode ? "own screen" : "native frame");
        __atomic_store_n(&home_mode, mode, __ATOMIC_RELEASE);
    }
    if (mode) {
        if (!home_timer && timer_create_ex) {
            /* первые данные - через HOME_TICK_MS, до этого прочерки */
            home_timer = timer_create_ex(HOME_TICK_MS, 1, home_tick, 0);
        }
        render_locked();
    }
    pthread_mutex_unlock(&home_mx);
    return mode;
}
