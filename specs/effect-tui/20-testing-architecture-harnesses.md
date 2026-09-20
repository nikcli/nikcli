# EOT-20: Testing Architecture and Harnesses

Status: proposed. Tier: 1. Phase: P1. Dependencies: EOT-01, EOT-02.
Owner: test infrastructure, TUI/E2E, Effect, server, and SDK maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B38, B39, B40 in the [register](../README.md): the repository ships 418 test files under `packages/nikcli/test/`,
plus TUI PTY harnesses (`packages/nikcli/test/tui/`), Effect unit tests (`packages/nikcli/test/effect/`), server HTTP tests
(`packages/nikcli/test/server/`), and isolated-database helpers (`packages/nikcli/test/helpers/sqlite.ts`,
`packages/nikcli/test/helpers/tool-context.ts`). `script/test-ci.ts` shards the suite across short-lived bun processes
with `--isolate`, and `packages/nikcli/package.json` already exposes `test:unit`, `test:integration`, and `test:e2e`.
Those three scripts split by path and filename pattern (`test:integration` is `test/workspace test/worktree
test/session test/database`; `test:e2e` is `test/tui`; `test:unit` is everything that is not a benchmark or an
`*integration*` file), not by the resource-access definition below — so a unit-labelled test may still touch the
database today. The opportunity is a single architectural spec covering the **test architecture**: harness layers,
fixture strategy, isolated database usage, PTY/OpenTUI driver, Effect unit patterns, integration boundaries, and the
seam between tests and CI. Today the patterns exist but live in scattered helpers and READMEs; a unified spec makes
them enforceable and discoverable.

## Scope and Non-Goals

Define the canonical testing architecture: harness layers, fixture strategy, isolated database usage, TUI/OpenTUI
driver, Effect unit patterns, integration boundaries, and CI workflow. Preserve the existing helpers and the
`bun run test:ci` sharded harness. Do not add the full nikcli suite back to CI, replace `bun test`, or weaken existing
assertions to satisfy the new patterns.

## Design and Requirements

1. Tests are organized in three layers: **unit** (pure, no I/O), **integration** (server, Effect services, isolated
   database), **e2e** (TUI, PTY, browser, full process). The existing `test:unit`/`test:integration`/`test:e2e` scripts
   are the entry points; this spec redefines their membership by resource access rather than by path, and moves tests
   that do not match their layer. Each layer has its own harness and its own CI workflow.
   Unit tests are fast and run on every change; integration tests run on demand and on PR; e2e tests run on PR and on
   release-sized integration.
2. Unit tests use `bun test` and Effect test helpers from `packages/nikcli/test/helpers/`. Pure reducers, schemas, and
   validation logic live in this layer. A unit test must not touch the network, the database, the filesystem (beyond
   `tmp`), the bus, or the renderer. A test that needs those resources moves to integration.
3. Integration tests use `bun test` with the existing isolated-database helper (`withIsolatedDatabase`) and the
   tool-context helper (`makeToolContext` + `withProjectDirectory`). Server tests use `Server.fetch` with a real Bun
   listener; SDK tests use the generated Promise client with `throwOnError`. A test that uses `Bun.spawn` for an
   external process must capture and reap the child.
4. TUI tests use the OpenTUI test renderer (`testRender` from `@opentui/core/testing`) for component-level behavior
   and a real PTY harness for end-to-end keyboard/focus/streaming. `packages/nikcli/script/tui-startup.ts` is the
   canonical startup probe; `packages/tui/script/standalone-smoke.ts` is the canonical standalone host check. The PTY
   harness drives real key events (escape, paste, ctrl+c, kitty sequences) and asserts terminal output, not source
   structure.
5. Effect unit tests use `testEffect` (`packages/llm/test/lib/effect.ts`) or the equivalent local helper. Tests
   construct layers with explicit dependencies; service mocking is typed through `Layer.succeed`, never through `as
any`. A test that reaches for `as any` is a code smell flagged in review.
6. Schema tests assert both producer and consumer sides: a real server response is decoded by the generated client; a
   hand-crafted `null`/`undefined`/missing-key variant is decoded against the same schema. The matrix covers the
   documented `Schema.optional`/`optionalKey` behavior for the current pin.
7. Plugin tests follow EOT-14's v2 contract and use the same isolated harness. A plugin test loads the plugin module,
   asserts the manifest, exercises one capability, and asserts cleanup. The harness never runs both v1 and v2 paths
   simultaneously.
