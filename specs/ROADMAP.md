# Effect and TUI Architecture Roadmap

Status: proposed implementation program. Baseline date: 2026-09-10.
Scope: `packages/tui`, `packages/nikcli`, and the SDK/identity seams they cross. [Catalog and evidence](README.md).

## Objective

Improve responsiveness, predictable resource usage, failure propagation, observability, and maintainability while
preserving the standalone TUI, CLI/worker/HTTP/mobile modes, existing user workflows, and the current Effect/OpenTUI
pins. Deliver vertical slices with measured outcomes; do not rewrite every Promise into Effect or every Solid signal
into a service.

Twenty-one specifications organize the work. EOT-00 is a single released-defect gate that blocks every promotion
until it passes; the other twenty span three horizons that match the phase column below: a correctness,
contract, and evidence baseline (EOT-01..03, EOT-10, EOT-12, EOT-13, EOT-20), a bounded data/state/isolation layer
(EOT-04, EOT-05, EOT-08, EOT-09, EOT-11, EOT-14..17), and the user-visible experience and bridge surface (EOT-06,
EOT-07, EOT-18, EOT-19). Implementation lands in dependency order, one slice at a time; each spec header carries its
own status. EOT-18 is the exception to the "proposed" framing — its parser premise shipped, and what is left there is
policy.

## Execution Ledger

Appended 2026-09-29, after a pass over the gates below. Every "landed" line is backed by a named suite run in that
session; every "open" line is a gate that still needs work, not a claim that a consumer is missing.

**Landed and verified**

- Active sync recovery. `/sync/outbox` paginates on `(seq, aggregate, id)` with a `nextCursor`; the transport keeps
  per-aggregate cursors that advance only after an event applies; subscription is fenced before the journal is read
  (`readiness=1`); recovery re-runs on reconnect, on a token-refresh reopen, and on a superseded generation. 86 tests
  across `test/sync/` and `test/server/httpapi-sync.test.ts`. Generated clients regenerated; `check:routes --strict`
  clean.
- Plugin store quota accounting (EOT-14 slice): replacement no longer double-counts, files already on disk are charged,
  watcher reloads re-check, and concurrent writes to different stores share one reservation instead of racing it.
- Dialog stack revision guard plus the first real consumer (`component/dialog-profile.tsx`), and the per-key input
  decision from EOT-07: `ownerOf` now resolves the Ctrl+C/Escape dispute at the one site that arbitrates.
- Fail-closed baseline validation and terminal provenance in the startup harness (EOT-01 slice). Server-route evidence
  only.

**Open — and why it is still open**

- EOT-00. Still no real Ghostty leg, and the tmux leg is an emulated environment. No promotion, no ratified budgets.
- EOT-15 consumer barrier. The sync producer and the fencing contract exist; the TUI still refetches on reconnect
  instead of resuming per aggregate. `SyncProjection.session` exposes only id/title/lastTouchedAt, so a session
  watermark barrier is a protocol question, not a wiring one.
- EOT-16. `locallyWorkspace` still pins a value rather than scoping resources (gap B31).
- EOT-04 client admission, EOT-06 measured windowing, EOT-18 headless policy on the remaining handlers, EOT-11 adapter
  convergence. Untouched in this pass.

**Session 2026-09-30 — landed and verified** (each line names the check that was run)

- EOT-18 req. 9 and 12. A cancelled prompt exits `130` quietly; in headless every interactive prompt fails closed with
  `UI.HeadlessFailure` (exit `66`) instead of waiting on a stdin nobody feeds. `isHeadless` never fired on a real pipe
  (`isTTY` is `undefined`, not `false`) and now does. `test/cli/` 262 pass; driven on a real PTY and with `< /dev/null`.
- EOT-04. The client batch cap (`EVENT_BATCH_CAP = 512`) existed untested and the spec called the batch uncapped; now
  pinned by a 1500-frame burst test that fails without the cap.
- EOT-02. `InstanceScope.with` interrupted from outside the instance's ALS scope, so a finalizer reading
  `Instance.directory` threw and the caller waited forever (two `multi-instance-teardown` tests were red, outside CI).
  Fixed in the bridge; that file 4/4, `test/effect` + `test/workspace` 75/75, 28 consumer suites 0 failures.
- EOT-16 / B31. Pinned by behaviour, not a comment: two workspaces on one directory share one `InstanceState` entry.
- EOT-19. Classifying `read`/`write` for `mobile`/`studio` would change no decision today (both hold both); it waits for
  per-token capabilities.

**Open, and what each is actually waiting for** (measured this session, none is a wiring task)

- EOT-14. All seventeen remaining internal v1 plugins register commands through `keymap`; the v2 `Context` has no
  command surface, so none can migrate without losing behaviour. Next: design that surface in `packages/plugin`.
- EOT-15 consumer. `/global/event` is a live fan-out with no sequence number on the envelope, so the TUI has nothing to
  resume from. Next: decide the protocol (a per-aggregate `seq` on the envelope or `Last-Event-ID` replay), which is a
  contract change for every client and lands through EOT-10.
- EOT-11. `CachePolicy.Service`, `Usage.Service` and the tagged `ProviderError` service do not exist; a change to every
  model call now has test-only characterization of current retry/usage behaviour, not an implementation or promotion.
  Existing cache, usage and error helpers are not those services; full adapter convergence remains future work.
- EOT-16 / B31. Pinned, not closed: giving each workspace its own scope moves the cache key and the dispose owner.

---

### Review the evidence

2026-10-02: the EOT-11 partial-output safety slice stops processor retries after published text, reasoning, tool or
billed step output, preserving content and the terminal `APIError` rather than removing parts and replaying the request.

Native midstream failures are lazy iteration errors, outside the setup fallback catch; they are not actual midstream
fallback to the AI SDK. `packages/nikcli/test/session/processor-retry.test.ts` and
`packages/nikcli/test/session/native-runtime.test.ts` pin content preservation, no replay and no synthetic finish.

