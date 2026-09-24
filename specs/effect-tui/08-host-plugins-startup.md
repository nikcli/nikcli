# EOT-08: Host, Plugin, and Startup Boundaries

Status: proposed. Tier: 2. Phase: P2. Dependencies: EOT-02, EOT-03.
Owner: CLI host and TUI plugin maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B10, B12, B16: `packages/tui` is already extracted and has a standalone consumer. Host-provided startup config
avoids transport calls before a worker/server is ready. Plugins already have scopes, reload tracking, and cleanup timeouts.
Strengthen these boundaries and measure eager imports rather than propose another extraction or assume timeout is cleanup.

## Scope and Non-Goals

Enforce client-only imports, explicit host capabilities, lazy optional work, and deterministic plugin reload. Preserve
internal/v1/v2 plugins and compiled/standalone behavior. Do not turn standalone into a backend host, enable remote external
plugin loading, change autoload permission defaults, or introduce a second plugin system.

## Design and Requirements

1. Keep `packages/tui/src/host/standalone.ts` dependent on SDK/shared utilities only. Enforce the transitive import boundary,
   not just the absence of a literal `packages/nikcli` string. Inspect aliases, dynamic imports, and shared utility chains;
   allow necessary client helpers, forbid backend runtime/database/server modules.
2. Retain host-supplied pre-render configuration in embedded mode. Standalone reads it from its already-running server;
   distinguish authentication, transport, invalid response, and explicit default config. EOT-10 owns the error contract:
   do not convert every failure into `{}` and report healthy startup.
3. Model host capabilities explicitly through existing host interfaces: config sources/reload, local dependency readiness,
   upgrade, server start, mobile token, restart/exit. Absence disables corresponding UI actions with a reason. Do not create
   functions that pretend to implement an unavailable operation. Standalone legitimately has no local config sources.
4. Measure eager imports and first-use costs. Defer optional heavy feature modules/catalogs until needed or until after the
   usable prompt, preserving Solid owner context and error boundaries. Do not defer critical config/auth validation or
   introduce a waterfall that moves startup delay into the first keystroke.
5. Give each plugin generation a revocable registration scope: keybindings, slots, routes, subscriptions, timers, owned
   async operations, and host mutations. EOT-14 turns this scope into the v2 plugin contract; the host capability
   surface named here is the one it gates against. During unload, revoke access before awaiting plugin cleanup. A late disposer or
   install continuation cannot register into a newer generation.
6. Serialize reload per plugin. Validate the next module/compatibility without activating side effects, quiesce and revoke
   the old generation, dispose it, then activate the new one. If activation fails, show the failure and either restore the
   previous validated generation or leave that plugin explicitly disabled; never run both generations' effects at once.
7. Keep existing disposal success/error/timeout distinctions. Apply a total shutdown budget as well as per-plugin budgets;
   a sequential sum of many 5-second waits must not hang exit indefinitely. Candidate total budget: 5 seconds, with bounded
   cleanup concurrency and explicit reporting of stragglers. Do not claim timed-out third-party code was terminated.
8. Preserve native renderer class identity and `@opentui/solid/runtime-plugin-support` in compiled builds. Keep existing
   Windows renderer-thread workaround and one renderer instance. App teardown must restore terminal state even when
   config, plugin import, renderer creation, or a host exit callback fails partway through startup.

## Compatibility Matrix

| Host                | Startup config                                  | Events               | Plugin/config capability                         |
| ------------------- | ----------------------------------------------- | -------------------- | ------------------------------------------------ |
| CLI/embedded worker | Host read before renderer/transport dependency  | Existing RPC adapter | Existing local config/plugin capability          |
| Attached HTTP CLI   | Existing host contract                          | Global SSE           | Only capabilities actually supplied by host      |
| Standalone TUI      | Validated remote TUI config                     | Global SSE           | Internal plugins; no local config-source watcher |
| Compiled binary     | Same semantic contract; bundled runtime support | Selected host mode   | No duplicate renderer/Solid identities           |