8. CI workflow:
   - Documentation-only PRs run the formatting check (`bunx prettier --check` over the changed files, per the root
     `prettier` config) plus a spec link/reference check. There is no repo-wide `check` script; do not invent one.
   - Implementation PRs run `bun run typecheck` (once at the end), the affected package's `bun test`, the affected
     server tests, and the affected TUI tests. `bun run test:ci` is run locally for full-suite confirmation; CI does
     not run the full nikcli suite.
   - Release-sized integration runs `bun run test:ci` plus the compiled build/smoke checks. The Railway/Docker guards
     stay wired into the validation step.
   - Never weaken existing assertions to pass; never quarantine tests except by an explicit, separately-scoped
     decision with a planned re-enable.
9. Fixtures are deterministic and content-addressed. A fixture is a typed value (e.g. `MessageV2.WithParts`); the
   loader returns the typed value, not a raw JSON string. Tests that need randomness use a seeded PRNG; tests that need
   timestamps use a frozen clock. A test that "happens to pass" because of the current time is a defect.
10. Coverage: maintain 70%+ line coverage on changed code paths; add coverage for newly-introduced domain code. Coverage
    is informational; it is not a gate. A test that exists only to bump coverage is removed in review.
11. Herdr-related tests (where applicable) live in `packages/nikcli/test/plugin/herdr/`; they use the existing isolated
    harness. The `herdr` bridge is integration-level; unit tests of the bridge protocol live alongside the bridge code.
12. Test isolation: each test gets a unique working directory and a unique database file under `tmp/`. Cleanup is
    best-effort, but the harness records the leftover paths on failure so the user can inspect them. `bun test
--isolate` enforces per-file isolation.

## Test Topology

```text
Unit (bun test, no I/O)
  - Pure reducers, schemas, validation, Effect compositions
Integration (bun test, withIsolatedDatabase / Server.fetch / SDK)
  - HTTP routes, server Effect services, tool execution, repository tests
E2E (TUI PTY + browser harness)
  - OpenTUI test renderer, real key events, terminal output
  - Compiled binary smoke (packages/tui smoke, packages/nikcli smoke)
CI (script/test-ci.ts sharded)
  - bun run typecheck (one final pass per slice)
  - bun test (affected packages only in CI; bun run test:ci locally)
  - generated HttpApi clients / check:routes
  - Railway/Docker guards
```

## Failure and Cancellation

Tests must clean up: open file handles, child processes, listeners, timers, fibers. A leaked resource is a test
harness defect, not a test pass. Tests that race must use controlled barriers (Promise + signal), never `sleep` calls.
A test that flakes under load gets a barrier, not a longer sleep. Tests report their own pass/fail; CI never infers a
pass from a missing failure. Skipped/pending tests are reviewed in the same PR; a test that has been pending for more
than one release is either removed or made runnable.

## Acceptance and Verification

- Unit tests cover every domain schema and reducer; integration tests cover every HTTP route group (one assertion per
  endpoint at minimum); e2e tests cover every major TUI flow (chat, dialog, settings, plugin).
- A leaked resource after a test run produces a non-zero check; the harness records the leftover path on failure.
- A flake under load is replaced with a barrier; no test relies on a fixed `sleep` to win a race.
- Generated HttpApi clients are exercised by integration tests, not just typecheck; one round-trip per endpoint group.
- TUI e2e tests assert terminal output via the PTY harness, not via source-text inspection.
- `bun run typecheck` runs once at the end of a slice; CI does not run the full nikcli suite.
- Extend `packages/nikcli/test/helpers/`, `packages/nikcli/test/tui/`, `packages/nikcli/test/server/`, and any
  package's existing test directory; add harnesses only when the existing ones cannot express the required scenario.
- From `packages/nikcli`: `bun test test/helpers/ test/tui/ test/server/`. Locally: `bun run test:ci` for a full-suite
  confirmation. One final root `bun run typecheck` after the slice.
- Meet EOT-01 budgets: full unit-test run under 60 s, integration under 5 min, e2e under 10 min on the reference
  machine; `bun run test:ci` sharded run stays under the documented time cap with `--isolate`.

## Migration and Rollback

Phase by layer. Unit patterns land first (testEffect, schema assertions, fixture helpers); integration patterns second
(isolated database, Server.fetch round-trips); e2e patterns third (TUI PTY, browser harness). Each phase flips a
documentation/test-helper change; existing tests migrate incrementally. Roll back by removing the new helper, not by
reverting the test that uses it. Tests are not weakened to satisfy new patterns; if a pattern is wrong, the pattern is
fixed, not the test.