Baseline before changes, from `packages/nikcli`:
`bun test test/session/processor-retry.test.ts test/session/native-runtime.test.ts test/session/llm-event-adapter.test.ts`
reported **49 pass, 0 fail, exit 0**. After the slice, the wider targeted run
`bun test test/session/processor-retry.test.ts test/session/native-runtime.test.ts test/session/llm-event-adapter.test.ts test/session/processor-effect-service.test.ts test/session/retry.test.ts test/session/retry-precise.test.ts`
reported **108 pass, 0 fail, exit 0**, `bun run format:check` and `bun run lint` reported 0 errors, and
`bun run typecheck` in `packages/nikcli` exits 0. (An earlier typecheck in this session reported twelve errors in
the vendored Copilot chat language model (since removed with the AI SDK) from a duplicated `@ai-sdk/provider` in the
installed tree; `bun install --frozen-lockfile` cleared them, so that was install drift rather than a repo defect.)

`bun run script/test-ci.ts` over the whole suite (487 files, 20 batches), run with nothing else on the machine, reported
**5376 pass, 4 fail**. Both surviving failures reproduce with the slice stashed at pristine `live-main`: three need
ripgrep, which is not installed on this machine, and one is a release-workflow expectation still spelling
`macos/ADE.app.tar.gz` against a workflow that uses `$NAME`. No session suite failed. Three earlier runs of the same suite
reported 13, 5 and 4 failures with the extras landing in a different file each time — all 30s timeouts from work running
alongside, each passing standalone (`test/codemode/parity.test.ts` alone: **54 pass, 0 fail**). Only the uncontended
number is evidence.

**All four fixed 2026-10-03** — the suite's only remaining failures were two environment/expectation problems, not product
defects. The three PKCE failures shelled out to `rg`, which this repo deliberately treats as optional (production disables
the tier when `Bun.which("rg")` misses, `src/file/ripgrep.ts:41-49`); the helper is now a native walk, which also removed a
hole where an uncompilable pattern silently reported "no offenders" and made a security assertion pass vacuously. The
`automation.test.ts` failure was a stale literal: `0384786e75` moved the workflow to `$NAME` from `brand.json` and left the
test spelling `macos/ADE.app.tar.gz`; the test now follows `$NAME` and a second, previously masked assertion was stale too.

Next: full adapter convergence, then the `CachePolicy.Service` and `Usage.Service` the spec still records as absent. The
missing-usage and header items are closed — see below. EOT-11 stays proposed at Tier 1/P2 with unchanged dependencies;
EOT-00's real Ghostty/tmux gate remains open, so this slice does not permit promotion.

Later the same day, a second EOT-11 slice closed both items this one left open, and the measurement changed the work:
a real 429 carrying `retry-after: 7` proved the native runtime already honours the header on its own retries, and that
when it gave up it threw a fully populated `LLMError` — which crossed into `MessageV2.fromError` as a non-retryable
`UnknownError`, so `SessionRetry` never saw the header at all. `packages/nikcli/src/session/llm/llm-event-adapter.ts`
now maps that error to a status- and header-carrying `APICallError` at the single seam native failures cross, and
counts finish events that arrive without usage instead of leaving a zero-billed turn looking free.
`packages/nikcli/test/session/native-retry-after.test.ts` serves real 429 and 400 responses and pins it; deleting the
mapping turns it red with `Received: "UnknownError"`. Nine session suites then reported **175 pass, 0 fail, exit 0**.

Rollback must not restore retries over published content. See [EOT-11](effect-tui/11-provider-inference-streaming.md)
for the inspected behavior and remaining convergence work.

---

## Target Architecture

```text
CLI / embedded worker / standalone host / mobile companion
  -> host capabilities + startup config + shutdown ownership
  -> generated SDK transport (HTTP, websocket, worker RPC)
  -> bridge protocol (typed contracts, JWT-verified)
  -> bounded event admission + recovery + watermark/snapshot barrier
  -> normalized Solid stores + pure incremental selectors
  -> OpenTUI components, focus routing, measured row window
  -> observability: spans, metrics, logs, redaction, live panel

Bun.serve / tools / command boundaries
  -> validation + typed Effect services
  -> runtime bridge + InstanceRef / WorkspaceRef / PluginRef
  -> scoped execution, bounded work, domain repositories
  -> committed state + events + redacted observability
  -> permission/sandbox/policy enforcement at every cross-boundary call
```

Pure transforms stay pure. Solid owns reactive state and renderable lifetimes. Effect owns backend dependency graphs,
typed failures, cancellation, and service resources. The transport adapter is the seam, not a second domain model.
No TUI import may reach backend runtime, database, account storage, or server implementation code. No CLI/mobile code
may bypass the typed contract.

## Non-Negotiable Decisions

1. Preserve `layer`/`defaultLayer`, `runPromiseWithLayer`/`runService`, and the existing instance bridge. No second runtime
   factory, second instance ALS, or runtime per component. Any TUI-side Effect execution needs a host-provided owner and
   evidence that it is better than the existing cancellation adapter; the default is not to add one.
2. Use `Schema.TaggedError` for new expected domain failures, retain `Cause`/`Exit` at internal boundaries, and distinguish
   interruption, defect, timeout, transport failure, and an empty successful result.
3. HttpApi remains the contract authority. `nikcli.json` stays Zod-derived through `fromZod`; generated clients are not
   handwritten. Do not introduce Hono, hey-api, a parallel config schema, an alternate database layer, or a parallel
   plugin runtime.
4. Bounded queues require a stated overflow/recovery policy. A faster view that drops text, permission prompts, or final
   outcomes is a correctness regression. Safety and tenant isolation outrank performance.
5. Keep existing tests and CI signals. Do not add the full nikcli suite back to CI; run whole-suite checks locally through
   `bun run test:ci`. Preserve targeted Windows suites, client-drift, formatting/lint, and Railway/Docker guards.
6. The bridge protocol (CLI / TUI / SDK / mobile / companion / remote) is one typed contract per direction; clients are
   generated, not handwritten. Capability gating is part of the contract; absent capabilities are surfaced, not silently
   stubbed.
