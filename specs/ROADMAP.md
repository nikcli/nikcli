# Effect and TUI Architecture Roadmap

Status: proposed implementation program. Baseline date: 2026-09-10.
Scope: `packages/tui`, `packages/nikcli`, and the SDK/identity seams they cross. [Catalog and evidence](README.md).

## Objective

Improve responsiveness, predictable resource usage, failure propagation, observability, and maintainability while
preserving the standalone TUI, CLI/worker/HTTP/mobile modes, existing user workflows, and the current Effect/OpenTUI
pins. Deliver vertical slices with measured outcomes; do not rewrite every Promise into Effect or every Solid signal
into a service.

Twenty specifications organize the work across three horizons that match the phase column below: a correctness,
contract, and evidence baseline (EOT-01..03, EOT-10, EOT-12, EOT-13, EOT-20), a bounded data/state/isolation layer
(EOT-04, EOT-05, EOT-08, EOT-09, EOT-11, EOT-14..17), and the user-visible experience and bridge surface (EOT-06,
EOT-07, EOT-18, EOT-19). Implementation lands in dependency order, one slice at a time; each spec header carries its
own status. EOT-18 is the exception to the "proposed" framing — its parser premise shipped, and what is left there is
policy.

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

| ID                                                        | Tier | Phase | Dependencies                   | Effort | Risk   | Primary owner               | Release gate                                                        |
| --------------------------------------------------------- | ---- | ----- | ------------------------------ | ------ | ------ | --------------------------- | ------------------------------------------------------------------- |
| [EOT-01](effect-tui/01-performance-baseline.md)           | 1    | P0    | none                           | M      | Low    | Performance/test            | Reproducible measurements and failure-sensitive assertions          |
| [EOT-02](effect-tui/02-effect-boundaries.md)              | 1    | P1    | EOT-01                         | L      | High   | Effect/domain               | Typed boundary and multi-instance teardown tests                    |
| [EOT-03](effect-tui/03-tui-lifecycle.md)                  | 1    | P1    | EOT-02                         | M      | High   | TUI lifecycle               | No stale commits or surviving owner work                            |
| [EOT-10](effect-tui/10-contracts-errors-security.md)      | 1    | P1    | EOT-01                         | L      | High   | HttpApi/security            | Error/encoding/auth parity and clean generated output               |
| [EOT-12](effect-tui/12-identity-onboarding-auth.md)       | 1    | P1    | EOT-02, EOT-03, EOT-10         | L      | High   | Identity/auth/account       | Typed state machine, no PKCE downgrade, no skipped onboarding       |
| [EOT-13](effect-tui/13-observability-pipeline.md)         | 1    | P1    | EOT-01, EOT-02                 | M      | Medium | Observability/brain/profile | Fixed schema, redaction, live panel bounded                         |
| [EOT-20](effect-tui/20-testing-architecture-harnesses.md) | 1    | P1    | EOT-01, EOT-02                 | M      | Low    | Test infra                  | Three-layer harness, deterministic fixtures, no flake wins          |
| [EOT-04](effect-tui/04-event-delivery.md)                 | 1    | P2    | EOT-02, EOT-10                 | L      | High   | Transport/bus               | Bounded lag and verified recovery without silent loss               |
| [EOT-09](effect-tui/09-jobs-persistence.md)               | 1    | P2    | EOT-02, EOT-04, EOT-10         | L      | High   | Execution/storage           | Durable terminal states, concurrency bounds, recovery               |
| [EOT-11](effect-tui/11-provider-inference-streaming.md)   | 1    | P2    | EOT-01, EOT-02, EOT-10         | L      | High   | Provider/llm core           | Adapter unification, cancellation, cache, retry, token accounting   |
| [EOT-14](effect-tui/14-plugin-v2-architecture.md)         | 1    | P2    | EOT-02, EOT-03, EOT-08, EOT-10 | L      | High   | Plugin SDK/runtime          | v2 contract, hot reload, capability gating, scoped generation       |
| [EOT-15](effect-tui/15-sync-snapshots-watermarks.md)      | 1    | P2    | EOT-04, EOT-05, EOT-09         | L      | High   | Sync/mobile bridge          | Snapshot barrier, watermark, gap handling, multi-device ordering    |
| [EOT-16](effect-tui/16-workspace-isolation.md)            | 1    | P2    | EOT-02, EOT-03, EOT-09         | M      | High   | Workspace/instance          | Workspace as typed Effect scope, hot switch, isolation tests        |
| [EOT-17](effect-tui/17-sandbox-permission-boundaries.md)  | 1    | P2    | EOT-02, EOT-09, EOT-10, EOT-11 | L      | High   | Permission/sandbox/policy   | Typed ruleset, coupling respected, sandbox containment              |
| [EOT-05](effect-tui/05-reactive-state.md)                 | 2    | P2    | EOT-03, EOT-04                 | L      | High   | TUI state                   | Scoped query/state correctness and stable row identity              |
| [EOT-08](effect-tui/08-host-plugins-startup.md)           | 2    | P2    | EOT-02, EOT-03                 | M      | Medium | Host/plugins                | Standalone and compiled parity; reload resource plateau             |
| [EOT-19](effect-tui/19-mobile-companion-bridge.md)        | 2    | P3    | EOT-04, EOT-08, EOT-12, EOT-15 | L      | High   | Mobile/companion/remote     | Typed bridge, JWT, websocket, multi-device, capability gating       |
| [EOT-18](effect-tui/18-cli-command-architecture.md)       | 2    | P3    | EOT-02, EOT-08                 | S      | Medium | CLI dispatch                | Exit-code mapping, headless posture, daemon lifecycle (parser done) |
| [EOT-06](effect-tui/06-terminal-rendering.md)             | 2    | P3    | EOT-05                         | L      | High   | TUI rendering               | Streaming virtualization, anchor fidelity, measured latency         |
| [EOT-07](effect-tui/07-input-interaction.md)              | 2    | P3    | EOT-03, EOT-05                 | M      | High   | TUI interaction             | Keyboard/focus/permission matrix on real terminals                  |

