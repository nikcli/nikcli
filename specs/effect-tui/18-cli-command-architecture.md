# EOT-18: CLI Command Architecture and Dispatch

Status: partially landed — the parser and lifecycle requirements shipped; the policy requirements have not.
Tier: 2. Phase: P3. Dependencies: EOT-02, EOT-08.
Owner: `packages/nikcli/src/cli/framework/*`, `packages/nikcli/src/cli/handlers/*` and
`packages/nikcli/src/cli/effect/*` maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B34, B35 in the [register](../README.md). This spec was written against a yargs command surface that no
longer exists. [`specs/cli-framework.md`](../cli-framework.md) records the migration that replaced it, and that
document — not this one — is the reference for how the parser works today.

What shipped, and what this spec can therefore stop asking for:

- The parser is `effect/unstable/cli`. `yargs` is not a dependency of any package. The surviving `yargs` mentions in
  `src/cli/` are comments explaining why a shape is what it is.
- The command tree is data: `src/cli/commands.ts` declares **147 commands (46 top level, the rest nested) and 254
  parameters** through `src/cli/framework/spec.ts`, and `src/cli/framework/runtime.ts` binds them. Handler bodies live
  under `src/cli/handlers/**`, each behind a `() => import()`, so `--help` no longer evaluates the TUI.
- The command lifecycle is declared rather than hand-rolled: `src/cli/cmd/cmd.ts` exports `cmd()` with optional
  `bootstrap`/`teardown`, and the teardown runs in a `finally` that reports its own failure without masking the
  handler's. That is requirement 1 below, shipped.
- `src/cli/cmd/argv.ts` is the yargs-shaped type shim (`CommandModule`, `ArgumentsCamelCase`) the handler bodies are
  written against; `src/cli/framework/args.ts` reconstructs the `--` passthrough that effect drops.
- The registered set stays gated: [`specs/v2/cli-command-surface.md`](../v2/cli-command-surface.md) is the inventory and
  `test/cli/command-surface.test.ts` fails if a command is added or removed without updating it.

What remains open is dispatch-adjacent **policy**, which the parser migration did not address and which is still decided
per command: there is no exit-code mapping (no `NIKCLI_HEADLESS`, no documented `64`/`66`/`69` contract in `src/`), no
plugin command scoping, and no shared daemon/attach lifecycle. `cli/effect/prompt.ts` wraps `@clack/prompts` in Effect
but its non-TTY fallback is implicit. Those are the requirements below that are still proposed.

## Scope and Non-Goals

Define the canonical CLI command **policy**: exit-code mapping, headless posture, plugin command registration, and
daemon/attach coordination, on top of the dispatch lifecycle that has already landed. Preserve the shipped
`effect/unstable/cli` binding and the existing command surface. Do not invent a second parser, reintroduce yargs, change
the on-disk layout, or break existing command flags.

## Design and Requirements

1. **(landed)** A command is a typed module: `{ command, describe, builder, handler, bootstrap?, teardown? }`.
   `bootstrap?` runs before `handler` and may install global state (e.g. the plugin installer). `teardown?` runs in a
   `finally` and releases resources. Implemented in `src/cli/cmd/cmd.ts`.
2. **(landed)** The dispatcher is one module: `src/cli/framework/runtime.ts` resolves the command from the
   `src/cli/commands.ts` spec tree, runs `bootstrap`, runs the handler, then runs `teardown`. It surfaces failures
   through the existing `FormatError` and `Log` sinks.
3. Bootstrap is the standard pre-handler step: install globals, set up logging, initialize the plugin installer, open the
   database connection, and prepare the runtime layer. Bootstrap failures are fatal: the command does not run. Bootstrap
   is idempotent within a process so subcommands can re-bootstrap safely (e.g. debug/wait).
4. The runtime layer is built once per command invocation, not per service. Service composition is shared with the TUI
   where possible; commands that need only a subset of services get the minimum required layer. Layer memoization keeps
   build cost down.