7. Workspace is a typed Effect scope; cross-workspace reads of mutable state are typed failures, not silent merges.
   Identity-based reuse is the canonical way to dedupe; switching is a deterministic, cancellable operation.
8. Permission/sandbox/policy evaluation is mandatory at every cross-boundary call. A deny is terminal; a prompt is the
   default for undeclared operations. Headless mode fails closed unless every required decision is pre-resolved.
9. Observability is a first-class architectural seam: spans, metrics, and logs flow through `Observability.layer` with
   fixed-cardinality labels and redaction enforced everywhere. OTLP export is opt-in; the in-process live panel is
   default-on. Redaction is not a configurable option.
10. Testing follows the three-layer architecture (unit, integration, e2e) with deterministic fixtures, isolated
    databases, PTY harnesses, and barriers — never `sleep` races. CI does not run the full nikcli suite; whole-suite
    checks happen locally through `bun run test:ci`.

## Prioritized Work and Dependencies

Tier 1 = correctness and evidence first; Tier 2 = user-visible performance and protocol surface; Tier 3 = deeper
efficiency after evidence. Owner names below are responsibility roles, not assignments to unconsulted people. Effort is
relative: S is a narrow change, M spans a few seams, L requires several separately verified PRs. No calendar dates are
promised.

| ID                                                        | Tier | Phase | Dependencies                           | Effort | Risk   | Primary owner               | Release gate                                                        |
| --------------------------------------------------------- | ---- | ----- | -------------------------------------- | ------ | ------ | --------------------------- | ------------------------------------------------------------------- |
| [EOT-00](effect-tui/00-startup-hang.md)                   | 1    | P0    | none                                   | M      | High   | TUI host/renderer           | `hangRate == 0` over 200 compiled starts across a PTY matrix        |
| [EOT-01](effect-tui/01-performance-baseline.md)           | 1    | P0    | EOT-00                                 | M      | Low    | Performance/test            | Reproducible measurements and failure-sensitive assertions          |
| [EOT-02](effect-tui/02-effect-boundaries.md)              | 1    | P1    | EOT-01                                 | L      | High   | Effect/domain               | Typed boundary and multi-instance teardown tests                    |
| [EOT-03](effect-tui/03-tui-lifecycle.md)                  | 1    | P1    | EOT-02                                 | M      | High   | TUI lifecycle               | No stale commits or surviving owner work                            |
| [EOT-10](effect-tui/10-contracts-errors-security.md)      | 1    | P1    | EOT-01                                 | L      | High   | HttpApi/security            | Error/encoding/auth parity and clean generated output               |
| [EOT-12](effect-tui/12-identity-onboarding-auth.md)       | 1    | P1    | EOT-02, EOT-03, EOT-10                 | L      | High   | Identity/auth/account       | Typed state machine, no PKCE downgrade, no skipped onboarding       |
| [EOT-13](effect-tui/13-observability-pipeline.md)         | 1    | P1    | EOT-01, EOT-02                         | M      | Medium | Observability/brain/profile | Fixed schema, redaction, live panel bounded                         |
| [EOT-20](effect-tui/20-testing-architecture-harnesses.md) | 1    | P1    | EOT-01, EOT-02                         | M      | Low    | Test infra                  | Three-layer harness, deterministic fixtures, no flake wins          |
| [EOT-04](effect-tui/04-event-delivery.md)                 | 1    | P2    | EOT-02, EOT-10                         | L      | High   | Transport/bus               | Bounded lag and verified recovery without silent loss               |
| [EOT-09](effect-tui/09-jobs-persistence.md)               | 1    | P2    | EOT-02, EOT-04, EOT-10                 | L      | High   | Execution/storage           | Durable terminal states, concurrency bounds, recovery               |
| [EOT-11](effect-tui/11-provider-inference-streaming.md)   | 1    | P2    | EOT-01, EOT-02, EOT-10                 | L      | High   | Provider/llm core           | Adapter unification, cancellation, cache, retry, token accounting   |
| [EOT-14](effect-tui/14-plugin-v2-architecture.md)         | 1    | P2    | EOT-02, EOT-03, EOT-08, EOT-10         | L      | High   | Plugin SDK/runtime          | v2 contract, hot reload, capability gating, scoped generation       |
| [EOT-15](effect-tui/15-sync-snapshots-watermarks.md)      | 1    | P2    | EOT-04, EOT-05, EOT-09                 | L      | High   | Sync/mobile bridge          | Snapshot barrier, watermark, gap handling, multi-device ordering    |
| [EOT-16](effect-tui/16-workspace-isolation.md)            | 1    | P2    | EOT-02, EOT-03, EOT-09                 | M      | High   | Workspace/instance          | Workspace as typed Effect scope, hot switch, isolation tests        |
| [EOT-17](effect-tui/17-sandbox-permission-boundaries.md)  | 1    | P2    | EOT-02, EOT-09, EOT-10, EOT-11         | L      | High   | Permission/sandbox/policy   | Typed ruleset, coupling respected, sandbox containment              |
| [EOT-05](effect-tui/05-reactive-state.md)                 | 2    | P2    | EOT-03, EOT-04                         | L      | High   | TUI state                   | Scoped query/state correctness and stable row identity              |
| [EOT-08](effect-tui/08-host-plugins-startup.md)           | 2    | P2    | EOT-02, EOT-03                         | M      | Medium | Host/plugins                | Standalone and compiled parity; reload resource plateau             |
| [EOT-19](effect-tui/19-mobile-companion-bridge.md)        | 2    | P3    | EOT-04, EOT-08, EOT-12, EOT-15         | L      | High   | Mobile/companion/remote     | Typed bridge, JWT, websocket, multi-device, capability gating       |
| [EOT-18](effect-tui/18-cli-command-architecture.md)       | 2    | P3    | EOT-02, EOT-08                         | S      | Medium | CLI dispatch                | Exit-code mapping, headless posture, daemon lifecycle (parser done) |
| [EOT-06](effect-tui/06-terminal-rendering.md)             | 2    | P3    | EOT-05                                 | L      | High   | TUI rendering               | Streaming virtualization, anchor fidelity, measured latency         |
| [EOT-07](effect-tui/07-input-interaction.md)              | 2    | P3    | EOT-03, EOT-05                         | M      | High   | TUI interaction             | Keyboard/focus/permission matrix on real terminals                  |
| [EOT-21](effect-tui/21-gadgets-device-bridge.md)          | 2    | P3    | EOT-04, EOT-10, EOT-14, EOT-17, EOT-19 | L      | Medium | Plugin SDK/bridge           | Bounded feed, gated tool, TUI commands, SDK round-trip              |

