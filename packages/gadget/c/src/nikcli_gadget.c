/*
 * nikcli gadget client: HTTP/1.1 and SSE over BSD sockets.
 *
 * TRANSPORT: everything that touches a socket is in the `net_*` functions
 * below. A device that needs TLS or a different stack replaces those four
 * (connect, send, recv, close); the protocol code above them does not change.
 */
#define _POSIX_C_SOURCE 200809L

#include "nikcli_gadget.h"

#include <errno.h>
#include <netdb.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include "ng_json.h"

#define DEFAULT_OUT_CAP 2048u
#define DEFAULT_FRAME_CAP 16384u
#define MAX_TOKENS 256u
#define SMALL_RESPONSE 2048u
#define FEED_IDLE_MS 45000u /* the bridge pings every 15 s; three missed pings is a dead connection */

/* ------------------------------------------------------------------ helpers */

static void note(ng_config *c, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void note(ng_config *c, const char *fmt, ...) {
    if (!c->log) return;
    char line[200];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);
    c->log(c->user, line);
}

static void fail(ng_config *c, int status, const char *message) {
    c->last_status = status;
    snprintf(c->last_error, sizeof c->last_error, "%s", message ? message : "");
}

static uint64_t now(ng_config *c) { return c->now_ms ? c->now_ms() : 0; }

static void nap(ng_config *c, unsigned ms) {
    if (c->sleep_ms) {
        c->sleep_ms(ms);
        return;
    }
    struct timespec ts = { (time_t)(ms / 1000u), (long)(ms % 1000u) * 1000000L };
    nanosleep(&ts, NULL);
}

/* ---------------------------------------------------------------- transport */

