# EOT-01: Performance and Verification Baseline

Status: proposed. Tier: 1. Phase: P0. Dependencies: none.
Owner: performance/test maintainers across both packages. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B10, B16, B17 in the [register](../README.md): real startup and render-churn harnesses already exist.
`packages/nikcli/script/tui-startup.ts` now records bootstrap separately from warm/cold samples and prints nearest-rank
min/median/p95/max plus the raw series, including child RSS when the host can read it. Candidate budgets below are still
unratified: a printed percentile is not an approved gate. Raising FPS or lowering a debounce without a collected baseline
is not an optimization.

## Scope and Non-Goals

Extend existing scripts and tests with reproducible measurements, resource counters, and fail-sensitive comparisons.
EOT-20 owns the harness layers these measurements run in; this spec owns the budgets and the comparison format.
No renderer rewrite, new benchmark dependency, remote telemetry requirement, or full-suite CI addition. Documentation
completion does not imply that this baseline has been collected; the implementation phase must collect it.

## Design and Requirements

1. Record source revision or dirty-tree fingerprint, Bun/dependency versions, OS/architecture, CPU/RAM, terminal, screen
   size, enabled features, host mode, dataset hash, and instrumentation mode. Keep local paths and content out of shared logs.
2. Separate process start, first printable frame, first usable prompt, essential-data readiness, and full optional-data
   readiness. A loading splash is not an interactive prompt; `--help` is not a TUI-startup benchmark.
3. Collect at least 30 warm startup samples after one discarded warmup, and 10 isolated fresh-home samples. Report
   min/median/p95/max and all samples; use nearest-rank p95 and label the small cold-start sample as descriptive only.
   Record migration/bootstrap time separately, not as a hidden discarded failure.
4. Alternate baseline/candidate runs on the same machine with identical fixtures, without other heavy checks running.
   A same-revision A/A comparison establishes noise. If variability exceeds the proposed tolerance, fix the harness or
   document a repeatable workload before accepting a performance claim; do not rerun until a lucky sample appears.
5. Measure input-to-painted-frame latency, per-flush reduction time, frame interval, JS heap, process RSS, mounted rows,
   listener/timer/fiber counts, event bytes/depth/age, request concurrency, and persistence duration. Distinguish retained
   JS objects from native renderer and allocator memory; a heap plateau alone does not establish RSS stability.
6. Reuse `packages/nikcli/src/observability/` and TUI runtime samples. Use fixed-cardinality dimensions such as event class,
   host mode, and operation; no session IDs, prompts, tokens, URLs with credentials, or arbitrary paths in metric labels.
   Keep diagnostic logs in the existing redacted sink, never raw stdout over the TUI.

## Workload Matrix

| Workload        | Fixture and sequence                                                                       | Required observations                                         |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Startup         | Embedded and standalone, fresh/warm state, 80x24 and 160x48                                | First paint, usable prompt, request count, RSS                |
| Streaming       | 10,000 stored turns, 100 small text deltas/second for 60 seconds, interleaved tool updates | Exact text, p95 input latency, mounts/destroys, frame timings |
| Burst/recovery  | 10,000 mixed events with a deliberately stalled reader                                     | Peak bytes/depth, terminal-event fidelity, reconnect recovery |
| Session hopping | 100 visits across 50 sessions; revisit active/pinned sessions                              | Cache residency, queries, stale writes, resource plateau      |
| Lifecycle       | 100 dialog open/close and 100 plugin reload cycles                                         | Owned timers/listeners/resources return to baseline           |
| Input/layout    | Paste 100 KB, resize 80x24 to 160x48 and back, keyboard-only navigation                    | Draft fidelity, clipping, anchor and focus behavior           |
| Jobs            | Multiple short and output-heavy local child processes under cancellation                   | Admission limits, log bounds, persisted terminal states       |

Use deterministic generated fixtures and real local adapters/renderers, not placeholder implementations. Authentication
protocol tests may use a controlled local HTTP issuer; no real sign-in or paid provider calls are needed for this matrix.

## Candidate Budgets

These are proposed acceptance thresholds, not measured current performance. P0 must validate feasibility and record the
approved values before optimization starts. A later threshold change requires an explicit decision and evidence, not a
silent edit after a failed check. Correctness/resource bounds below are non-negotiable even if latency targets change.

