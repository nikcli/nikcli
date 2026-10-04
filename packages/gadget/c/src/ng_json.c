#include "ng_json.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

/* ----------------------------------------------------------------- tokenizer */

static ng_jtok *alloc_token(unsigned *next, ng_jtok *tokens, unsigned max) {
    if (*next >= max) return NULL;
    ng_jtok *t = &tokens[(*next)++];
    t->type = NG_J_UNDEFINED;
    t->start = t->end = -1;
    t->size = 0;
    t->parent = -1;
    return t;
}

/*
 * The classic parent-pointer tokenizer. A key token has the value as its one
 * child; an object's size is its number of keys; every other token adds one to
 * its parent. `super` is the token new tokens are children of.
 */
int ng_json_parse(const char *js, size_t len, ng_jtok *tokens, unsigned max_tokens) {
    unsigned pos = 0;
    unsigned next = 0;
    int super = -1;

    for (; pos < len && js[pos] != '\0'; pos++) {
        char c = js[pos];
        ng_jtok *t;
        switch (c) {
        case '{':
        case '[':
            t = alloc_token(&next, tokens, max_tokens);
            if (!t) return -1;
            if (super != -1) tokens[super].size++;
            t->type = c == '{' ? NG_J_OBJECT : NG_J_ARRAY;
            t->start = (int)pos;
            t->parent = super;
            super = (int)(t - tokens);
            break;
        case '}':
        case ']': {
            ng_jtype want = c == '}' ? NG_J_OBJECT : NG_J_ARRAY;
            int i;
            for (i = (int)next - 1; i >= 0; i--) {
                t = &tokens[i];
                if (t->start != -1 && t->end == -1) {
                    if (t->type != want) return -2;
                    t->end = (int)pos + 1;
                    super = t->parent;
                    break;
                }
            }
            if (i == -1) return -2;
            break;
        }
        case '"': {
            unsigned start = pos + 1;
            pos++;
            while (pos < len && js[pos] != '"') {
                if (js[pos] == '\\') {
                    pos++;
                    if (pos >= len) return -2;
                }
                pos++;
            }
            if (pos >= len) return -2;
            t = alloc_token(&next, tokens, max_tokens);
            if (!t) return -1;
            t->type = NG_J_STRING;
            t->start = (int)start;
            t->end = (int)pos;
            t->parent = super;
            if (super != -1) tokens[super].size++;
            break;
        }
        case '\t':
        case '\r':
        case '\n':
        case ' ':
            break;
        case ':':
            super = (int)next - 1;
            break;
        case ',':
            if (super != -1 && tokens[super].type != NG_J_ARRAY && tokens[super].type != NG_J_OBJECT) {
                super = tokens[super].parent;
            }
            break;
        default: {
            unsigned start = pos;
            for (; pos < len; pos++) {
                char d = js[pos];
                if (d == '\t' || d == '\r' || d == '\n' || d == ' ' || d == ',' || d == ']' || d == '}' || d == ':') break;
                if ((unsigned char)d < 32 || (unsigned char)d >= 127) return -2;
            }
            t = alloc_token(&next, tokens, max_tokens);
            if (!t) return -1;
            t->type = NG_J_PRIMITIVE;
            t->start = (int)start;
            t->end = (int)pos;
            t->parent = super;
            if (super != -1) tokens[super].size++;
            pos--;
            break;
        }
        }
    }
    for (int i = (int)next - 1; i >= 0; i--) {
        if (tokens[i].start != -1 && tokens[i].end == -1) return -2;
    }
    return (int)next;
}

int ng_json_span(const ng_jtok *t, int i) {
    int total = 1;
    int children = t[i].size;
    int at = i + 1;
    for (int k = 0; k < children; k++) {
        int inner = ng_json_span(t, at);
        at += inner;
        total += inner;
    }
    return total;
}

static bool key_is(const char *js, const ng_jtok *t, const char *key) {
    size_t n = strlen(key);
    return t->type == NG_J_STRING && (size_t)(t->end - t->start) == n && strncmp(js + t->start, key, n) == 0;
}

int ng_json_get(const char *js, const ng_jtok *t, int object, const char *key) {
    if (object < 0 || t[object].type != NG_J_OBJECT) return -1;
    int at = object + 1;
    for (int k = 0; k < t[object].size; k++) {
        int value = at + 1;
        if (key_is(js, &t[at], key)) return value;
        at += ng_json_span(t, at);
    }
    return -1;
}

static int utf8(unsigned cp, char *out) {
    if (cp < 0x80) { out[0] = (char)cp; return 1; }
    if (cp < 0x800) { out[0] = (char)(0xC0 | (cp >> 6)); out[1] = (char)(0x80 | (cp & 0x3F)); return 2; }
    out[0] = (char)(0xE0 | (cp >> 12));
    out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (char)(0x80 | (cp & 0x3F));
    return 3;
}