Dependencies are exit gates, not permission to stall unrelated characterization tests. After P0, EOT-02, EOT-10,
EOT-12, EOT-13, and EOT-20 may characterize existing behavior in parallel, but each release gate still requires all
dependencies listed above to pass.

EOT-08 and EOT-18 need not wait for EOT-04/05/15; EOT-06, EOT-07, and EOT-19 are independent after their listed
prerequisites. Run memory-heavy verification serially even when implementation work is independent.

## Phase Exits

### P0: Establish Truth

**Status 2026-09-20: closed.** The baseline artifact exists at
`packages/nikcli/specs/perf-baseline.json` and `check:perf-baseline` gates it in
`script/ci-validate.ts`. It had not been closed because the probe never returned —
`perf-baseline.ts` finished measuring in under a second and then hung on open handles, so
no artifact could be produced. The gate enforces the machine-independent half (shape,
sample counts, lifecycle-counter balance) and deliberately does not gate wall-clock, for
the reason this section already states: a noisy baseline is not a pass either. See the P0
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

   **Not ratifiable yet, and the reason turned out to be a defect.** On 2026-09-12 the compiled
   binary was observed to **intermittently never paint** — roughly one startup in three to eight,
   reproduced repeatedly at the same load as runs that finished in 4.5-5.8s, so not contention.

   A hung instance was sampled. Its last output before going silent is the terminal capability
   negotiation `@opentui/core` performs at renderer creation: OSC 10/11 and OSC 4 colour queries,
   XTGETTCAP, the OSC 99 notification probe, the iTerm2 OSC 1337 feature query, the Kitty graphics
   query `ESC_Gi=31337`, and the OSC 66 text-sizing probes. Then nothing, for as long as it is left
   running, with the main thread parked in `kevent64` — idle, waiting for an event, not spinning.

   So the startup blocks on replies a terminal is supposed to send. Two things that look like
   workarounds are not: `--print-logs` appears to fix it but only defeats the probe's
   "has it painted" threshold, because the log text itself crosses it; and forcing
   `OPENTUI_GRAPHICS` / `OPENTUI_NOTIFICATIONS` / `OTUI_PALETTE_IDLE_TIMEOUT_MS` still hangs, with
   the same query block as the last output.

   Fix the hang before ratifying anything. A budget averaged over the samples that _did_ paint
   certifies a startup that sometimes does not happen. Two observations stand regardless: warm
   firstPaint sits around 4.8-5.2s median with RSS around 500-620MB, and `firstPaint` and
   `usablePrompt` differ by under a millisecond in every sample, so on this binary the second metric
   carries no information the first does not.

   Fix the hang first; the baseline is a measurement of it until then. Two observations stand
   regardless: warm firstPaint sits around 4.8-5.2s median with RSS around 500-620MB, and
   `firstPaint` and `usablePrompt` differ by under a millisecond in every sample, so on this binary
   the second metric carries no information the first does not.

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
10. EOT-11: unify the AI SDK → LLMEvent adapter on one provider and one session path; verify byte-identical output.
11. EOT-14: migrate one internal plugin (`background`) to v2; verify hot reload with late disposer and incompatible manifest.
12. EOT-15: land the snapshot barrier on `session` first, then extend to `project` and `workspace`.
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

