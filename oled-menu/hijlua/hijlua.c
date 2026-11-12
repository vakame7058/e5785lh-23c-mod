/*
 * luarun для секретного меню E5785: Lua 5.1 роутера (/app/lib/liblua.so) и модуль
 * dm из /app/lib/librestcore.so - так же, как их поднимает веб-сервер (web):
 * ATP_MSG_Init + ATP_LUA_Init + ATP_LUA_DoString.
 *
 *   echo 'print(dm ~= nil)' | luarun арг1 арг2
 *
 * Скрипт читается из stdin, аргументы - в глобальной таблице Argv (Argv[1] ...).
 * Код возврата: 0 - скрипт выполнен, 1 - ошибка (текст в stderr).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define HIJLUA_NAME "hijlua"
#define MAX_SCRIPT (512 * 1024)
#define LUA_GLOBALSINDEX (-10002)   /* Lua 5.1 */

typedef struct lua_State lua_State;

extern int ATP_MSG_Init(const char *name);
extern void *ATP_LUA_Init(const char *name, const char *arg, int flags);
extern int ATP_LUA_DoString(void *ctx, const char *script);
extern void lua_createtable(lua_State *L, int narr, int nrec);
extern void lua_pushstring(lua_State *L, const char *s);
extern void lua_rawseti(lua_State *L, int idx, int n);
extern void lua_setfield(lua_State *L, int idx, const char *k);
extern const char *lua_tolstring(lua_State *L, int idx, size_t *len);

int main(int argc, char **argv) {
    char *script = malloc(MAX_SCRIPT + 1);
    if (!script) {
        return 1;
    }
    size_t len = 0;
    ssize_t r;
    while (len < MAX_SCRIPT && (r = read(0, script + len, MAX_SCRIPT - len)) > 0) {
        len += r;
    }
    script[len] = 0;
    if (len == 0) {
        fprintf(stderr, "luarun: empty script on stdin\n");
        return 1;
    }

    int m = ATP_MSG_Init(HIJLUA_NAME);
    if (m != 0) {
        fprintf(stderr, "luarun: ATP_MSG_Init failed: 0x%x\n", m);
    }

    void *ctx = ATP_LUA_Init(HIJLUA_NAME, "", 0);
    if (!ctx) {
        fprintf(stderr, "luarun: ATP_LUA_Init failed\n");
        return 1;
    }
    lua_State *L = *(lua_State **)ctx;

    lua_createtable(L, argc > 1 ? argc - 1 : 0, 0);
    for (int i = 1; i < argc; i += 1) {
        lua_pushstring(L, argv[i]);
        lua_rawseti(L, -2, i);
    }
    lua_setfield(L, LUA_GLOBALSINDEX, "Argv");

    int ret = ATP_LUA_DoString(ctx, script);
    fflush(stdout);
    if (ret != 0) {
        const char *err = lua_tolstring(L, -1, NULL);
        fprintf(stderr, "luarun: error 0x%x: %s\n", ret, err ? err : "?");
        return 1;
    }
    return 0;
}