## Discipline Addendum — 2026-09-18

Three concrete rules pin what a Slice-1 EOT-20 delivery looks like in this codebase. They do not change the spec above;
they codify the helpers and patterns that already exist so a code reviewer does not have to re-derive them every PR.

1. **No `sleep` for racing.** When a test needs to coordinate with concurrent work, it uses the barrier helpers in
   `packages/nikcli/test/helpers/barrier.ts` (`barrier(count)`, `deferred()`, `withTimeout`, `waitFor`). A test that
   uses `await new Promise(r => setTimeout(r, N))` to wait for an event is a test that loses under CI load. The fix is
   to subscribe to the event itself (`bus.on`, `fiber.addObserver`, a deferred resolve), not to wait longer.
2. **Isolated database per test.** Tests that touch `nikcli.db` use `withIsolatedDatabase` (`test/helpers/sqlite.ts`) or
   the new `withFixture` (`test/helpers/fixture.ts`). A test that mutates the shared database is a flake waiting to
   happen. The sharded CI runner (`script/test-ci.ts`) uses `--isolate`, so this is not optional.
3. **Shared fixture loader for new feature tests.** New tests under `test/{plugin,cli,mobile}/` default to
   `withFixture` (`test/helpers/fixture.ts`). It composes `withIsolatedDatabase` + `preserveTestEnv` + `barrier`.
   A case that declares a count — `withFixture({ barrier: 2 }, ...)` — is held to it: arrivals still pending when the
   body returns fail the case, because a barrier that opened for fewer arrivals than the test declared opened for a
   reason the test did not intend. The check is skipped when the body itself threw, so a real failure is never
   replaced by a complaint about bookkeeping. Everything `withFixture` does happens inline, inside the calling case —
   it registers no `beforeEach`/`afterEach`, which from inside a running case would attach hooks to the _following_
   cases and leave this one unguarded. Existing tests are not required to migrate; new tests are expected to.

4. **"Passes alone, fails in the suite" is a claim to be bisected, not a flake to be retried.** A flaky test fails
   _some_ runs of the same command. A test that fails deterministically under one command and passes under another is
   reporting a real difference, and the difference is usually shared process state: `bun test` runs every file in one
   module registry, so whichever file loads a module first decides what that module captured. Bisect it — halve the
   file list, then bisect within the half, then run each candidate against the failing file. Two findings came out of
   doing that here: eight `test/server/local-account-session.test.ts` failures that were `Flag` constants capturing
   `process.env` at import (EOT-12), and one `mobile-pairing-listener` timeout that was an unbounded `npx` on a
   request path (EOT-19). Neither was a test problem. Before concluding a failure is pre-existing, prove it: restore
   the HEAD version of the files your change touched and re-run.
5. **A gate with an empty list still needs a test that makes it fail.** An allowlist that has never been shown to bite
   is indistinguishable from a check that does nothing. `check-open-payloads.ts` and `check-account-required.ts` both
   take `--src` / `--dir` / `--allowlist` / `--privileged` overrides so their tests drive the real script against a
   synthetic tree, in both directions. A test that re-declares the script's own regexes and asserts against the copies
   passes whatever the script does.

6. **TUI tests live in `packages/nikcli/test/tui/`, not in `packages/tui`.** 55 files, and the
   evidence table in `ROADMAP.md` names that directory for TUI work. A second test directory was
   created in `packages/tui` during the EOT-03 audit on the belief that none existed, duplicating
   coverage that was already there; it has been removed. Before concluding a surface is untested,
   grep for its tests by _subject_ rather than by the package you happen to be editing —
   `packages/tui/src/util/lifecycle.ts` is tested two packages away.

7. **A string literal holding a whole `import … from "…"` is rewritten before the assertion
   runs.** `test/tui/onboarding-auth.test.ts` asserted that `app.tsx` imports its dialogs
   statically by comparing against literals of that shape, and the module transform
   resolved the specifier inside them: the expected value arrived as
   `file:///…/dialog-onboarding.tsx`, so the test compared the file against a path and
   failed. It surfaced only in a full-directory run, which made it read as a flake for the
   third time in this catalogue. Assemble such a literal from parts — nothing asserting on
   source should spell an import statement out in one piece.

The lifecycle counters from EOT-01 (`packages/nikcli/src/effect/lifecycle-counters.ts`) are observable from any test via
`snapshot()` so a test can assert `scope.completed === 1` or `runtime.bridge.failure === 0` after a behavior assertion
without having to instrument the production code. Use this when the assertion would otherwise be a magic `sleep`.