5. Plugin commands are registered through the plugin runtime (EOT-14). The CLI dispatcher exposes the registered
   commands under their plugin scope (`<plugin-id>:<command>`); conflicts with built-in commands resolve through the
   plugin's `priority` field, never by silent registration order.
6. Daemon/attach coordination is a typed lifecycle:
   - `nikcli serve` and `nikcli workspace-serve` start a long-running server with the HTTP/mDNS/mobile transports.
   - `nikcli run` and `nikcli session` connect to an existing server, fall back to spawning one if none is reachable.
   - `nikcli attach` is a typed attach to an existing browser daemon.
     The dispatcher exposes these as typed operations; the on-disk state (PID files, sockets) is owned by the
     `InstanceState` module, not by individual commands.
7. Network and configuration flags are resolved once per command, before the handler runs. The `withNetworkOptions`
   helper is the canonical resolver; commands that need different network semantics declare their own opt-in resolver.
8. Output formatting is a typed boundary: commands return either a typed Effect result or a JSON-serializable value.
   `UI.spinner`, `UI.text`, and `UI.log` are the canonical writers; raw `console.log` is forbidden in handlers. The
   `clack/prompts` integration goes through `cli/effect/prompt.ts`; prompts in non-TTY environments fall back to
   non-interactive defaults that fail closed.
9. Errors flow through `FormatError` and `Log`, with redacted sinks. Stack traces honor `NIKCLI_DEBUG`. Exit codes
   follow the documented mapping: `0` success, `1` generic failure, `2` invalid usage, `64` config error, `66` no input,
   `69` service unavailable, `130` interrupted (matches SIGINT convention). The mapping is typed and consistent across
   commands.
10. Long-running commands (`serve`, `run --watch`, `mobile connect`) coordinate shutdown via `Effect.scoped` plus a
    shutdown signal handler. The handler catches `SIGINT`/`SIGTERM`, signals the scope to close, and runs finalizers
    with a deadline. Commands that ignore the shutdown signal are defects.
11. **(landed)** Nested commands follow the same shape as top-level ones: `Spec.make` carries a `commands` field and
    the runtime recurses through it. There is no special-cased path for subcommands.
12. Headless mode: a `NIKCLI_HEADLESS=1` flag disables interactive prompts. The handler that needs a prompt falls back
    to its documented non-interactive default; the runtime fails closed for prompts that have no default. Headless mode
    never silently picks "yes".

## Command Topology

```text
effect/unstable/cli parse
  -> Command resolver
  -> bootstrap (install globals, log, db, runtime layer)
  -> handler (typed Effect)
       -> Effect.gen over services
       -> teardown (release resources, close db, signal daemon)
  -> exit code (typed mapping)
```

## Failure and Cancellation

Use `Schema.TaggedError`: `CommandError.UnknownCommand`, `CommandError.BootstrapFailed`, `CommandError.InvalidArgs`,
`CommandError.PermissionDenied`, `CommandError.HeadlessFailure`, `CommandError.ShutdownTimeout`. Cancellation through
SIGINT/SIGTERM closes the command scope; partial work is reported with the documented exit code. Bootstrap failures
prevent `handler` from running; the command exits with a typed failure and a redacted log. A headless failure exits with
a non-zero code and a typed message; it never silently continues.

## Acceptance and Verification

- Bootstrap/teardown are exercised on at least one example from each top-level group (`run`, `serve`, `auth`, `plugin`,
  `mobile`, `debug`). The whole surface already dispatches through the shipped architecture; the parity harness in
  `test/cli/` holds it there.
- Daemon lifecycle: `serve` starts, `mobile connect` attaches, shutdown via SIGINT exits cleanly within the deadline,
  PID/socket state is cleaned up, and a second `serve` reuses or restarts as documented.
- Plugin commands appear under `<plugin-id>:<command>`; conflicts resolve by documented priority, not by registration
  order; an unloaded plugin's command is no longer dispatched.
- Headless mode: a prompt with no default fails closed; the documented exit code is set; the error is typed and
  redacted.
- Exit codes follow the documented mapping; stack traces honor `NIKCLI_DEBUG`; `FormatError` covers all reported
  failures.