static int net_connect(const char *host, int port, unsigned rcv_timeout_ms) {
    char service[12];
    snprintf(service, sizeof service, "%d", port);
    struct addrinfo hints;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *found = NULL;
    if (getaddrinfo(host, service, &hints, &found) != 0 || !found) return -1;
    int fd = -1;
    for (struct addrinfo *a = found; a; a = a->ai_next) {
        fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (fd < 0) continue;
        struct timeval tv = { (time_t)(rcv_timeout_ms / 1000u), (suseconds_t)((rcv_timeout_ms % 1000u) * 1000u) };
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        if (connect(fd, a->ai_addr, a->ai_addrlen) == 0) break;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(found);
    return fd;
}

static int net_send(int fd, const char *data, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = send(fd, data + sent, len - sent, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;
        sent += (size_t)n;
    }
    return 0;
}

static ssize_t net_recv(int fd, char *buf, size_t len) { return recv(fd, buf, len, 0); }
static void net_close(int fd) { close(fd); }

/* --------------------------------------------------------------------- URL */

typedef struct {
    char host[96];
    int port;
} endpoint;

static bool parse_server(const char *server, endpoint *e) {
    if (!server || strncmp(server, "http://", 7) != 0) return false;
    const char *p = server + 7;
    const char *colon = NULL;
    size_t n = 0;
    while (p[n] && p[n] != '/') {
        if (p[n] == ':') colon = p + n;
        n++;
    }
    size_t host_len = colon ? (size_t)(colon - p) : n;
    if (host_len == 0 || host_len >= sizeof e->host) return false;
    memcpy(e->host, p, host_len);
    e->host[host_len] = '\0';
    e->port = colon ? atoi(colon + 1) : 80;
    return e->port > 0 && e->port < 65536;
}

/* -------------------------------------------------------------- HTTP request */

static bool header_is(const char *line, size_t len, const char *name, const char **value) {
    size_t n = strlen(name);
    if (len <= n || line[n] != ':' || strncasecmp(line, name, n) != 0) return false;
    const char *v = line + n + 1;
    while (v < line + len && (*v == ' ' || *v == '\t')) v++;
    *value = v;
    return true;
}

/* Decode a complete chunked body in place. Returns the decoded length, or -1. */
static int dechunk(char *body, size_t len) {
    size_t in = 0, out = 0;
    while (in < len) {
        size_t size = 0;
        bool digits = false;
        while (in < len && body[in] != '\r' && body[in] != ';') {
            char ch = body[in++];
            int v = (ch >= '0' && ch <= '9') ? ch - '0' : (ch >= 'a' && ch <= 'f') ? ch - 'a' + 10 : (ch >= 'A' && ch <= 'F') ? ch - 'A' + 10 : -1;
            if (v < 0) return -1;
            size = size * 16 + (size_t)v;
            digits = true;
        }
        if (!digits) return -1;
        while (in < len && body[in] != '\n') in++;
        in++;
        if (size == 0) return (int)out;
        if (in + size > len) return -1;
        memmove(body + out, body + in, size);
        out += size;
        in += size + 2; /* the CRLF after the chunk */
    }
    return (int)out;
}

/*
 * One request, one response, connection closed after. `resp` receives the body
 * (NUL-terminated); `*status` the HTTP status. Returns NG_OK when a response
 * was read, whatever its status.
 */
static int http(ng_config *c, const char *method, const char *path, const char *body, char *resp, size_t resp_cap,
                int *status) {
    endpoint e;
    if (!parse_server(c->server, &e)) {
        fail(c, 0, "server must look like http://host:port");
        return NG_ERR_ARGUMENT;
    }
    int fd = net_connect(e.host, e.port, 10000);
    if (fd < 0) {
        fail(c, 0, "could not connect to the bridge");
        return NG_ERR_NET;
    }
    size_t body_len = body ? strlen(body) : 0;
    char head[640];
    int n = snprintf(head, sizeof head,
                     "%s %s HTTP/1.1\r\nHost: %s:%d\r\nAccept: application/json\r\nConnection: close\r\n"
                     "%s%s%s%s",
                     method, path, e.host, e.port, c->token[0] ? "Authorization: Bearer " : "", c->token,
                     c->token[0] ? "\r\n" : "", body ? "Content-Type: application/json\r\n" : "");
    if (n <= 0 || (size_t)n >= sizeof head) {
        net_close(fd);
        return NG_ERR_ARGUMENT;
    }
    n += snprintf(head + n, sizeof head - (size_t)n, "Content-Length: %zu\r\n\r\n", body_len);
    if (net_send(fd, head, (size_t)n) < 0 || (body_len && net_send(fd, body, body_len) < 0)) {
        net_close(fd);
        fail(c, 0, "send failed");
        return NG_ERR_NET;
    }

    size_t used = 0;
    for (;;) {
        if (used + 1 >= resp_cap) break;
        ssize_t r = net_recv(fd, resp + used, resp_cap - 1 - used);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) break;
        used += (size_t)r;
    }
    net_close(fd);
    resp[used] = '\0';

    char *split = strstr(resp, "\r\n\r\n");
    if (used < 12 || strncmp(resp, "HTTP/1.", 7) != 0 || !split) {
        fail(c, 0, "malformed response");
        return NG_ERR_PROTOCOL;
    }
    *status = atoi(resp + 9);
    bool chunked = false;
    for (char *line = strchr(resp, '\n'); line && line < split; line = strchr(line + 1, '\n')) {
        const char *v;
        const char *start = line + 1;
        size_t len = (size_t)(strchr(start, '\r') - start);
        if (start < split && header_is(start, len, "transfer-encoding", &v) && strncasecmp(v, "chunked", 7) == 0) chunked = true;
    }
    char *payload = split + 4;
    size_t payload_len = used - (size_t)(payload - resp);
    if (chunked) {
        int d = dechunk(payload, payload_len);
        if (d < 0) {
            fail(c, *status, "malformed chunked body");
            return NG_ERR_PROTOCOL;
        }
        payload_len = (size_t)d;
    }
    memmove(resp, payload, payload_len);
    resp[payload_len] = '\0';
    return NG_OK;
}

/* Turn an error response into a status code and a message. */
static int http_error(ng_config *c, int status, const char *body) {
    ng_jtok t[16];
    char message[NG_ERROR_MAX] = "";
    char tag[40] = "";
    int n = ng_json_parse(body, strlen(body), t, 16);
    if (n > 0 && t[0].type == NG_J_OBJECT) {
        int error = ng_json_get(body, t, 0, "error");
        if (error > 0 && t[error].type == NG_J_OBJECT) {
            int m = ng_json_get(body, t, error, "message");
            int g = ng_json_get(body, t, error, "tag");
            if (m > 0) ng_json_string(body, &t[m], message, sizeof message);
            if (g > 0) ng_json_string(body, &t[g], tag, sizeof tag);
        }
    }
    if (!message[0]) snprintf(message, sizeof message, "bridge answered %d", status);
    fail(c, status, message);
    if (strcmp(tag, "TokenRevoked") == 0) return NG_ERR_REVOKED;
    if (strcmp(tag, "NotPaired") == 0) return NG_ERR_NOT_PAIRED;
    return NG_ERR_HTTP;
}

