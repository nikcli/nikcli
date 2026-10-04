# C client — for coding agents

`include/nikcli_gadget.h` is the API, `src/nikcli_gadget.c` the client, `src/ng_json.c` the tokenizer, writer and base64.
`platform/posix.c` and `examples/host_gadget.c` are the host build; `esp32/` is the ESP-IDF shell (not built).

- The protocol is `../linux/src/protocol.ts`. A change there needs the same change here, and a case in
  `packages/gadget-plugin/tests/c-client.test.ts`.
- It must stay dependency-free and single-threaded: libc and BSD sockets only. Platform code goes in `platform/` or in the
  shell, never in `src/`.
- Compile with `-Wall -Wextra -Werror` and the sanitizers (`make`). The test compiles it that way and fails on any
  sanitizer report at exit, including leaks. Free what you allocate on every path.
- Memory is bounded by the config (`out_cap`, `frame_cap`, 256 tokens). Do not add an unbounded buffer.
- Say what was not built. `esp32/` has never been compiled; do not describe it as working.