| Spec   | What landed                                                                                                      | Commit                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------- |
| EOT-01 | One probe-environment block shared by both probes; `loadavg1` added                                              | `dc3cab7fd`                                             |
| EOT-01 | Probe progress moved to stderr; `BASELINE` comparison with an opt-in regression gate                             | working tree                                            |
| EOT-01 | `repro:startup-hang`: the intermittent never-paints startup, reproduced on demand                                | working tree                                            |
| EOT-02 | `runService` requirement typing; `any` and the cast removed                                                      | `3ec56934`                                              |
| EOT-02 | `runPromiseWithLayer` requires `R extends ROut`; four latent missing-service runs fixed                          | working tree                                            |
| EOT-03 | `useAttempts`: supersession guard for restartable dialog flows                                                   | `4495840e1`                                             |
| EOT-03 | `attempt.adopt`: a resource acquired by a superseded attempt is released, not leaked                             | working tree                                            |
| EOT-04 | Queue depth meter; refetch on reconnect instead of resuming into a gap                                           | `3ec56934`, `4a767a5f9`                                 |
| EOT-04 | Delivery-class registry on the event declaration, ahead of admission caps                                        | working tree                                            |
| EOT-04 | Per-connection frame and byte accounting, including server-generated frames                                      | working tree                                            |
| EOT-05 | Optional bootstrap requests settle; `sync.degraded` replaces a pinned `partial`                                  | `12d8ef764`                                             |
| EOT-05 | Replay equivalence verified: a snapshot reaches the same state as a cold journal                                 | working tree                                            |
| EOT-06 | Windowing math pinned by tests, including two properties                                                         | `92dc72d2a`                                             |
| EOT-06 | Windowing heights derived per turn from content instead of a flat constant                                       | working tree                                            |
| EOT-07 | Ctrl+C asks the renderer for focus instead of a source string and a missing DOM                                  | `2744425ad`                                             |
| EOT-07 | Input precedence as an ordered table: modal > editable > route > application                                     | working tree                                            |
| EOT-08 | Import-cost probe; one dialog moved off the critical path against a measured delta                               | `a9725f1d7`                                             |
| EOT-08 | Four more dialogs off the critical path: eager set 3344ms -> 1552-2003ms                                         | working tree                                            |
| EOT-09 | `isTerminal`/`canTransition` for background-run outcomes                                                         | `3ec56934`                                              |
| EOT-09 | Post-commit publication moved from an ambient queue to the transaction's `ctx`                                   | working tree                                            |
| EOT-10 | Standalone and CLI hosts stop turning a config failure into an empty config                                      | `3ec56934`, `67a2b811b`                                 |
| EOT-10 | Open-payload inventory pinned per file; a new `Schema.Unknown` fails a test                                      | working tree                                            |
| EOT-11 | `suppressEmptyTextResult` covered: a rejection still reaches an awaiting caller                                  | `9483b4645`                                             |
| EOT-11 | A whole native turn pinned as one ordered processor sequence                                                     | working tree                                            |
| EOT-12 | Onboarding retry bounded; typed `incomplete` outcome instead of a parked startup                                 | `a6b1c758c`                                             |
| EOT-12 | Auth lifecycle as a legal-transition table, shared contract for server and TUI                                   | working tree                                            |
| EOT-13 | `span-schema.ts`: fixed attribute schema, forbidden segments, redact-then-truncate                               | `3ec56934`                                              |
| EOT-13 | Span `statusMessage` redacted; `nku_` and opaque bearer tokens added to the redactor                             | working tree                                            |
| EOT-14 | v2 manifest is the v1/v2 discriminator; host-range and capability checks at load                                 | working tree                                            |
| EOT-14 | Per-plugin activation budget: one wedged `setup` no longer holds the whole startup                               | working tree                                            |
| EOT-15 | `detectSequenceGap`: a replay resuming across a compacted range is now reported                                  | `34ed8b55a`                                             |
| EOT-15 | A projection replayed across a hole is no longer persisted as a snapshot                                         | working tree                                            |
| EOT-16 | LSP and provider refreshes scoped to the active workspace                                                        | `41b718d16`                                             |
| EOT-16 | Session directory survives a remote workspace target; corrupt records stop reading as missing                    | working tree                                            |
| EOT-17 | Precedence corrected to the shipped contract; ordering guarded by a test                                         | `3ec56934`, `67a2b811b`                                 |
| EOT-17 | Every permission decision audited with the rule that produced it; denials at info                                | working tree                                            |
| EOT-18 | Command-surface gate restored and repointed                                                                      | `f5783a970`                                             |
| EOT-18 | `cmd()` takes `bootstrap`/`teardown`; teardown runs in a finally without masking the handler                     | working tree                                            |
| EOT-19 | Per-device capabilities the bridge advertises; an unknown scope grants nothing                                   | working tree                                            |
| EOT-20 | Test layers made disjoint; barrier helpers; one flaky test migrated to a barrier                                 | `3ec56934`, `4035590e2`                                 |
| EOT-20 | `preserveTestEnv` discipline enforced: a module-scope `NIKCLI_*` write fails a test                              | working tree                                            |
| EOT-01 | Lifecycle counters on the bridge; a cancel counted once, synchronously, and a finalizer-leak watchdog            | `644a8f28`                                              |
| EOT-02 | Bridge exits classified; two `WorkspaceRef`s on one directory torn down without interleaving                     | `644a8f28`                                              |
| EOT-04 | `BYTE_BUDGET` enforced **per frame**; a lifetime budget would evict every healthy long-lived reader              | `644a8f28`                                              |
| EOT-10 | Open-payload gate in CI, keyed by declaration text so an unrelated edit above a site is not a failure            | `644a8f28`                                              |
| EOT-12 | Typed account state machine + guard; the empty privileged-route list is the finding, with evidence               | `644a8f28`, `6d880fc3`                                  |
| EOT-12 | Verifier env read at call time: 8 "flaky" auth tests were `Flag` constants captured at first import              | `48344aa4`                                              |
| EOT-13 | Span-schema gate; bounded telemetry consumer; the brain span moved onto a runtime that has the layer             | `644a8f28`                                              |
| EOT-14 | Plugin-v2 gate: manifest exports, the tags consumers catch on, and autoload as a hard opt-in                     | `644a8f28`                                              |
| EOT-16 | Workspace-isolation gate, including the bridge comment that records the open B31 sharing gap                     | `644a8f28`                                              |
| EOT-17 | Network egress accounted (45 modules) rather than choked through a layer nothing routes through                  | `644a8f28`                                              |
| EOT-19 | `/mobile/bootstrap` probes bounded and de-networked: 8s+ -> 950ms on the app's connect path                      | `d1e2f99e`                                              |
| EOT-20 | `withFixture` as the shared harness; both new gates driven by tests that make them fail                          | `644a8f28`, `6d880fc3`                                  |
| EOT-12 | Flag capture-at-import is a CI gate, not four fixes; the legacy-credential pair moves together                   | `ac52fff3`                                              |
| EOT-20 | TUI tests already lived in `packages/nikcli/test/tui` (55 files); a duplicate directory removed, `adopt` covered | `995fff77ba`                                            |
| EOT-01 | P0 closed: the probe never returned, so no baseline existed; artifact + gate now in CI                           | `7376aed1e1`                                            |
| EOT-13 | Redaction fuzz: camelCase keys, `:`/space/`                                                                      | ` separators, URL userinfo and glued tokens all escaped | `936ae2289a06` |
| EOT-13 | OTLP smoke: the exporter was shipping span attributes unredacted; panel now coalesced too                        | `46b4b5d1ae`                                            |
| EOT-10 | Fresh-install sweep over all 89 parameterless GETs — the state where both shipped 400s hit                       | `2f839ef7f4`                                            |
| EOT-09 | Durable recovery against a real database: a crashed owner's row, re-read, not a pure predicate                   | `a1069153ab`                                            |
| EOT-09 | `Semaphore`/`workMap` were uncovered; `work()` dropped items after a nullable one                                | `ff7e7badc5`                                            |
| EOT-04 | No-silent-loss as a property over every eviction path; the three have different radius                           | `149d9745aa`                                            |
| EOT-02 | The bridge cannot tell a defect from an interruption; counters said every one was a failure                      | `88c404b2ca`                                            |
| EOT-18 | `Lifecycle<T>` had zero registered commands; the guarantee lives in `cli/bootstrap.ts`                           | `1377a04033`                                            |
| EOT-15 | Cross-process seq uniqueness pinned; SSE documented as _not_ a replay protocol                                   | `430b6472f4`                                            |
| EOT-03 | `useAbortOnCleanup` cannot guard a dialog that opens dialogs — two reverted rounds, and why                      | `29735847d4fc`                                          |

Every spec has been opened and every spec now has at least one landed slice,
EOT-14 and EOT-19 included.

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
separate decision. [storage/effect-sqlite-package.md](storage/effect-sqlite-package.md) proposes exactly this adoption
and is therefore **blocked by this clause**: it needs the measured bottleneck and the separate decision before its first
PR, and non-negotiable decision 3 forbids an alternate database layer standing beside the current one. The retirement it
was written to unblock ([storage/retire-database-wrapper.md](storage/retire-database-wrapper.md)) does not depend on it
for group 1 or group 2, which is why those run first. Renderer worker/thread defaults, authentication policy, plugin trust, telemetry export defaults,
and CLI headless posture are not changed by this roadmap. No new mandatory external infrastructure or paid service
is required.
