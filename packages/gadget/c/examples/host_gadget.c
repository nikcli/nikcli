/*
 * A gadget for a POSIX host, driven from stdin and reporting on stdout.
 *
 * It exists to prove the C client against a real bridge: the test pairs it,
 * invokes its commands, sends it bitmap frames and messages, and reads what it
 * printed. It is also the smallest complete example of using the client.
 *
 *   host_gadget <server> <code> <name> <fingerprint>
 *
 * stdin: `press <key>` reports a button, `send <text>` pushes a message into a
 * session, `confirm` finishes pairing when the bridge asked for a button, `quit`.
 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/sysinfo.h>
#include <time.h>
#include <unistd.h>

#include "nikcli_gadget.h"
#include "ng_json.h"

static volatile int stop_flag = 0;

static void on_signal(int sig) {
    (void)sig;
    stop_flag = 1;
}

/* ------------------------------------------------------------------ commands */

static int cmd_echo(void *user, const char *args, uint64_t deadline, char *out, size_t out_len, int *exit_code) {
    (void)user;
    (void)deadline;
    ng_jtok t[16];
    int n = ng_json_parse(args, strlen(args), t, 16);
    int v = n > 0 ? ng_json_get(args, t, 0, "text") : -1;
    if (v < 0 || ng_json_string(args, &t[v], out, out_len) < 0) {
        snprintf(out, out_len, "echo.say needs {\"text\": string}");
        *exit_code = 2;
        return 1;
    }
    *exit_code = 0;
    return 0;
}

static int cmd_big(void *user, const char *args, uint64_t deadline, char *out, size_t out_len, int *exit_code) {
    (void)user;
    (void)args;
    (void)deadline;
    memset(out, 'x', out_len - 1);
    out[out_len - 1] = '\0';
    *exit_code = 0;
    return 0;
}

