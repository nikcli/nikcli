/* Platform defaults for hosts with POSIX time and stdio. ESP-IDF and libnx provide their own. */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <time.h>

#include "nikcli_gadget.h"

static uint64_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
}

static void sleep_ms(unsigned ms) {
    struct timespec ts = { (time_t)(ms / 1000), (long)(ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
}

static void log_line(void *user, const char *line) {
    (void)user;
    fprintf(stderr, "[nikcli-gadget] %s\n", line);
}

void ng_posix_defaults(ng_config *c) {
    if (!c->now_ms) c->now_ms = now_ms;
    if (!c->sleep_ms) c->sleep_ms = sleep_ms;
    if (!c->log) c->log = log_line;
}