## Failure and Cancellation

Import failure is a visible plugin failure, not a missing-route success. Abort reload/config requests on shutdown and
generation change. A timeout revokes plugin capabilities and records incomplete cleanup; it does not forcibly terminate
arbitrary JS or establish a sandbox. Preserve permission checks for plugin/tool autoload and never treat lifecycle
isolation as security isolation. Secrets from config/import failures remain redacted.

## Acceptance and Verification

- Standalone import/build/smoke proves no transitive backend chain. A deliberately forbidden import in a test fixture makes
  the boundary check fail. Verify HTTP/worker parity and invalid config failure before a usable prompt is claimed.
- Reload 100 times with late registration, throwing disposer, hung disposer, failed import, and incompatible plugin cases;
  exactly one generation is active and owned registrations return to baseline after unload.
- Shutdown with multiple stuck disposers respects the aggregate deadline and reports each incomplete cleanup. Terminal
  modes restore and no new host mutations are accepted after revocation.
- Extend `packages/nikcli/test/tui/plugin-dispose.test.ts`, `packages/nikcli/test/tui/plugin-v2.test.ts`,
  `packages/nikcli/test/tui/entry-coverage.test.ts`, and `packages/tui/script/standalone-smoke.ts`.
- From `packages/tui`: `bun run smoke:standalone`. From `packages/nikcli`:
  `bun test test/tui/plugin-dispose.test.ts test/tui/plugin-v2.test.ts test/tui/entry-coverage.test.ts`,
  `bun run build:single`, `bun run smoke:tui`, and `bun run bench:startup <compiled-binary-path>`.
  Record the actual built binary path; do not mistake source-mode smoke for compiled parity.
- Meet EOT-01 startup/memory gates and target at least 15% median usable-prompt improvement in a measured eager-import
  slice, with first-command latency no worse than 10% above baseline.

## Migration and Rollback

Add transitive boundary/host characterization checks first; clarify capabilities; then move one optional feature off the
critical path and introduce plugin-generation revocation. Reuse existing interfaces and minimize new modules. Roll back
lazy imports or reload activation behind the same host API, not the extracted-package boundary or permission controls.
Keep standalone limitations explicit rather than shipping placeholders to match embedded features.

## Aggregate Shutdown Budget — 2026-09-24

Requirement 7 asked for a total shutdown budget as well as the per-plugin one, and there was none.
`TuiPluginRuntime.dispose()` in `packages/tui/src/plugin/runtime.ts` walks the plugins newest-first and awaits each
scope's `dispose()`, and each scope waits up to `DISPOSE_TIMEOUT_MS` (5 s) on its own cleanups. Sequential, so exit
waited up to five seconds **per** wedged plugin: the "sequential sum of many 5-second waits" the requirement names.

Now one deadline, `SHUTDOWN_BUDGET_MS` (5 s, the candidate value above), is computed once per shutdown and handed to
every scope. A scope waits no longer than its own budget and no later than the shared deadline. The order is
unchanged, and so is the property `test/tui/plugin-dispose.test.ts` already guarded: every cleanup is still
**invoked**, including after the budget is spent, because `runCleanup` calls the callback before it races the timer —
a spent budget skips the wait, never the host's synchronous deregistrations. Crossing the deadline is logged; a
timed-out cleanup is reported per plugin as before and never claimed as terminated.

Not changed: cleanups still run one at a time rather than with bounded concurrency, and the two awaits `dispose()`
makes before the loop (the load task and the reload chain) are still unbounded. Plugin reload and enable/disable keep
the per-plugin budget only, since they dispose one plugin at a time.

`test/tui/plugin-dispose.test.ts` disposes four scopes that each hold a hung cleanup under one 150 ms deadline and
bounds the whole pass below 600 ms, asserting all four host deregistrations ran. Ignoring the deadline in the scope
fails it at 1215 ms. A source assertion pins that the runtime computes the deadline once and passes the same value to
every plugin, since `TuiPluginRuntime.dispose` needs a live host to reach.