EOT-00 is the one hard stop: while a compiled start can silently fail to paint, no startup or rendering budget may
be ratified and no spec may be promoted past its current phase. Characterization work continues; promotion does not.

Dependencies are exit gates, not permission to stall unrelated characterization tests. After P0, EOT-02, EOT-10,
EOT-12, EOT-13, and EOT-20 may characterize existing behavior in parallel, but each release gate still requires all
dependencies listed above to pass.

EOT-08 and EOT-18 need not wait for EOT-04/05/15; EOT-06, EOT-07, EOT-19 and EOT-21 are independent after their listed
prerequisites. Run memory-heavy verification serially even when implementation work is independent.

## Phase Exits

### P0: Establish Truth

**Status 2026-09-20: closed for the server-route baseline; the TUI startup half waits on EOT-00.** On
2026-09-25 EOT-00 ran 603 compiled starts across three of its four terminals with no stall; Ghostty is still owed,
so the wait stands. Corrected 2026-09-29: those 603 are compiled starts, and the tmux leg is an emulated
terminal environment rather than a tmux-driven run — so the evidence is _no observed stall in three process
contexts_, not a completed real-terminal matrix. `script/tui-startup.ts` now records
`realTerminalCoverage: observed-process-context | unverified | unavailable` alongside the Ghostty/tmux flags it
actually observed, so a future artifact cannot read as full matrix coverage. The
baseline artifact exists at
`packages/nikcli/specs/perf-baseline.json` and `check:perf-baseline` gates it in
`script/ci-validate.ts`. It had not been closed because the probe never returned —
`perf-baseline.ts` finished measuring in under a second and then hung on open handles, so
no artifact could be produced. As of 2026-09-29 the validator is fail-closed rather than advisory: it rejects an
unreadable or non-JSON artifact, an unknown version, zero samples, an unparseable `recordedAt`, absent host
metadata, an empty route set, duplicate route names, route/sample-count mismatch, non-finite or negative
timings, a missing required route, malformed or unbalanced lifecycle counters, a nonzero `scope.finalizer-leak`,
and a run that recorded no scopes. The gate enforces the machine-independent half (shape,
sample counts, lifecycle-counter balance) and deliberately does not gate wall-clock, for
the reason this section already states: a noisy baseline is not a pass either. Server-route evidence only: the
full TUI budgets remain unratified. See the P0
Closure section in `effect-tui/01-performance-baseline.md`.

- Record versions, host modes, workload fixtures, raw metrics, queue/resource counters, and a baseline comparison format.
- Add missing behavioral probes before modifying hot paths; characterize existing best-effort and fallback semantics.
- Ratify EOT-01 candidate budgets in a reviewed baseline artifact. A noisy or missing baseline is not a pass.
- Characterize existing harnesses and identify missing probes for EOT-20 before changing behavior.
  The full three-layer harness gate belongs to P1 and requires EOT-01 and EOT-02 to pass; P0 does not close EOT-20.

### P1: Make Lifetimes, Failures, Identity, and Observability Explicit

- Tighten the runtime bridge incrementally; keep compatibility adapters until callers have migrated and tests prove parity.
- Pilot boundary validation with account and TUI-config flows; prove request cancellation reaches actual I/O.
- Migrate high-risk dialogs and bootstrap teardown first. Verify late success, late failure, and late resource acquisition.
- Land the typed identity state machine (EOT-12) and the observability pipeline (EOT-13). One span schema, one
  metric schema, one log schema, one redaction policy — applied to every cross-boundary call.
- Wire EOT-20's harness layers so every spec from this phase lands with matching tests, not retroactive scaffolding.
  Close its full release gate only after EOT-01 and EOT-02 pass.

### P2: Bound the Data Path and the Bridge Surface

- Apply capacity and recovery policies to HTTP and worker event delivery before consolidating client batches.
- Introduce snapshot/watermark barriers (EOT-15) for the sync subsystem and the mobile companion.
- Make workspace a typed Effect scope (EOT-16) and permission/sandbox a typed boundary (EOT-17).
- Land the plugin v2 contract (EOT-14), the provider-streaming adapter (EOT-11), and the jobs/persistence durability
  guards (EOT-09) after their respective listed dependencies pass, not as a plugin-to-provider-to-jobs chain.
  Beyond shared EOT-02/EOT-10, EOT-14 requires EOT-03/EOT-08, EOT-11 requires EOT-01, and EOT-09 requires EOT-04.

### P3: Improve the Experience and the Bridge Orchestration

- Replace estimated row windowing with measured, anchor-preserving rendering (EOT-06); keep selection and pending input
  reachable.
- Unify focus/input ownership (EOT-07) and extract prompt/session controllers by responsibility.
- Land the mobile companion bridge (EOT-19) and the CLI command architecture (EOT-18) so that the user-facing surfaces
  share the typed contracts introduced in P1/P2.

### P4: Consolidate and Release

No new feature scope. Remove only migration adapters proven unused, update this catalog with completion evidence,
exercise every host mode (CLI, embedded worker, HTTP, standalone, mobile, companion, remote), and compare final results
to P0. Leave any unpassed spec proposed/in-progress rather than claiming the architecture program is complete.

## First Implementable Slices