static int cmd_wait(void *user, const char *args, uint64_t deadline, char *out, size_t out_len, int *exit_code) {
    (void)user;
    (void)args;
    /* Give up before the bridge does: the deadline is the contract, and answering at it would race the bridge's own timer. */
    struct timespec ts = { 0, 20 * 1000000L };
    for (;;) {
        struct timespec now;
        clock_gettime(CLOCK_REALTIME, &now);
        uint64_t ms = (uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_nsec / 1000000u;
        if (ms + 300 >= deadline || stop_flag) break;
        nanosleep(&ts, NULL);
    }
    snprintf(out, out_len, "stopped at the deadline");
    *exit_code = 124;
    return 1;
}

static int cmd_health(void *user, const char *args, uint64_t deadline, char *out, size_t out_len, int *exit_code) {
    (void)user;
    (void)args;
    (void)deadline;
    struct sysinfo si;
    if (sysinfo(&si) != 0) {
        snprintf(out, out_len, "sysinfo failed");
        *exit_code = 1;
        return 1;
    }
    double scale = 1.0 / (double)(1 << SI_LOAD_SHIFT);
    snprintf(out, out_len,
             "{\"uptimeSec\":%ld,\"load\":[%.2f,%.2f,%.2f],\"memory\":{\"totalBytes\":%llu,\"freeBytes\":%llu},\"time\":%lld}",
             si.uptime, (double)si.loads[0] * scale, (double)si.loads[1] * scale, (double)si.loads[2] * scale,
             (unsigned long long)si.totalram * si.mem_unit, (unsigned long long)si.freeram * si.mem_unit, (long long)time(NULL) * 1000LL);
    *exit_code = 0;
    return 0;
}

static const ng_command COMMANDS[] = {
    { "device.health", "Uptime, load and memory of this host.", "{\"type\":\"object\",\"properties\":{}}", 5000, cmd_health },
    { "echo.say", "Return the given text.", "{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}", 5000, cmd_echo },
    { "test.big", "Fill the output buffer.", "{\"type\":\"object\"}", 5000, cmd_big },
    { "test.wait", "Wait until the deadline.", "{\"type\":\"object\"}", 400, cmd_wait },
};

static const char *const BUTTONS[] = { "ok", "next" };

/* ---------------------------------------------------------------- callbacks */

static void on_bitmap(void *user, int w, int h, const uint8_t *packed, size_t len) {
    (void)user;
    unsigned long ink = 0;
    for (size_t i = 0; i < len; i++) ink += (unsigned long)__builtin_popcount(packed[i]);
    printf("BITMAP %dx%d bytes=%zu ink=%lu\n", w, h, len, ink);
}

static void on_message(void *user, const char *text, const char *session) {
    (void)user;
    printf("MESSAGE %s%s%s\n", text, session ? " session=" : "", session ? session : "");
}

/* Read stdin without blocking; one line at a time. */
static int next_line(char *line, size_t cap) {
    static char pending[512];
    static size_t used = 0;
    fd_set rf;
    struct timeval tv = { 0, 0 };
    FD_ZERO(&rf);
    FD_SET(0, &rf);
    if (used + 1 < sizeof pending && select(1, &rf, NULL, NULL, &tv) > 0) {
        ssize_t r = read(0, pending + used, sizeof pending - 1 - used);
        if (r > 0) used += (size_t)r;
        else if (r == 0) stop_flag = 1; /* stdin closed: the test is done with us */
    }
    char *nl = memchr(pending, '\n', used);
    if (!nl) return 0;
    size_t len = (size_t)(nl - pending);
    if (len >= cap) len = cap - 1;
    memcpy(line, pending, len);
    line[len] = '\0';
    memmove(pending, nl + 1, used - (size_t)(nl + 1 - pending));
    used -= (size_t)(nl + 1 - pending);
    return 1;
}

static int poll_button(void *user, char *key, size_t key_len) {
    ng_config *c = user;
    char line[256];
    while (next_line(line, sizeof line)) {
        if (strncmp(line, "press ", 6) == 0) {
            snprintf(key, key_len, "%s", line + 6);
            return 1;
        }
        if (strncmp(line, "send ", 5) == 0) {
            char session[80] = "";
            int r = ng_send_message(c, line + 5, NULL, session, sizeof session);
            if (r == NG_OK) printf("SESSION %s\n", session);
            else printf("SEND_FAILED %d %s\n", r, c->last_error);
        } else if (strcmp(line, "quit") == 0) {
            stop_flag = 1;
        }
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 5) {
        fprintf(stderr, "usage: host_gadget <server> <code> <name> <fingerprint>\n");
        return 2;
    }
    setvbuf(stdout, NULL, _IOLBF, 0);
    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);

    ng_config c;
    memset(&c, 0, sizeof c);
    c.server = argv[1];
    c.name = argv[3];
    c.fingerprint = argv[4];
    c.os = "linux";
    c.arch = "host";
    c.commands = COMMANDS;
    c.command_count = sizeof COMMANDS / sizeof COMMANDS[0];
    c.buttons = BUTTONS;
    c.button_count = getenv("HOST_GADGET_NO_BUTTON") ? 0 : 2;
    c.bitmap_width = getenv("HOST_GADGET_WIDTH") ? atoi(getenv("HOST_GADGET_WIDTH")) : 64;
    c.bitmap_height = getenv("HOST_GADGET_HEIGHT") ? atoi(getenv("HOST_GADGET_HEIGHT")) : 24;
    c.frame_cap = getenv("HOST_GADGET_FRAME_CAP") ? (size_t)atoi(getenv("HOST_GADGET_FRAME_CAP")) : 0;
    c.out_cap = 512;
    c.user = &c;
    c.on_bitmap = on_bitmap;
    c.on_message = on_message;
    c.poll_button = poll_button;
    ng_posix_defaults(&c);

    bool confirm = false;
    int r = ng_pair(&c, argv[2], &confirm);
    if (r != NG_OK) {
        printf("PAIR_FAILED %d %s\n", r, c.last_error);
        return 1;
    }
    printf("PAIRED %s\n", c.id);
    if (confirm) {
        printf("NEEDS_CONFIRM\n");
        char line[64];
        while (!stop_flag) {
            if (next_line(line, sizeof line) && strcmp(line, "confirm") == 0) break;
            usleep(20000);
        }
        r = ng_confirm(&c);
        if (r != NG_OK) {
            printf("CONFIRM_FAILED %d %s\n", r, c.last_error);
            return 1;
        }
        printf("CONFIRMED\n");
    }
    r = ng_run(&c, &stop_flag);
    printf("END %d %s\n", r, c.last_error);
    return r == NG_OK ? 0 : 1;
}