/* A request whose answer is read into a small buffer. 2xx is success. */
static int call(ng_config *c, const char *method, const char *path, const char *body, char *out, size_t out_cap) {
    char local[SMALL_RESPONSE];
    char *resp = out ? out : local;
    size_t cap = out ? out_cap : sizeof local;
    int status = 0;
    int r = http(c, method, path, body, resp, cap, &status);
    if (r != NG_OK) return r;
    if (status < 200 || status >= 300) return http_error(c, status, resp);
    return NG_OK;
}

/* ------------------------------------------------------------------ builders */

static void platform_json(ng_buf *b, const ng_config *c) {
    ng_buf_puts(b, "{\"os\":");
    ng_buf_json_string(b, c->os ? c->os : "unknown");
    ng_buf_puts(b, ",\"arch\":");
    ng_buf_json_string(b, c->arch ? c->arch : "unknown");
    ng_buf_puts(b, ",\"machine\":");
    ng_buf_json_string(b, c->fingerprint);
    ng_buf_putc(b, '}');
}

static bool check_config(ng_config *c) {
    if (!c->server || !c->name || !c->fingerprint) {
        fail(c, 0, "server, name and fingerprint are required");
        return false;
    }
    size_t fp = strlen(c->fingerprint);
    if (fp < 8 || fp > 128) {
        fail(c, 0, "fingerprint must be 8 to 128 characters");
        return false;
    }
    return true;
}

static void device_path(const ng_config *c, const char *suffix, char *out, size_t cap) {
    snprintf(out, cap, "/devices/%s%s", c->id, suffix);
}

/*
 * The frame buffer this client has: what the config says, else enough for the
 * panel's bitmap (base64 is 4/3 of the pixels, plus the JSON around it) and at
 * least the default. Declared to the bridge in hello, so it never sends more.
 */
static size_t effective_frame_cap(const ng_config *c) {
    if (c->frame_cap) return c->frame_cap < 512 ? 512 : c->frame_cap;
    size_t cap = DEFAULT_FRAME_CAP;
    if (c->bitmap_width > 0 && c->bitmap_height > 0) {
        size_t bytes = (size_t)((c->bitmap_width + 7) / 8) * (size_t)c->bitmap_height;
        size_t need = (bytes + 2) / 3 * 4 + 1024;
        if (need > cap) cap = need;
    }
    return cap;
}

/* -------------------------------------------------------------------- pairing */

int ng_pair(ng_config *c, const char *code, bool *needs_confirm) {
    if (!check_config(c) || !code) return NG_ERR_ARGUMENT;
    char storage[768];
    ng_buf b;
    ng_buf_init(&b, storage, sizeof storage);
    ng_buf_puts(&b, "{\"code\":");
    ng_buf_json_string(&b, code);
    ng_buf_puts(&b, ",\"name\":");
    ng_buf_json_string(&b, c->name);
    ng_buf_puts(&b, ",\"platform\":");
    platform_json(&b, c);
    ng_buf_puts(&b, ",\"fingerprint\":");
    ng_buf_json_string(&b, c->fingerprint);
    ng_buf_printf(&b, ",\"button\":%s,\"version\":", c->button_count > 0 ? "true" : "false");
    ng_buf_json_string(&b, c->version ? c->version : NG_VERSION);
    ng_buf_putc(&b, '}');
    if (b.overflow) return NG_ERR_ARGUMENT;

    char saved[NG_TOKEN_MAX];
    memcpy(saved, c->token, sizeof saved);
    c->token[0] = '\0'; /* pairing is anonymous */
    char resp[SMALL_RESPONSE];
    int r = call(c, "POST", "/pair", storage, resp, sizeof resp);
    if (r != NG_OK) {
        memcpy(c->token, saved, sizeof saved);
        return r;
    }
    ng_jtok t[16];
    int n = ng_json_parse(resp, strlen(resp), t, 16);
    int id = n > 0 ? ng_json_get(resp, t, 0, "id") : -1;
    int token = n > 0 ? ng_json_get(resp, t, 0, "token") : -1;
    int confirm = n > 0 ? ng_json_get(resp, t, 0, "confirm") : -1;
    if (id < 0 || token < 0 || ng_json_string(resp, &t[id], c->id, sizeof c->id) < 0 ||
        ng_json_string(resp, &t[token], c->token, sizeof c->token) < 0) {
        c->token[0] = '\0';
        fail(c, 200, "pair response is missing id or token");
        return NG_ERR_PROTOCOL;
    }
    if (needs_confirm) *needs_confirm = confirm > 0 && ng_json_true(resp, &t[confirm]);
    return NG_OK;
}

int ng_confirm(ng_config *c) {
    if (!c->token[0]) return NG_ERR_NOT_PAIRED;
    return call(c, "POST", "/pair/confirm", "{}", NULL, 0);
}

