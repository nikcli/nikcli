/*
 * A small JSON toolkit for gadgets: a tokenizer that allocates nothing, a few
 * accessors, and a bounded writer. Enough for the protocol's frames and bodies
 * (`../../linux/src/protocol.ts`) and nothing more: no floating point, no
 * streaming, no pretty printing.
 */
#ifndef NG_JSON_H
#define NG_JSON_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum { NG_J_UNDEFINED = 0, NG_J_OBJECT, NG_J_ARRAY, NG_J_STRING, NG_J_PRIMITIVE } ng_jtype;

typedef struct {
    ng_jtype type;
    int start; /* offset of the first character (inside the quotes for a string) */
    int end;   /* offset one past the last character */
    int size;  /* children: pairs for an object, elements for an array, 1 for a key */
    int parent; /* index of the enclosing token, -1 at the top; used while parsing */
} ng_jtok;

/* Parse `js[0..len)`. Returns the number of tokens, or a negative value: -1 too few tokens, -2 malformed. */
int ng_json_parse(const char *js, size_t len, ng_jtok *tokens, unsigned max_tokens);

/* The value token of `key` in the object at `object`, or -1. */
int ng_json_get(const char *js, const ng_jtok *tokens, int object, const char *key);

/* Number of tokens in the subtree rooted at `i`, itself included. */
int ng_json_span(const ng_jtok *tokens, int i);

/* Copy a string token into `out` with escapes resolved (\uXXXX becomes UTF-8). Returns the length, or -1 if it does not fit. */
int ng_json_string(const char *js, const ng_jtok *token, char *out, size_t out_len);

/* A primitive as a 64-bit integer. Returns false when it is not one. */
bool ng_json_int(const char *js, const ng_jtok *token, int64_t *out);

/* True for the primitive `true`. */
bool ng_json_true(const char *js, const ng_jtok *token);

/* ------------------------------------------------------------------ writer */

typedef struct {
    char *data;
    size_t cap;
    size_t len;
    bool overflow;
} ng_buf;

void ng_buf_init(ng_buf *b, char *storage, size_t cap);
void ng_buf_puts(ng_buf *b, const char *s);
void ng_buf_putn(ng_buf *b, const char *s, size_t n);
void ng_buf_putc(ng_buf *b, char c);
void ng_buf_printf(ng_buf *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
/* A quoted, escaped JSON string. */
void ng_buf_json_string(ng_buf *b, const char *s);

/* ------------------------------------------------------------------ base64 */

/* Decode standard base64. Returns the byte count, or -1 on malformed input or when `out` is too small. */
int ng_base64_decode(const char *in, size_t in_len, uint8_t *out, size_t out_len);

#endif
