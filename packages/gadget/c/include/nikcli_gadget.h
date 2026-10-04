/*
 * nikcli gadget client in C.
 *
 * The same protocol as `../linux/src/protocol.ts` — pair with a code, say hello,
 * hold the SSE feed, answer `invoke` frames, post results, report presses,
 * send messages, receive bitmap frames — for devices where TypeScript does not
 * run: microcontrollers (ESP-IDF), consoles (libnx), anything with a C
 * compiler and BSD sockets. No dependencies beyond libc and sockets; no
 * threads; one blocking loop.
 *
 * Plain HTTP only. The bridge listens on the LAN, and a device that needs TLS
 * has to supply its own transport (see TRANSPORT in nikcli_gadget.c).
 */
#ifndef NIKCLI_GADGET_H
#define NIKCLI_GADGET_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define NG_VERSION "1.427.0"
#define NG_PROTOCOL_VERSION 1
#define NG_ID_MAX 64
#define NG_TOKEN_MAX 96
#define NG_ERROR_MAX 160

typedef enum {
    NG_OK = 0,
    NG_ERR_NET = -1,       /* could not connect, or the connection failed */
    NG_ERR_HTTP = -2,      /* the bridge answered with an error status; see last_status and last_error */
    NG_ERR_PROTOCOL = -3,  /* the answer was not what the protocol says */
    NG_ERR_NOMEM = -4,
    NG_ERR_REVOKED = -5,   /* the token was revoked: pair again */
    NG_ERR_NOT_PAIRED = -6,
    NG_ERR_ARGUMENT = -7,
} ng_status;

struct ng_config;

/*
 * Run one command. Write the text the agent will read into `out` (at most
 * `out_len` bytes including the terminator) and set `*exit_code`. Return 0 for
 * success, nonzero for a failed command (the bridge marks the result an error).
 * `deadline_ms` is when the bridge gives up, on this device's own clock (`now_ms`
 * plus the time the bridge allowed); a command that can take time should
 * return before it.
 */
typedef int (*ng_run_fn)(void *user, const char *args_json, uint64_t deadline_ms, char *out, size_t out_len,
                         int *exit_code);

typedef struct {
    const char *name;        /* "namespace.name", lowercase */
    const char *description; /* what the agent reads */
    const char *args_schema; /* a JSON Schema object, as text: {"type":"object",...} */
    unsigned timeout_ms;     /* 0 = the bridge's default */
    ng_run_fn run;
} ng_command;

typedef struct ng_config {
    /* Required. */
    const char *server;      /* "http://192.168.1.10:4097" */
    const char *name;
    const char *fingerprint; /* stable per device, 8 to 128 characters; the token is bound to it */
    const char *os;          /* "esp-idf", "horizon", "linux" */
    const char *arch;        /* "xtensa", "aarch64" */

    const char *version;     /* default NG_VERSION */
    const ng_command *commands;
    size_t command_count;
    const char *const *buttons; /* keys the device can press: "ok", "next" */
    size_t button_count;

    /* A bitmap display, in pixels; 0 for none. The bridge renders and sends 1-bit frames. */
    int bitmap_width;
    int bitmap_height;
    int bitmap_scale; /* 1 to 8, 0 = 1 */

    void *user;

    /* Callbacks; all optional. */
    void (*on_bitmap)(void *user, int width, int height, const uint8_t *packed, size_t len); /* rows padded to bytes, MSB first */
    void (*on_message)(void *user, const char *text, const char *session_id);
    int (*poll_button)(void *user, char *key, size_t key_len); /* return 1 and fill `key` on a press */
    void (*log)(void *user, const char *line);

    /* Platform. `now_ms` is any millisecond clock that does not go backwards; it is only compared with itself. */
    uint64_t (*now_ms)(void);
    void (*sleep_ms)(unsigned ms);

    /* Sizes; 0 picks the default. */
    size_t out_cap;   /* a command's output, default 2048 */
    size_t frame_cap; /* the largest SSE frame taken, default 16384; bigger ones are dropped whole */

    /* Filled by pairing, or set from storage. */
    char id[NG_ID_MAX];
    char token[NG_TOKEN_MAX];

    /* Why the last call failed. */
    int last_status;
    char last_error[NG_ERROR_MAX];
} ng_config;

/* Pair with the bridge using the code `nikcli` printed. Fills id and token. `*needs_confirm` is set when the device must press its button and call ng_confirm. */
int ng_pair(ng_config *c, const char *code, bool *needs_confirm);
int ng_confirm(ng_config *c);

/* Send the declaration. Call after every connect; ng_run does it itself. */
int ng_hello(ng_config *c);

/*
 * Hold the feed open and serve it until `*stop` becomes nonzero, reconnecting
 * with bounded backoff when it drops. Returns NG_OK on stop, NG_ERR_REVOKED or
 * NG_ERR_NOT_PAIRED when the bridge no longer knows the token.
 */
int ng_run(ng_config *c, volatile int *stop);

/* Push a message into a session (or start one: `session` NULL). The session id is copied to `session_out`. */
int ng_send_message(ng_config *c, const char *text, const char *session, char *session_out, size_t session_out_len);

/* Report a button press. Returns NG_OK; `*handled` says whether a mod answered it. */
int ng_press(ng_config *c, const char *key, bool *handled);

/* Platform defaults for POSIX hosts (Linux, macOS, and anything with libc and sockets). */
void ng_posix_defaults(ng_config *c);

#endif