int ng_hello(ng_config *c) {
    if (!check_config(c)) return NG_ERR_ARGUMENT;
    if (!c->id[0] || !c->token[0]) return NG_ERR_NOT_PAIRED;
    size_t cap = 1024 + c->command_count * 640;
    char *storage = malloc(cap);
    if (!storage) return NG_ERR_NOMEM;
    ng_buf b;
    ng_buf_init(&b, storage, cap);
    ng_buf_printf(&b, "{\"protocol\":%d,\"name\":", NG_PROTOCOL_VERSION);
    ng_buf_json_string(&b, c->name);
    ng_buf_puts(&b, ",\"version\":");
    ng_buf_json_string(&b, c->version ? c->version : NG_VERSION);
    ng_buf_puts(&b, ",\"platform\":");
    platform_json(&b, c);
    ng_buf_puts(&b, ",\"commands\":[");
    for (size_t i = 0; i < c->command_count; i++) {
        const ng_command *k = &c->commands[i];
        if (i) ng_buf_putc(&b, ',');
        ng_buf_puts(&b, "{\"name\":");
        ng_buf_json_string(&b, k->name);
        ng_buf_puts(&b, ",\"description\":");
        ng_buf_json_string(&b, k->description ? k->description : k->name);
        ng_buf_puts(&b, ",\"args\":");
        ng_buf_puts(&b, k->args_schema ? k->args_schema : "{\"type\":\"object\"}");
        if (k->timeout_ms) ng_buf_printf(&b, ",\"timeoutMs\":%u", k->timeout_ms);
        ng_buf_putc(&b, '}');
    }
    ng_buf_putc(&b, ']');
    if (c->bitmap_width > 0 && c->bitmap_height > 0) {
        ng_buf_printf(&b, ",\"display\":{\"columns\":1,\"rows\":1,\"depth\":1,\"format\":\"bitmap\",\"width\":%d,\"height\":%d", c->bitmap_width,
                      c->bitmap_height);
        if (c->bitmap_scale > 1) ng_buf_printf(&b, ",\"scale\":%d", c->bitmap_scale);
        ng_buf_putc(&b, '}');
    }
    if (c->button_count > 0) {
        ng_buf_puts(&b, ",\"buttons\":[");
        for (size_t i = 0; i < c->button_count; i++) {
            if (i) ng_buf_putc(&b, ',');
            ng_buf_json_string(&b, c->buttons[i]);
        }
        ng_buf_putc(&b, ']');
    }
    ng_buf_printf(&b, ",\"maxFrameBytes\":%zu}", effective_frame_cap(c));
    if (b.overflow) {
        free(storage);
        fail(c, 0, "the declaration does not fit its buffer");
        return NG_ERR_ARGUMENT;
    }
    char path[NG_ID_MAX + 32];
    device_path(c, "/hello", path, sizeof path);
    int r = call(c, "PUT", path, storage, NULL, 0);
    free(storage);
    return r;
}

/* ------------------------------------------------------------------- events */

int ng_press(ng_config *c, const char *key, bool *handled) {
    if (!c->id[0]) return NG_ERR_NOT_PAIRED;
    char body[96];
    ng_buf b;
    ng_buf_init(&b, body, sizeof body);
    ng_buf_puts(&b, "{\"kind\":\"press\",\"key\":");
    ng_buf_json_string(&b, key);
    ng_buf_putc(&b, '}');
    if (b.overflow) return NG_ERR_ARGUMENT;
    char path[NG_ID_MAX + 32];
    device_path(c, "/event", path, sizeof path);
    char resp[SMALL_RESPONSE];
    int r = call(c, "POST", path, body, resp, sizeof resp);
    if (r != NG_OK) return r;
    ng_jtok t[8];
    int n = ng_json_parse(resp, strlen(resp), t, 8);
    int h = n > 0 ? ng_json_get(resp, t, 0, "handled") : -1;
    if (handled) *handled = h > 0 && ng_json_true(resp, &t[h]);
    return NG_OK;
}