1. EOT-01: the startup probe now records raw samples, nearest-rank percentiles, and child RSS when
   readable; event-feed / plugin-dispose / streaming-cost harnesses record queue-depth, lifecycle
   residuals, and once-path summaries. `bench:startup <bin> > run.json` now yields a file the probe
   itself can diff (`BASELINE=<file>`, descriptive by default, a gate under
   `BASELINE_MAX_REGRESSION`). Collect the 30-warm / 10-cold baseline on a compiled binary
   and ratify candidate budgets before optimization. No production behavior changes.

   **Not ratifiable yet.** The compiled binary intermittently never paints — roughly one start in
   three to eight on 2026-09-12. A budget averaged over the samples that _did_ paint certifies a
   startup that sometimes does not happen, so ratification waits on
   [EOT-00](effect-tui/00-startup-hang.md), which holds the evidence and the gate. One observation
   stands regardless: `firstPaint` and `usablePrompt` differed by under a millisecond in every
   sample, so on that binary the second metric carried no information the first did not.

2. EOT-02: type one `runService` caller chain without widening requirements; exercise finalizers and concurrent instances.
3. EOT-10: characterize standalone TUI-config 401, malformed response, and offline failure; forbid empty-config success.
4. EOT-12: lock the identity state machine; pilot one transition (token refresh) through the existing TUI flow;
   prove that account creation cannot be skipped on first sign-in.
5. EOT-13: lock the span/metric/log schema; instrument one route group (start with `session`) end-to-end and verify
   redaction. Keep the live panel rate-limited.
6. EOT-20: land the three-layer harness and migrate one existing flaky integration test to the barrier pattern.
7. EOT-03: carry abort plus generation checks through one complete dialog request/resource/close flow.
8. EOT-04: classify event types and test overload before introducing admission caps; retain server encode-once behavior.
9. EOT-09: extend monitor or one background job family with capacity/queue/terminal-state guards.
10. EOT-11: done through the 2026-10-02 slices — partial-output retry safety, then rate-limit typing with `Retry-After`
    preserved and a missing-usage gap flag. What remains is full adapter convergence and the `CachePolicy.Service` /
    `Usage.Service` the spec still records as absent.
11. EOT-14: **two slices landed 2026-10-02** — internal definitions now share the manifest/host/capability validation
    that only file plugins went through, and v2 command presentation fields are re-read instead of captured at
    registration. Also **corrected a stale claim**: the spec said v2 had no command surface at all, which was wrong —
    `ui.command` and the `commands` capability have existed for some time; the gap was one argument. The `background`
    migration itself stays blocked on an `api.kv` equivalent, because v2 `storage` writes a different file than the
    `kv.json` its dialog and view read directly.
12. EOT-15: **producer-side half landed 2026-10-02** — `/sync/outbox` takes an optional `aggregate` filter, so a
    consumer holding per-aggregate cursors can page one aggregate at a time instead of replaying every aggregate above
    the lowest cursor. The consumer-side barrier is still open: the TUI resumes by blind refetch.
13. EOT-16: tighten workspace scope semantics on one operation; verify concurrent isolation.
14. EOT-17: migrate one permission group (start with file system) to the typed evaluator.
15. EOT-05: extract one resource family's pure reducer and coordinator; verify replay equivalence.
16. EOT-08: characterize eager imports and lazy-import one optional feature module off the critical path.
17. EOT-19: phase in mobile capabilities (start with session lifecycle, then events, then PTY).
18. EOT-18: land the exit-code mapping first, then headless posture, then plugin command scoping, then daemon/attach.
    The parser migration is already done (`specs/cli-framework.md`).
19. EOT-06: integrate measured row heights and anchor-preserving scroll behind the existing message-virtualization flag.
20. EOT-07: extract one prompt controller and one route/plugin input ownership path.

Each slice contains its matching test, source change, measured result when relevant, and rollback note. Do not combine
an Effect upgrade, transport protocol migration, virtualization default flip, observability schema change, and CLI
migration in one PR.

## Landed Slices

**Every spec below is still `proposed`** — a landed slice is evidence the seam
exists and is guarded by a test, not that the spec has passed its release gate.
Nothing here is marked complete. Rows are in the order they landed, so a spec
appears more than once.