int ng_json_string(const char *js, const ng_jtok *t, char *out, size_t out_len) {
    if (t->type != NG_J_STRING && t->type != NG_J_PRIMITIVE) return -1;
    size_t n = 0;
    for (int i = t->start; i < t->end; i++) {
        char c = js[i];
        char tmp[3];
        int w = 1;
        if (c == '\\' && i + 1 < t->end) {
            char e = js[++i];
            switch (e) {
            case 'n': tmp[0] = '\n'; break;
            case 't': tmp[0] = '\t'; break;
            case 'r': tmp[0] = '\r'; break;
            case 'b': tmp[0] = '\b'; break;
            case 'f': tmp[0] = '\f'; break;
            case 'u': {
                if (i + 4 >= t->end) return -1;
                unsigned cp = 0;
                for (int k = 1; k <= 4; k++) {
                    char h = js[i + k];
                    cp <<= 4;
                    if (h >= '0' && h <= '9') cp |= (unsigned)(h - '0');
                    else if (h >= 'a' && h <= 'f') cp |= (unsigned)(h - 'a' + 10);
                    else if (h >= 'A' && h <= 'F') cp |= (unsigned)(h - 'A' + 10);
                    else return -1;
                }
                i += 4;
                w = utf8(cp, tmp);
                break;
            }
            default: tmp[0] = e; break; /* \" \\ \/ */
            }
        } else {
            tmp[0] = c;
        }
        if (n + (size_t)w + 1 > out_len) return -1;
        memcpy(out + n, tmp, (size_t)w);
        n += (size_t)w;
    }
    if (out_len == 0) return -1;
    out[n] = '\0';
    return (int)n;
}

bool ng_json_int(const char *js, const ng_jtok *t, int64_t *out) {
    if (t->type != NG_J_PRIMITIVE) return false;
    int i = t->start;
    bool neg = false;
    if (js[i] == '-') { neg = true; i++; }
    if (i >= t->end) return false;
    int64_t v = 0;
    for (; i < t->end; i++) {
        char c = js[i];
        if (c == '.' || c == 'e' || c == 'E') break; /* ignore a fraction or exponent: the protocol's integers are whole */
        if (c < '0' || c > '9') return false;
        v = v * 10 + (c - '0');
    }
    *out = neg ? -v : v;
    return true;
}

bool ng_json_true(const char *js, const ng_jtok *t) {
    return t->type == NG_J_PRIMITIVE && t->end - t->start == 4 && strncmp(js + t->start, "true", 4) == 0;
}

/* -------------------------------------------------------------------- writer */

void ng_buf_init(ng_buf *b, char *storage, size_t cap) {
    b->data = storage;
    b->cap = cap;
    b->len = 0;
    b->overflow = false;
    if (cap) storage[0] = '\0';
}

void ng_buf_putn(ng_buf *b, const char *s, size_t n) {
    if (b->overflow) return;
    if (b->len + n + 1 > b->cap) {
        b->overflow = true;
        return;
    }
    memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
}

void ng_buf_puts(ng_buf *b, const char *s) { ng_buf_putn(b, s, strlen(s)); }
void ng_buf_putc(ng_buf *b, char c) { ng_buf_putn(b, &c, 1); }

void ng_buf_printf(ng_buf *b, const char *fmt, ...) {
    if (b->overflow) return;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(b->data + b->len, b->cap - b->len, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= b->cap - b->len) {
        b->overflow = true;
        return;
    }
    b->len += (size_t)n;
}

void ng_buf_json_string(ng_buf *b, const char *s) {
    ng_buf_putc(b, '"');
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        switch (c) {
        case '"': ng_buf_puts(b, "\\\""); break;
        case '\\': ng_buf_puts(b, "\\\\"); break;
        case '\n': ng_buf_puts(b, "\\n"); break;
        case '\r': ng_buf_puts(b, "\\r"); break;
        case '\t': ng_buf_puts(b, "\\t"); break;
        default:
            if (c < 0x20) ng_buf_printf(b, "\\u%04x", c);
            else ng_buf_putc(b, (char)c);
        }
    }
    ng_buf_putc(b, '"');
}

/* -------------------------------------------------------------------- base64 */

static int b64(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

int ng_base64_decode(const char *in, size_t n, uint8_t *out, size_t out_len) {
    size_t o = 0;
    uint32_t acc = 0;
    int bits = 0;
    for (size_t i = 0; i < n; i++) {
        char c = in[i];
        if (c == '=') break;
        int v = b64(c);
        if (v < 0) return -1;
        acc = (acc << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (o >= out_len) return -1;
            out[o++] = (uint8_t)((acc >> bits) & 0xFF);
        }
    }
    return (int)o;
}