int ng_send_message(ng_config *c, const char *text, const char *session, char *session_out, size_t session_out_len) {
    if (!c->id[0]) return NG_ERR_NOT_PAIRED;
    size_t cap = strlen(text) * 6 + 160;
    char *body = malloc(cap);
    if (!body) return NG_ERR_NOMEM;
    ng_buf b;
    ng_buf_init(&b, body, cap);
    ng_buf_puts(&b, "{\"text\":");
    ng_buf_json_string(&b, text);
    if (session) {
        ng_buf_puts(&b, ",\"sessionID\":");
        ng_buf_json_string(&b, session);
    }
    ng_buf_putc(&b, '}');
    char path[NG_ID_MAX + 32];
    device_path(c, "/message", path, sizeof path);
    char resp[SMALL_RESPONSE];
    int r = b.overflow ? NG_ERR_ARGUMENT : call(c, "POST", path, body, resp, sizeof resp);
    free(body);
    if (r != NG_OK) return r;
    ng_jtok t[8];
    int n = ng_json_parse(resp, strlen(resp), t, 8);
    int s = n > 0 ? ng_json_get(resp, t, 0, "sessionID") : -1;
    if (session_out && session_out_len) {
        session_out[0] = '\0';
        if (s > 0) ng_json_string(resp, &t[s], session_out, session_out_len);
    }
    return NG_OK;
}

/* ------------------------------------------------------------------- frames */

static void post_result(ng_config *c, const char *call_id, const char *output, int exit_code, bool is_error, bool truncated) {
    size_t cap = strlen(output) * 6 + 256;
    char *body = malloc(cap);
    if (!body) return;
    ng_buf b;
    ng_buf_init(&b, body, cap);
    ng_buf_puts(&b, "{\"callID\":");
    ng_buf_json_string(&b, call_id);
    ng_buf_puts(&b, ",\"output\":");
    ng_buf_json_string(&b, output);
    ng_buf_printf(&b, ",\"exitCode\":%d,\"isError\":%s,\"truncated\":%s}", exit_code, is_error ? "true" : "false",
                  truncated ? "true" : "false");
    char path[NG_ID_MAX + 32];
    device_path(c, "/result", path, sizeof path);
    if (!b.overflow) {
        int r = call(c, "POST", path, body, NULL, 0);
        if (r != NG_OK) note(c, "result for %s not delivered: %s", call_id, c->last_error);
    }
    free(body);
}

typedef struct {
    ng_config *c;
    ng_jtok *tokens;
    char *out;
} frame_ctx;

static void handle_invoke(frame_ctx *f, const char *js, int n) {
    ng_config *c = f->c;
    char call_id[64] = "";
    char command[80] = "";
    int64_t timeout_ms = 0;
    int v;
    if ((v = ng_json_get(js, f->tokens, 0, "callID")) > 0) ng_json_string(js, &f->tokens[v], call_id, sizeof call_id);
    if ((v = ng_json_get(js, f->tokens, 0, "command")) > 0) ng_json_string(js, &f->tokens[v], command, sizeof command);
    if ((v = ng_json_get(js, f->tokens, 0, "timeoutMs")) > 0) ng_json_int(js, &f->tokens[v], &timeout_ms);
    if (!call_id[0] || !command[0]) {
        note(c, "invoke frame without callID or command ignored");
        return;
    }
    if (timeout_ms <= 0) {
        post_result(c, call_id, "invalid timeout", 1, true, false);
        return;
    }
    /* The args object, as text, for the handler to read with ng_json_*. */
    char *args = NULL;
    int a = ng_json_get(js, f->tokens, 0, "args");
    if (a > 0 && f->tokens[a].type == NG_J_OBJECT) {
        size_t len = (size_t)(f->tokens[a].end - f->tokens[a].start);
        args = malloc(len + 1);
        if (args) {
            memcpy(args, js + f->tokens[a].start, len);
            args[len] = '\0';
        }
    }
    const ng_command *k = NULL;
    for (size_t i = 0; i < c->command_count; i++) {
        if (strcmp(c->commands[i].name, command) == 0) k = &c->commands[i];
    }
    (void)n;
    if (!k || !k->run) {
        char msg[120];
        snprintf(msg, sizeof msg, "unknown command %s", command);
        post_result(c, call_id, msg, 127, true, false);
        free(args);
        return;
    }
    size_t cap = c->out_cap ? c->out_cap : DEFAULT_OUT_CAP;
    f->out[0] = '\0';
    int exit_code = 0;
    /* The bridge sends how long we have, not a time: the device's clock need not agree with the bridge's. */
    uint64_t deadline = now(c) + (uint64_t)timeout_ms;
    int rc = k->run(c->user, args ? args : "{}", deadline, f->out, cap, &exit_code);
    f->out[cap - 1] = '\0';
    bool truncated = strlen(f->out) >= cap - 1;
    post_result(c, call_id, f->out, exit_code, rc != 0, truncated);
    free(args);
}