| Spec   | What landed                                                                                                      | Commit                     |
| ------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------- |
| EOT-01 | One probe-environment block shared by both probes; `loadavg1` added                                              | `dc3cab7fd`                |
| EOT-01 | Probe progress moved to stderr; `BASELINE` comparison with an opt-in regression gate                             | `dd27545efd`               |
| EOT-02 | `runService` requirement typing; `any` and the cast removed                                                      | `3ec56934`                 |
| EOT-02 | `runPromiseWithLayer` requires `R extends ROut`; four latent missing-service runs fixed                          | `dd27545efd`               |
| EOT-03 | `useAttempts`: supersession guard for restartable dialog flows                                                   | `4495840e1`                |
| EOT-03 | `attempt.adopt`: a resource acquired by a superseded attempt is released, not leaked                             | `3ecef498c0`               |
| EOT-04 | Queue depth meter; refetch on reconnect instead of resuming into a gap                                           | `3ec56934`, `4a767a5f9`    |
| EOT-04 | Delivery-class registry on the event declaration, ahead of admission caps                                        | `2b48957306`               |
| EOT-04 | Per-connection frame and byte accounting, including server-generated frames                                      | `2b48957306`               |
| EOT-05 | Optional bootstrap requests settle; `sync.degraded` replaces a pinned `partial`                                  | `12d8ef764`                |
| EOT-05 | Replay equivalence verified: a snapshot reaches the same state as a cold journal                                 | `3ecef498c0`               |
| EOT-06 | Windowing math pinned by tests, including two properties                                                         | `92dc72d2a`                |
| EOT-06 | Windowing heights derived per turn from content instead of a flat constant                                       | `3ecef498c0`               |
| EOT-07 | Ctrl+C asks the renderer for focus instead of a source string and a missing DOM                                  | `2744425ad`                |
| EOT-07 | Input precedence as an ordered table: modal > editable > route > application                                     | `3ecef498c0`               |
| EOT-08 | Import-cost probe; one dialog moved off the critical path against a measured delta                               | `a9725f1d7`                |
| EOT-08 | Four more dialogs off the critical path: eager set 3344ms -> 1552-2003ms                                         | `3ecef498c0`               |
| EOT-09 | `isTerminal`/`canTransition` for background-run outcomes                                                         | `3ec56934`                 |
| EOT-09 | Post-commit publication moved from an ambient queue to the transaction's `ctx`                                   | `84ffbe798b`               |
| EOT-10 | Standalone and CLI hosts stop turning a config failure into an empty config                                      | `3ec56934`, `67a2b811b`    |
| EOT-10 | Open-payload inventory pinned per file; a new `Schema.Unknown` fails a test                                      | `dd27545efd`               |
| EOT-11 | `suppressEmptyTextResult` covered: a rejection still reaches an awaiting caller                                  | `9483b4645`                |
| EOT-11 | A whole native turn pinned as one ordered processor sequence                                                     | `3ecef498c0`               |
| EOT-12 | Onboarding retry bounded; typed `incomplete` outcome instead of a parked startup                                 | `a6b1c758c`                |
| EOT-12 | Auth lifecycle as a legal-transition table, shared contract for server and TUI                                   | `3ecef498c0`               |
| EOT-13 | `span-schema.ts`: fixed attribute schema, forbidden segments, redact-then-truncate                               | `3ec56934`                 |
| EOT-13 | Span `statusMessage` redacted; `nku_` and opaque bearer tokens added to the redactor                             | `2b48957306`, `eac4ca76a6` |
| EOT-14 | v2 manifest is the v1/v2 discriminator; host-range and capability checks at load                                 | `dd27545efd`               |
| EOT-14 | Per-plugin activation budget: one wedged `setup` no longer holds the whole startup                               | `3ecef498c0`               |
| EOT-15 | `detectSequenceGap`: a replay resuming across a compacted range is now reported                                  | `34ed8b55a`                |
| EOT-15 | A projection replayed across a hole is no longer persisted as a snapshot                                         | `3ecef498c0`               |
| EOT-16 | LSP and provider refreshes scoped to the active workspace                                                        | `41b718d16`                |
| EOT-16 | Session directory survives a remote workspace target; corrupt records stop reading as missing                    | `2b48957306`               |
| EOT-17 | Precedence corrected to the shipped contract; ordering guarded by a test                                         | `3ec56934`, `67a2b811b`    |
| EOT-17 | Every permission decision audited with the rule that produced it; denials at info                                | `3ecef498c0`               |
| EOT-18 | Command-surface gate restored and repointed                                                                      | `f5783a970`                |
| EOT-18 | `cmd()` takes `bootstrap`/`teardown`; teardown runs in a finally without masking the handler                     | `3ecef498c0`               |
| EOT-19 | Per-device capabilities the bridge advertises; an unknown scope grants nothing                                   | `3ecef498c0`               |
| EOT-20 | Test layers made disjoint; barrier helpers; one flaky test migrated to a barrier                                 | `3ec56934`, `4035590e2`    |
| EOT-20 | `preserveTestEnv` discipline enforced: a module-scope `NIKCLI_*` write fails a test                              | `dd27545efd`               |
| EOT-01 | Lifecycle counters on the bridge; a cancel counted once, synchronously, and a finalizer-leak watchdog            | `644a8f28`                 |
| EOT-02 | Bridge exits classified; two `WorkspaceRef`s on one directory torn down without interleaving                     | `644a8f28`                 |
| EOT-04 | `BYTE_BUDGET` enforced **per frame**; a lifetime budget would evict every healthy long-lived reader              | `644a8f28`                 |
| EOT-10 | Open-payload gate in CI, keyed by declaration text so an unrelated edit above a site is not a failure            | `644a8f28`                 |
| EOT-12 | Typed account state machine + guard; the empty privileged-route list is the finding, with evidence               | `644a8f28`, `6d880fc3`     |
| EOT-12 | Verifier env read at call time: 8 "flaky" auth tests were `Flag` constants captured at first import              | `48344aa4`                 |
| EOT-13 | Span-schema gate; bounded telemetry consumer; the brain span moved onto a runtime that has the layer             | `644a8f28`                 |
| EOT-14 | Plugin-v2 gate: manifest exports, the tags consumers catch on, and autoload as a hard opt-in                     | `644a8f28`                 |
| EOT-16 | Workspace-isolation gate, including the bridge comment that records the open B31 sharing gap                     | `644a8f28`                 |
| EOT-17 | Network egress accounted (45 modules) rather than choked through a layer nothing routes through                  | `644a8f28`                 |
| EOT-19 | `/mobile/bootstrap` probes bounded and de-networked: 8s+ -> 950ms on the app's connect path                      | `d1e2f99e`                 |
| EOT-20 | `withFixture` as the shared harness; both new gates driven by tests that make them fail                          | `644a8f28`, `6d880fc3`     |
| EOT-12 | Flag capture-at-import is a CI gate, not four fixes; the legacy-credential pair moves together                   | `ac52fff3`                 |
| EOT-20 | TUI tests already lived in `packages/nikcli/test/tui` (55 files); a duplicate directory removed, `adopt` covered | `995fff77ba`               |
| EOT-01 | P0 closed: the probe never returned, so no baseline existed; artifact + gate now in CI                           | `7376aed1e1`               |
| EOT-13 | Redaction fuzz: camelCase keys, `:`/space/`\|` separators, URL userinfo and glued tokens all escaped             | `936ae2289a06`             |
| EOT-13 | OTLP smoke: the exporter was shipping span attributes unredacted; panel now coalesced too                        | `46b4b5d1ae`               |
| EOT-10 | Fresh-install sweep over all 89 parameterless GETs — the state where both shipped 400s hit                       | `2f839ef7f4`               |
| EOT-09 | Durable recovery against a real database: a crashed owner's row, re-read, not a pure predicate                   | `a1069153ab`               |
| EOT-09 | `Semaphore`/`workMap` were uncovered; `work()` dropped items after a nullable one                                | `ff7e7badc5`               |
| EOT-04 | No-silent-loss as a property over every eviction path; the three have different radius                           | `149d9745aa`               |
| EOT-02 | The bridge cannot tell a defect from an interruption; counters said every one was a failure                      | `88c404b2ca`               |
| EOT-18 | `Lifecycle<T>` had zero registered commands; the guarantee lives in `cli/bootstrap.ts`                           | `1377a04033`               |
| EOT-15 | Cross-process seq uniqueness pinned; SSE documented as _not_ a replay protocol                                   | `430b6472f4`               |
| —      | `check:spec-paths`: 22 cited files did not resolve; the rot that produced four stale claims                      | `628f69111d`               |
| EOT-03 | The replace-not-push contract pinned; the dialog host was testable after all                                     | `d0e9b0032d`               |
| EOT-20 | A test literal containing an `import` statement was rewritten by the transform                                   | `d0e9b0032d`               |
| EOT-03 | `useAbortOnCleanup` cannot guard a dialog that opens dialogs — two reverted rounds, and why                      | `29735847d4fc`             |
| EOT-03 | Owner-bound calls after an `await` gated by an AST scan; the support dialog leaked three listeners per open      | `bb29f838b8`               |
| EOT-05 | `createPromiseCache`: image and wallpaper memos bounded; a load is cancelled only once every caller has left     | `bb29f838b8`               |
| EOT-04 | `EventFeed.filtered`: sync, mobile-session and workspace SSE get the lag budget; a stalled reader is evicted     | `bb29f838b8`               |
| EOT-19 | Mobile session stream re-reads the session on reconnect, which is what heals an eviction or a dropped socket     | `bb29f838b8`               |
| EOT-00 | Never-paints root cause: RPC requests to the server worker were lost before it listened; handshake added         | `d488723211`               |
| EOT-00 | A worker that exits or never listens fails its calls instead of leaving the first bootstrap waiting              | `a9167279cf`               |
| EOT-00 | The probe records a stalled start (`hangRate`, last control sequences) instead of aborting                       | `663170478d`               |
| EOT-00 | The worker appends to the main process's log instead of truncating it                                            | `e92eac8250`               |
| EOT-00 | `repro:startup-hang`: 200 consecutive compiled starts, non-zero on any stall                                     | `c004b6ae8d`               |
| EOT-04 | Reconnect waits after a clean stream end too; jittered, abortable backoff                                        | `5b7777ba2b`               |
| EOT-08 | One shutdown budget shared by every plugin instead of five seconds each                                          | `b0ab388457`               |
| EOT-13 | Effect's built-in server span off on the bridge; `x-forwarded-for`/`referer` forbidden at the choke point        | `4fe8d73926`               |
| EOT-11 | Partial-output retry safety: no retry once text, reasoning, tool or billed step output is published              | uncommitted                |
| EOT-11 | A real 429 keeps its status and `Retry-After`; native failures stop arriving as non-retryable `UnknownError`     | uncommitted                |
| EOT-11 | A finish event without `usage` is counted and warned, so a zero-billed turn is not silently free                 | uncommitted                |
| EOT-14 | Internal definitions share the manifest, host and capability validation that only file plugins went through      | uncommitted                |
| EOT-14 | v2 command title/enabled re-read per palette open instead of frozen at registration                              | uncommitted                |
| EOT-14 | `storage` supplied as a host capability, matching the store the runtime already hands out                        | uncommitted                |
| EOT-15 | `/sync/outbox` takes an optional `aggregate` filter; the per-aggregate cursor stops forcing an over-fetch        | uncommitted                |