- Extend `packages/nikcli/test/cli/`, `packages/nikcli/test/cli/cmd/`, `packages/nikcli/test/plugin/`, and the existing
  command tests.
- From `packages/nikcli`: `bun test test/cli/`. One final root `bun run typecheck` after the slice.
- Meet EOT-01 budgets; command dispatch overhead below 50 ms p95 on the warm fixture; bootstrap shared with the TUI
  avoids duplicate work.

## Migration and Rollback

The parser migration is done; see [`specs/cli-framework.md`](../cli-framework.md) for how it was staged and for the
four parser divergences it documents. What remains is policy, and it lands per concern rather than per command: the
exit-code mapping first (it is observable and cheap to test), then headless posture, then plugin command scoping, then
daemon/attach. Each is additive and independently revertible — a command that has not adopted the new policy keeps its
current behaviour. Bootstrap changes stay additive; never delete a previously-installed global or DB connection as part
of a dispatch refactor.

## Lifecycle, After the Framework Migration — 2026-09-20

This spec's requirement 1 was pinned to `cli/cmd/cmd.ts`'s `Lifecycle<T>` wrapper, and the
plan asked to _"verify the teardown across all 147 commands"_. Both descriptions were
written before the CLI framework migration and stopped being true when it landed.

`cmd()` had **two importing files and zero registered commands**. `StatsCommand`,
`AuthCommand`, `AuthListCommand`, `AuthLoginCommand` and `AuthLogoutCommand` in
`src/session/` each had no reference outside their own file: `auth` and `stats` are live
commands, declared with `Spec.make` in `cli/commands.ts`, and the definitions in
`src/session/` were duplicates the migration left behind. Verified before removing them —
`nikcli auth --help` and `nikcli stats --help` both still answer.

So the guarantee the requirement describes does not live there and never did after the
migration. **It lives in `cli/bootstrap.ts`**, whose `finally` disposes the instance on
every exit path, and it is covered by `test/cli/bootstrap-exit.test.ts` — including the two
cases that matter: a teardown that fails does not replace the body's error, and an
interruption is never surfaced as the failure.

The wrapper and the five dead command definitions are removed. A dead abstraction whose
docblock claims to guarantee something across every command is worse than no abstraction:
it reads as the guarantee, and the plan cited it as evidence that the requirement was met.

### Exit codes

Audited while here, since the gate asks for consistency. Forty sites exit `1`, three exit
`0`, and five call `process.exit()` with no argument. The bare calls were the suspicious
ones — `process.exit()` exits `0`, so a failure path using it reports success to every
script that checks `$?`. None does: the fatal handler in `cli/main-effect.ts` sets
`process.exitCode = 1` before calling it, and the only other bare exit is the `SIGHUP`
handler, where `0` is right. No change needed, and now recorded so the next audit does not
start from the same suspicion.

## Headless Posture, First Slice — 2026-09-21

Requirement 12 has one consumer, not a policy. `src/cli/headless.ts` (`0a9444cbcf`) defines `isHeadless`:
`NIKCLI_HEADLESS=1` (or `true`) always wins, `NIKCLI_TERMINAL=1` — the managed-PTY signal mobile uses — forces
interactive, and otherwise a non-TTY stdin is headless. `resolvePermissionPrompt` builds on it and fails closed: with
no TTY and no `--auto` it prints why and answers `reject`, never "yes".

Its only call site is the permission prompt in `src/cli/handlers/run.ts`. Nothing else reads `isHeadless`: the
`@clack/prompts` wrapper in `src/cli/effect/prompt.ts` does not consult it, so every other interactive prompt in the
CLI keeps its pre-existing non-TTY behaviour, and there is no typed `CommandError.HeadlessFailure` or documented
exit code for a prompt that had no default. `isReplExit` / `isReplHelp` in the same file are tested but have no
consumer, because the REPL they are for does not exist.

What remains of requirement 12 is therefore the wrapper, not the rule: route `cli/effect/prompt.ts` through
`isHeadless`, give a prompt with no default a typed failure, and map that failure onto requirement 9's exit codes —
which are themselves still unimplemented (every failure exits `1`).