static void handle_show(frame_ctx *f, const char *js) {
    ng_config *c = f->c;
    int b = ng_json_get(js, f->tokens, 0, "bitmap");
    if (b < 0 || f->tokens[b].type != NG_J_OBJECT) {
        note(c, "a tree frame arrived but this client declared a bitmap display; ignored");
        return;
    }
    int64_t w = 0, h = 0;
    int vw = ng_json_get(js, f->tokens, b, "width");
    int vh = ng_json_get(js, f->tokens, b, "height");
    int vd = ng_json_get(js, f->tokens, b, "data");
    if (vw < 0 || vh < 0 || vd < 0 || !ng_json_int(js, &f->tokens[vw], &w) || !ng_json_int(js, &f->tokens[vh], &h) || w < 1 || h < 1 ||
        w > 2048 || h > 2048) {
        note(c, "bitmap frame refused: bad dimensions");
        return;
    }
    size_t want = (size_t)((w + 7) / 8) * (size_t)h;
    uint8_t *pixels = malloc(want + 4);
    if (!pixels) return;
    int got = ng_base64_decode(js + f->tokens[vd].start, (size_t)(f->tokens[vd].end - f->tokens[vd].start), pixels, want + 4);
    if (got < 0 || (size_t)got != want) {
        note(c, "bitmap frame refused: %d bytes where %zu were expected", got, want);
    } else if (c->on_bitmap) {
        c->on_bitmap(c->user, (int)w, (int)h, pixels, want);
    }
    free(pixels);
}

/* The callID of an invoke frame that could not be parsed, found by text: the bridge writes `"type":"invoke","callID":"..."` first. */
static bool find_invoke_call_id(const char *js, char *out, size_t cap) {
    if (!strstr(js, "\"type\":\"invoke\"")) return false;
    const char *key = strstr(js, "\"callID\":\"");
    if (!key) return false;
    key += 10;
    size_t n = 0;
    while (key[n] && key[n] != '"' && n + 1 < cap) {
        out[n] = key[n];
        n++;
    }
    out[n] = '\0';
    return n > 0 && key[n] == '"';
}

static void handle_frame(ng_config *c, ng_jtok *tokens, char *out, const char *js, size_t len) {
    int n = ng_json_parse(js, len, tokens, MAX_TOKENS);
    if (n < 1 || tokens[0].type != NG_J_OBJECT) {
        note(c, "a frame was ignored: %s", n == -1 ? "too many JSON tokens" : "malformed JSON");
        char call_id[64];
        if (find_invoke_call_id(js, call_id, sizeof call_id)) {
            post_result(c, call_id, n == -1 ? "this device cannot parse a call with that many arguments" : "this device could not parse the call", 1, true, false);
        }
        return;
    }
    int type = ng_json_get(js, tokens, 0, "type");
    char kind[16] = "";
    if (type < 0 || ng_json_string(js, &tokens[type], kind, sizeof kind) < 0) return;
    frame_ctx f = { c, tokens, out };
    if (strcmp(kind, "invoke") == 0) {
        handle_invoke(&f, js, n);
    } else if (strcmp(kind, "show") == 0) {
        handle_show(&f, js);
    } else if (strcmp(kind, "message") == 0) {
        int t = ng_json_get(js, tokens, 0, "text");
        int s = ng_json_get(js, tokens, 0, "sessionID");
        char *text = malloc(len + 1);
        if (text && t > 0 && ng_json_string(js, &tokens[t], text, len + 1) >= 0 && c->on_message) {
            char session[80] = "";
            if (s > 0) ng_json_string(js, &tokens[s], session, sizeof session);
            c->on_message(c->user, text, s > 0 ? session : NULL);
        }
        free(text);
    } else if (strcmp(kind, "bye") == 0) {
        int r = ng_json_get(js, tokens, 0, "reason");
        char reason[80] = "";
        if (r > 0) ng_json_string(js, &tokens[r], reason, sizeof reason);
        note(c, "the bridge said bye: %s", reason);
    }
    /* hello and ping need no answer. */
}

/* ---------------------------------------------------------------------- SSE */

typedef enum { CH_SIZE, CH_EXT, CH_SIZE_LF, CH_DATA, CH_DATA_CR, CH_DATA_LF, CH_DONE } chunk_state;

typedef struct {
    ng_config *c;
    bool chunked;
    chunk_state st;
    size_t remaining;
    char *frame; /* accumulating SSE text */
    size_t frame_len;
    size_t frame_cap;
    bool overflow;
    char dropped_call[64]; /* the invoke that overflowed the buffer, to be answered with an error */
    ng_jtok *tokens;
    char *out;
    uint64_t last_rx;
} feed;