The last seven rows are **uncommitted**. They are listed with an explicit marker rather than a hash because no commit
exists yet, and the table's contract is that a landed row names the commit that landed it. Once committed, the marker
is what gets replaced — not the description.

Every spec has been opened and every spec now has at least one landed slice,
EOT-00, EOT-14 and EOT-19 included.

A landed slice is still not a passed release gate. What is landed is, in most
cases, the **contract** a spec turns on — the delivery-class table, the auth
transition table, the input-precedence order, the plugin manifest, the
permission audit — written as data with a test that fails when it changes. The
migrations those contracts exist to govern (EOT-11's adapter convergence,
EOT-19's bridge, EOT-06's measured heights, EOT-07's controller extraction)
remain the multi-PR work this roadmap scopes them as.

What these slices are not. EOT-11, EOT-14 and EOT-15 remain the L/High
migrations this roadmap scopes across several separately verified PRs. EOT-11
has its adapter seam covered, not the AI SDK to `LLMEvent` convergence; EOT-15
reports a compacted-range replay, it does not implement the snapshot barrier;
EOT-06 has its pure windowing math pinned, while measured row heights and
anchor-preserving scroll want a real terminal rather than a headless run.

The 2026-09-20 rows carry a theme worth stating on its own: **three of them started as a test
failure that looked like flakiness and turned out to be a defect in shipped code.** The eight
`local-account-session` failures were `Flag` constants capturing `process.env` at first import;
the `mobile-pairing-listener` timeout was an `npx` with no deadline on a request path; and the
`BYTE_BUDGET` slice began as a passing test over a check that would have disconnected every
session past eight megabytes. A suite that is red in one run mode and green in another is
reporting a difference, and the difference is worth bisecting before it is worth retrying.

EOT-14's runtime was audited without a change being warranted: reload passes are
serialized through a promise chain in `schedule`, and `deactivatePluginEntry`
does not mutate `state.plugins`, so the index `swapPluginEntry` captures across
its await stays valid. EOT-19's two highest-risk points were also checked and
hold: the router logs `pathname`, so a `?token=` never reaches the log, and the
websocket upgrade runs inside `dispatch`, behind the same `Auth.authenticate`
as every HTTP route.

## Domain Adoption Map

The inspected hotspots establish the architecture, not an exhaustive defect audit of every backend directory. Apply these
specs to adjacent domains in measured slices; first read each domain's current implementation and tests. Existing correct
Effect services remain unchanged unless a concrete ownership, error, or performance gap is demonstrated.

| Domain family                                        | Applicable specs                               | First question before implementation                                                      |
| ---------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Account/auth/config/permission/question              | EOT-02, EOT-03, EOT-10, EOT-12, EOT-17         | Do validation, abort, identity state, and typed failure survive producer-to-UI transport? |
| Session/provider/tool orchestration                  | EOT-02, EOT-04, EOT-09, EOT-10, EOT-11, EOT-15 | Are service crossings, streaming order, token accounting, and terminal outcomes explicit? |
| Background/delegation/monitor/loop/mission/scheduler | EOT-02, EOT-04, EOT-09, EOT-13                 | Who owns accepted work after disconnect, and how is completion committed?                 |
| Project/workspace/worktree/sync/database             | EOT-02, EOT-04, EOT-05, EOT-09, EOT-15, EOT-16 | Are contexts isolated, replay consistent, and transaction/cache lifetimes bounded?        |
| File/LSP/MCP/plugin/connectors                       | EOT-02, EOT-03, EOT-08, EOT-09, EOT-14, EOT-17 | Do watchers, subprocesses, client pools, and config reloads release at the correct scope? |
| Browser/computer/PTY/image/voice                     | EOT-03, EOT-06, EOT-08, EOT-09, EOT-19         | Can cancellation release native resources and stop late frame/result delivery?            |
| Analytics/observability/brain/profile                | EOT-01, EOT-05, EOT-09, EOT-10, EOT-13         | Is collection bounded, privacy-preserving, and off the interaction-critical path?         |
| Share/artifact/mobile/remote/companion integration   | EOT-04, EOT-08, EOT-10, EOT-12, EOT-15, EOT-19 | Do transport capabilities, payload limits, redaction, and generated contracts agree?      |
| CLI command dispatch / daemon lifecycle              | EOT-02, EOT-08, EOT-18                         | Is the command shape consistent, the bootstrap shared, and headless posture fail-closed?  |
| Test infrastructure / harnesses                      | EOT-01, EOT-20                                 | Are layers separated, fixtures deterministic, and races resolved with barriers?           |

Unsupported or unmeasured domains are not scheduled for speculative rewrites. Prioritize a failing correctness invariant
over the tier order, then return to the dependency gates; record the evidence and revised slice scope in the relevant spec.

## Verification and Promotion

Run commands from the stated package through Bun; use `monitor` for tests, typechecks, builds, and codegen.

| Change surface             | Required evidence                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Documentation only         | Markdown format check, local-link/source-reference validation, dependency DAG/coverage checks, read-back                    |
| Runtime/service            | Narrow `packages/nikcli/test/effect` and changed domain tests; interruption and finalizer assertions                        |
| TUI lifecycle/state/render | Matching `packages/nikcli/test/tui` tests, real OpenTUI frame assertions, PTY interaction when behavior changes             |
| HTTP contract              | `bun run generate:httpapi-clients`, `bun run check:routes`, affected server/client tests, tracked generated output reviewed |
| Bridge protocol            | Bridge contract round-trip + capability gating + watermark/snapshot barrier; client and server integration tests            |
| Identity / auth            | State-machine matrix + controlled local issuer; redaction tests; no skipped onboarding                                      |
| Observability              | Schema-validated spans/metrics/logs; redaction fuzz; live panel bounded; OTLP smoke against local collector                 |
| Plugin v2                  | Manifest validation; capability denial; reload concurrency; storage scoping; v1 coexistence                                 |
| Workspace / sync           | Concurrent isolation; hot switch determinism; barrier end-to-end; multi-device ordering                                     |
| CLI host/startup           | `bun run smoke:standalone` in `packages/tui`; `bun run smoke:tui` and compiled startup probe in `packages/nikcli`           |
| Mobile/companion           | JWT round-trip; websocket reconnect; PTY bounded; teleport chunked resume; multi-device ordering                            |
| Sandbox/permission         | Coupling respected; sandbox containment; headless posture fail-closed; redaction tests                                      |
| Any implementation slice   | One final root `bun run typecheck` after edits, serialized via the existing root script; affected formatting/lint checks    |
| Release-sized integration  | Local `bun run test:ci` in `packages/nikcli`, relevant compiled build/smokes, existing CI remains blocking                  |

Do not run root `bun test`: the root script intentionally fails. Do not run repeated typechecks during editing on a
low-memory machine. A passing typecheck is not proof of cancellation, replay, focus restoration, rendering correctness,
identity state, observability, or bridge correctness. Keep raw exit codes, pass/fail counts, fixture parameters, and
performance samples with the implementing PR.

## Migration and Rollback Policy

- Ship one authoritative path per domain. Temporary comparison may duplicate pure projection, never tool execution,
  network mutation, database writes, or permission evaluation.
- Reuse an existing feature flag where appropriate, especially message virtualization, plugin v1→v2 selection, and
  observability per-route group. New flags need a schema-backed default, tests in both states, a removal criterion,
  and EOT-10 review; do not invent undocumented environment switches.
- Rollback swaps an adapter or disables an optimization, not the safety checks. Capacity overflow must remain visible.
- Storage changes are additive and separately approved; no deletion of user data, accounts, audit history, snapshots,
  workspace state, plugin storage, or old compatibility fields as part of performance, identity, observability, or
  bridge work. Preserve downgrade considerations and stop before production/database operations.

## Deferred Choices

Do not adopt a new global state framework, a browser virtualizer, Effect SQL, Effect AI/CLI, distributed actors, or an
OpenTUI fork merely because the APIs exist. Reconsider only with a measured bottleneck, a compatibility case, and a
separate decision. Effect SQL had a spec proposing exactly this adoption — `specs/storage/effect-sqlite-package.md`,
**retired 2026-09-21** — and three separate things closed it rather than one: upstream published
`drizzle-orm/effect-sqlite-bun`, so the vendoring it described is moot; the measurement it was waiting for came back the
other way, with Effect at the repository boundary costing 0.5µs a query against the driver swap's 9µs; and the
retirement it existed to unblock ([storage/retire-database-wrapper.md](storage/retire-database-wrapper.md)) finished
groups 1-4 without it. Non-negotiable decision 3 still forbids an alternate database layer standing beside the current
one, so a future proposal starts from that clause, not from the retired document. Renderer worker/thread defaults, authentication policy, plugin trust, telemetry export defaults,
and CLI headless posture are not changed by this roadmap. No new mandatory external infrastructure or paid service
is required.