| Metric                        | Candidate gate                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Warm usable-prompt p95        | No more than 10% above baseline; startup-focused slices target at least 15% median improvement                                              |
| Key-to-paint p95 under stream | At most 50 ms on the recorded reference machine; report slow-terminal output time separately                                                |
| Event reduction flush p95     | At most 8 ms; sustained overload must yield to input rather than form one huge batch                                                        |
| Render cadence                | At current 45 FPS cap, p95 frame work below 22.2 ms under the reference stream                                                              |
| Idle                          | No application-owned polling after documented required heartbeat work is excluded; no more than 2 CPU percentage points above idle baseline |
| Retained resources            | Zero residual owner-scoped listeners/timers/fibers after deterministic teardown completion                                                  |
| Repeated lifecycle RSS        | Last 20-cycle median no more than 10% above post-warmup median; report absolute bytes and native allocations                                |
| Queue/cache bounds            | Configured count and byte ceilings never exceeded; overload and recovery counters must change in the overload test                          |
| Instrumentation overhead      | Median hot-path duration within 5% of instrumentation-off run; otherwise keep detailed probes test-only. EOT-13 is held to this budget      |

## Failure and Cancellation

Timeout, missing first frame, child crash, missing samples, schema-invalid metric output, unavailable terminal capability,
or incomplete teardown must produce a non-zero check result. Label unsupported scenarios separately; they cannot count
as passes. Benchmark cancellation must kill/reap owned children and restore the terminal; never leave hidden workload
processes running. Do not interpret swallowed errors, empty arrays, or absent metric records as a zero-cost success.

## Acceptance and Verification

- A deliberately delayed input handler fails the latency gate; an intentionally retained test listener fails the resource
  assertion. Use reversible fault injection confined to the test, not committed production defects.
- All compared runs contain the same workload counts and end-state digest. A faster run that processed fewer events fails.
- Store raw samples, summary statistics, baseline identity, and environment with the PR. Claim improvement only for measured
  scenarios; a microbenchmark does not establish end-to-end speed.
- Extend `packages/nikcli/test/tui/runtime-samples.test.ts`, `packages/nikcli/test/tui/streaming-churn.test.tsx`,
  `packages/nikcli/test/tui/streaming-cost.test.ts`, and the existing startup/smoke scripts rather than adding a second harness.
- Existing entry commands, from `packages/nikcli`: `bun test test/tui/runtime-samples.test.ts`,
  `bun test test/tui/streaming-churn.test.tsx`, `bun test test/tui/plugin-dispose.test.ts`,
  `bun test test/server/event-feed.test.ts`, and `bun run bench:startup <compiled-binary-path>`.
  The binary argument is required and must refer to a real build. `WARM_RUNS` (alias `RUNS`) defaults to 30;
  `COLD_RUNS` defaults to 10. These commands still do not implement every matrix workload or ratify budgets.

## Migration and Rollback

First add measurement without changing runtime behavior, then freeze a baseline, then promote one budgeted slice at a time.
Do not weaken existing churn limits when adding broader fixtures. Roll back intrusive production instrumentation if its
cost exceeds budget, retain test-only probes and raw results, and keep existing observability export defaults unchanged.

## Discipline Addendum — 2026-09-20

Lifecycle counters landed (`packages/nikcli/src/effect/lifecycle-counters.ts`, commit `644a8f28`), wired into `InstanceScope` and the runtime bridge. Four rules came out of building them.

1. **A counter with no emitter is anti-evidence.** It reads as "measured, none" when it means "never measured", and nothing in the type system says which. A key is therefore added together with the call site that increments it, never ahead of one. `runtime.bridge.stale-result` was declared and removed again on exactly this ground: a result arriving after its consumer is gone is only observable where the consumer is, which is the TUI lifecycle work in `03-tui-lifecycle.md`, not this bridge.
2. **Count each outcome once, and count it where the caller can see it.** A cancellation passes through two places — the canceller, and the Exit that interrupting the inner fiber produces — so incrementing in both booked every cancel twice. Counting only at the Exit fixes the double count but moves the increment two promise hops later, and a caller that interrupts and then reads the counter sees nothing. The cancellation is therefore counted synchronously in the canceller, and the Exit handler skips what `cancelled` already recorded. `test/effect/lifecycle-counters.test.ts` asserts `toBe(1)`, not `toBeGreaterThanOrEqual(1)`, because only the exact count catches the regression.
3. **`scope.failed` is not `scope.interrupted`.** A scope whose instance bootstrap threw never ran its effect; folding it into the interrupt bucket hides a broken instance inside a number that normally means "the user pressed Ctrl+C".
4. **`scope.finalizer-leak` is a watchdog, not a guess.** `InstanceScope.with` promises that interrupting the caller waits for the inner fiber's finalizers. A finalizer that never returns breaks that promise with no other symptom in the process, so the canceller arms an unref'd `FINALIZER_GRACE_MS` timer and counts the leak if the Exit has not arrived. Unref'd deliberately: an outstanding leak must not itself keep Bun alive.

Counters are module state. `bun test` shares one module registry across a run, so a test that reads them resets in `beforeEach`, not only in `afterEach` — otherwise it inherits whatever an earlier file in the run left behind.