/* Take bytes of the SSE stream; a blank line ends an event. */
static void sse_bytes(feed *s, const char *data, size_t n) {
    for (size_t i = 0; i < n; i++) {
        char ch = data[i];
        if (s->frame_len + 1 >= s->frame_cap) {
            if (!s->overflow) {
                /* The head of the frame is still in the buffer: take the callID from it, so the bridge hears back. */
                s->frame[s->frame_len] = '\0';
                if (!find_invoke_call_id(s->frame, s->dropped_call, sizeof s->dropped_call)) s->dropped_call[0] = '\0';
            }
            s->overflow = true;
            s->frame_len = 0;
        }
        s->frame[s->frame_len++] = ch;
        if (s->frame_len >= 2 && s->frame[s->frame_len - 1] == '\n' && s->frame[s->frame_len - 2] == '\n') {
            s->frame[s->frame_len] = '\0';
            if (s->overflow) {
                note(s->c, "a frame larger than %zu bytes was dropped", s->frame_cap);
                if (s->dropped_call[0]) {
                    post_result(s->c, s->dropped_call, "this call is larger than the device's frame buffer", 1, true, false);
                    s->dropped_call[0] = '\0';
                }
                s->overflow = false;
            } else {
                /* Join the `data:` lines of this event in place. */
                size_t out = 0;
                char *line = s->frame;
                while (*line) {
                    char *end = strchr(line, '\n');
                    size_t len = end ? (size_t)(end - line) : strlen(line);
                    if (len >= 5 && strncmp(line, "data:", 5) == 0) {
                        const char *p = line + 5;
                        size_t plen = len - 5;
                        while (plen && *p == ' ') {
                            p++;
                            plen--;
                        }
                        if (out) s->frame[out++] = '\n';
                        memmove(s->frame + out, p, plen);
                        out += plen;
                    }
                    if (!end) break;
                    line = end + 1;
                }
                s->frame[out] = '\0';
                if (out) handle_frame(s->c, s->tokens, s->out, s->frame, out);
            }
            s->frame_len = 0;
        }
    }
}

static void feed_bytes(feed *s, const char *data, size_t n) {
    if (!s->chunked) {
        sse_bytes(s, data, n);
        return;
    }
    size_t i = 0;
    while (i < n) {
        char ch = data[i];
        switch (s->st) {
        case CH_SIZE:
            if (ch >= '0' && ch <= '9') s->remaining = s->remaining * 16 + (size_t)(ch - '0');
            else if (ch >= 'a' && ch <= 'f') s->remaining = s->remaining * 16 + (size_t)(ch - 'a' + 10);
            else if (ch >= 'A' && ch <= 'F') s->remaining = s->remaining * 16 + (size_t)(ch - 'A' + 10);
            else if (ch == ';') s->st = CH_EXT;
            else if (ch == '\r') s->st = CH_SIZE_LF;
            i++;
            break;
        case CH_EXT:
            if (ch == '\r') s->st = CH_SIZE_LF;
            i++;
            break;
        case CH_SIZE_LF:
            if (ch == '\n') s->st = s->remaining == 0 ? CH_DONE : CH_DATA;
            i++;
            break;
        case CH_DATA: {
            size_t take = n - i < s->remaining ? n - i : s->remaining;
            sse_bytes(s, data + i, take);
            i += take;
            s->remaining -= take;
            if (s->remaining == 0) s->st = CH_DATA_CR;
            break;
        }
        case CH_DATA_CR:
            if (ch == '\r') s->st = CH_DATA_LF;
            i++;
            break;
        case CH_DATA_LF:
            if (ch == '\n') {
                s->st = CH_SIZE;
                s->remaining = 0;
            }
            i++;
            break;
        case CH_DONE:
            return;
        }
    }
}

