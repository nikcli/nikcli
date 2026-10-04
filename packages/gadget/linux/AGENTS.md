# Linux SDK — for coding agents

`@nikcli-ai/gadget`, TypeScript on Bun. Source in `src/`, tests in `tests/`, runnable gadgets in `examples/`.

## Layout

- `src/protocol.ts` — the wire contract (routes, frames, limits, `GadgetError`, `parseHello`, `treeProblem`). Shared
  with the bridge plugin; change it there and here together.
- `src/gadget.ts` — the runtime: `Gadget` class, `hello()`, `pair()`, `run()`, `invoke()`, `send()`.
- `src/transport.ts` — HTTP client and the SSE frame reader (`readFrames`), `backoff`.
- `src/state.ts` — pairing file, `fingerprint()`.
- `src/commands/{system,file,health}.ts` — the four built-ins. Each exports a `spec` and a handler.
- `src/display/` — `layout` (tree → lines), `rasterize` (lines → 1-bit), `font.ts`, `terminal` and `framebuffer` drivers.
- `src/button/` — `keyboard`, `gpio` (sysfs), `all`.
- `src/cli.ts` — `nikcli-gadget pair|run|send|health|status|unpair|init`.

## Adding a built-in command

1. Add `src/commands/<name>.ts` exporting a `spec` (`CommandSpec` literal: name, description, JSON Schema args,
   `timeoutMs`) and a `run: CommandHandler`.
2. Register it in the `builtins !== false` block of the `Gadget` constructor.
3. Add a case to `tests/commands.test.ts`. A handler must honour `ctx.signal` and keep output under
   `ctx.maxOutputBytes`; the runtime cuts and marks anything over, but a handler that streams unbounded still pays
   for it in memory first.

## Conventions

- Command names are `namespace.name`, lowercase; `parseHello` refuses anything else at construction time, on purpose.
- Handlers return a string or `{ output, exitCode?, isError?, truncated? }`; they never throw for a user-visible
  failure — a thrown error becomes `isError: true` with its message, which hides the exit code.
- `src/` avoids Bun-only APIs, so a compiled build could target Node, but the package ships TypeScript and needs Bun to run:
  Node refuses to strip types under `node_modules`. `Bun.serve` is fine in tests.

## Testing

`bun test linux/tests` from `packages/gadget` (no hardware). `bunx tsc --noEmit` for types. Hardware drivers (`gpio`,
`framebuffer`) are exercised by the examples on a board, not in CI; keep their logic thin and their I/O in one place
so a fake `sysfs` directory can stand in.
