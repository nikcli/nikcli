# nikcli Gadget — C client

The gadget protocol in C, for devices where TypeScript does not run: microcontrollers, consoles, anything with a C
compiler and BSD sockets. It pairs with a code, says hello, holds the SSE feed, answers `invoke` frames, posts results,
reports button presses, sends messages and receives bitmap frames. No dependencies beyond libc and sockets, no threads,
one blocking loop. Plain HTTP only: the bridge is on the LAN.

The wire format is [`../linux/src/protocol.ts`](../linux/src/protocol.ts); this client mirrors it.

## What is verified

| Part                                             | Status                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/` — JSON, HTTP/1.1, chunked SSE, the client | Compiled with `-Wall -Wextra -Werror` and AddressSanitizer, UBSan and LeakSanitizer, and run against the real bridge in `packages/gadget-plugin/tests/c-client.test.ts`: pairing with a button, commands, truncation, deadlines, bitmap frames over several reads, a frame bigger than the buffer, messages, presses, revocation, retry. |
| `platform/posix.c`, `examples/host_gadget.c`     | Same test.                                                                                                                                                                                                                                                                                                                               |
| `esp32/`                                         | **Not built.** Written against ESP-IDF's documented APIs with no toolchain to compile it. Build with `idf.py build`; the compiler is right where this file and it disagree.                                                                                                                                                              |
| A Nintendo Switch (libnx) shell                  | **Not written.** The client would link as is (libnx has BSD sockets); only the pad, the screen and the socket initialisation are missing.                                                                                                                                                                                                |

## Use it

```c
#include "nikcli_gadget.h"

static int say(void *user, const char *args, uint64_t deadline, char *out, size_t out_len, int *exit_code) {
    snprintf(out, out_len, "hello");
    *exit_code = 0;
    return 0; /* nonzero marks the command failed */
}

static const ng_command COMMANDS[] = {
    { "demo.say", "Say hello.", "{\"type\":\"object\"}", 5000, say },
};

ng_config c = { 0 };
c.server = "http://192.168.1.10:4097";
c.name = "my-board";
c.fingerprint = "my-board-0123456789";   /* stable per device, 8 to 128 characters */
c.os = "esp-idf"; c.arch = "xtensa";
c.commands = COMMANDS; c.command_count = 1;
ng_posix_defaults(&c);                    /* or set now_ms, sleep_ms, log yourself */

ng_pair(&c, "123456", &needs_confirm);    /* the code `/gadget pair` printed; fills c.id and c.token */
volatile int stop = 0;
ng_run(&c, &stop);                        /* serves the feed until stop; reconnects with backoff */
```

Keep `c.id` and `c.token` in flash and skip `ng_pair` on the next boot. `ng_run` returns `NG_ERR_REVOKED` when the bridge
no longer knows the token: forget it and pair again.

## Callbacks

- `on_bitmap(user, w, h, packed, len)` — a finished 1-bit frame, rows padded to bytes, most significant bit first, 1 = ink.
  Declare `bitmap_width` and `bitmap_height` and the bridge renders for you: the device needs no font and no layout.
- `on_message(user, text, session)` — text the agent sent (`gadget` tool, `send`).
- `poll_button(user, key, len)` — called between reads, at least every 200 ms; return 1 and fill `key` on a press. It is
  posted as `ui.press`. Calling `ng_send_message` from inside it is fine.

A command receives `deadline_ms` on the device's own clock: the bridge sends how long the command has, not a time, so a
device with no RTC works. Return before it.

## Limits

Output is `out_cap` bytes (default 2048) and is marked truncated when it fills; an SSE frame is `frame_cap` bytes
(default 16 KB) and a bigger one is dropped whole with a log line; up to 256 JSON tokens per frame. All three are
configurable, and none of them is allocated until `ng_run`.

## Porting

Everything that touches a socket is in four functions at the top of `src/nikcli_gadget.c` (`net_connect`, `net_send`,
`net_recv`, `net_close`). A device that needs TLS, or a stack that is not BSD sockets, replaces those and nothing else.

## Build and test on a host

```sh
make                      # build/host_gadget, with sanitizers
bun test tests/c-client.test.ts   # from packages/gadget-plugin; compiles the client itself
```