/* Open the feed and consume the response head. Returns the socket, or a negative ng_status. */
static int open_feed(ng_config *c, feed *s, char *leftover, size_t *leftover_len) {
    endpoint e;
    if (!parse_server(c->server, &e)) return NG_ERR_ARGUMENT;
    int fd = net_connect(e.host, e.port, 200);
    if (fd < 0) {
        fail(c, 0, "could not connect to the bridge");
        return NG_ERR_NET;
    }
    char path[NG_ID_MAX + 32];
    device_path(c, "/commands", path, sizeof path);
    char req[512];
    int n = snprintf(req, sizeof req, "GET %s HTTP/1.1\r\nHost: %s:%d\r\nAccept: text/event-stream\r\nAuthorization: Bearer %s\r\n\r\n", path,
                     e.host, e.port, c->token);
    if (n <= 0 || (size_t)n >= sizeof req || net_send(fd, req, (size_t)n) < 0) {
        net_close(fd);
        fail(c, 0, "send failed");
        return NG_ERR_NET;
    }
    char head[2048];
    size_t used = 0;
    char *split = NULL;
    uint64_t started = now(c);
    while (!split && used + 1 < sizeof head) {
        ssize_t r = net_recv(fd, head + used, sizeof head - 1 - used);
        if (r > 0) {
            used += (size_t)r;
            head[used] = '\0';
            split = strstr(head, "\r\n\r\n");
        } else if (r == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
            break;
        }
        if (now(c) - started > 10000) break;
    }
    if (!split) {
        net_close(fd);
        fail(c, 0, "no response from the feed");
        return NG_ERR_NET;
    }
    int status = atoi(head + 9);
    if (status != 200) {
        /* Read what body arrived with the head and map it like any other error. */
        char *body = split + 4;
        int r = http_error(c, status, body);
        net_close(fd);
        return r;
    }
    s->chunked = false;
    for (char *line = strchr(head, '\n'); line && line < split; line = strchr(line + 1, '\n')) {
        const char *v;
        const char *start = line + 1;
        char *eol = strchr(start, '\r');
        if (!eol) break;
        if (header_is(start, (size_t)(eol - start), "transfer-encoding", &v) && strncasecmp(v, "chunked", 7) == 0) s->chunked = true;
    }
    size_t body_len = used - (size_t)(split + 4 - head);
    memcpy(leftover, split + 4, body_len);
    *leftover_len = body_len;
    return fd;
}

/* One connection's worth of feed. Returns NG_OK when it ended and a reconnect is in order. */
static int serve_feed(ng_config *c, volatile int *stop, ng_jtok *tokens, char *out, char *frame, size_t frame_cap) {
    feed s;
    memset(&s, 0, sizeof s);
    s.c = c;
    s.frame = frame;
    s.frame_cap = frame_cap;
    s.tokens = tokens;
    s.out = out;
    char leftover[2048];
    size_t leftover_len = 0;
    int fd = open_feed(c, &s, leftover, &leftover_len);
    if (fd < 0) return fd;
    s.last_rx = now(c);
    feed_bytes(&s, leftover, leftover_len);

    char buf[512];
    while (!*stop && s.st != CH_DONE) {
        ssize_t r = net_recv(fd, buf, sizeof buf);
        if (r > 0) {
            s.last_rx = now(c);
            feed_bytes(&s, buf, (size_t)r);
        } else if (r == 0) {
            break;
        } else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
            break;
        }
        /* Between reads (every 200 ms at most): buttons, and a connection that has gone quiet. */
        if (c->poll_button) {
            char key[24];
            if (c->poll_button(c->user, key, sizeof key) == 1) {
                bool handled = false;
                int pr = ng_press(c, key, &handled);
                if (pr != NG_OK) note(c, "press %s not delivered: %s", key, c->last_error);
            }
        }
        if (now(c) - s.last_rx > FEED_IDLE_MS) {
            note(c, "the feed went quiet; reconnecting");
            break;
        }
    }
    net_close(fd);
    return NG_OK;
}

int ng_run(ng_config *c, volatile int *stop) {
    if (!check_config(c)) return NG_ERR_ARGUMENT;
    if (!c->id[0] || !c->token[0]) return NG_ERR_NOT_PAIRED;
    size_t out_cap = c->out_cap ? c->out_cap : DEFAULT_OUT_CAP;
    size_t frame_cap = effective_frame_cap(c);
    c->out_cap = out_cap;
    ng_jtok *tokens = malloc(MAX_TOKENS * sizeof *tokens);
    char *out = malloc(out_cap);
    char *frame = malloc(frame_cap);
    if (!tokens || !out || !frame) {
        free(tokens);
        free(out);
        free(frame);
        return NG_ERR_NOMEM;
    }
    int result = NG_OK;
    unsigned attempt = 0;
    while (!*stop) {
        int r = ng_hello(c);
        if (r == NG_OK) {
            attempt = 0;
            note(c, "connected to %s as %s", c->server, c->id);
            r = serve_feed(c, stop, tokens, out, frame, frame_cap);
            if (*stop) break;
        }
        if (r == NG_ERR_REVOKED || r == NG_ERR_NOT_PAIRED) {
            note(c, "%s; pair again", c->last_error);
            result = r;
            break;
        }
        unsigned wait = 1000u << (attempt < 5 ? attempt : 5);
        attempt++;
        if (r != NG_OK) note(c, "%s; retrying in %u ms", c->last_error, wait);
        for (unsigned waited = 0; waited < wait && !*stop; waited += 100) nap(c, 100);
    }
    free(tokens);
    free(out);
    free(frame);
    return result;
}
