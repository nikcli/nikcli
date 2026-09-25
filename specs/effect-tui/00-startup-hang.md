# EOT-00: Intermittent Never-Paints Startup

Status: proposed. Tier: 1. Phase: P0. Dependencies: none.
Owner: TUI host/renderer maintainers. [Roadmap](../ROADMAP.md).

This spec gates every other promotion in the program. It exists because the defect below was recorded only as
prose inside EOT-01's first slice, where nobody reading the prioritized table would see it, and because the
repro harness that entry claimed had landed (`repro:startup-hang`) never existed in the repository. The spec was
first drafted on a review branch that was never merged; this is that draft, re-checked against the current tree.

## Problem and Evidence

On 2026-09-12 the compiled binary was observed to **intermittently never paint** — roughly one startup in three
to eight, reproduced repeatedly at the same load as runs that finished in 4.5-5.8s, so not contention.

A hung instance was sampled. Its last output before going silent is the terminal capability negotiation
`@opentui/core` performs at renderer creation: OSC 10/11 and OSC 4 colour queries, XTGETTCAP, the OSC 99
notification probe, the iTerm2 OSC 1337 feature query, the Kitty graphics query `ESC_Gi=31337`, and the OSC 66
text-sizing probes. Then nothing, for as long as it is left running, with the main thread parked in `kevent64`
— idle, waiting for an event, not spinning. The startup blocks on replies a terminal is supposed to send.

Two things that look like workarounds are not: `--print-logs` appears to fix it but only defeats the probe's
"has it painted" threshold, because the log text itself crosses it; and forcing `OPENTUI_GRAPHICS` /
`OPENTUI_NOTIFICATIONS` / `OTUI_PALETTE_IDLE_TIMEOUT_MS` still hangs, with the same query block as the last output.

Two structural observations, re-checked 2026-09-24:

- `createCliRenderer` is awaited with no deadline (`packages/tui/src/app.tsx:207`). The adjacent theme probe
  already has one (`waitForThemeMode?.(1000)`, `:216`) and the palette query is deliberately fire-and-forget
  (`:215`). The capability negotiation inside `createCliRenderer` has neither.
- The probe cannot count the failure. `packages/nikcli/script/tui-startup.ts:208` throws `never painted`, so a
  single wedged sample aborts the entire 30-run warm collection rather than being recorded as an outcome.

The existing `patches/@opentui%2Fcore@0.5.11.patch` is unrelated: it keeps streaming code highlights, and does
not touch renderer creation.

No commit between 2026-09-12 and 2026-09-24 claims a fix, and none has been measured. Whether the defect still
reproduces on the current binary is the first thing this spec establishes, not an assumption in either direction.

## Scope and Non-Goals

In scope: a deterministic reproduction, a `hangRate` metric, a deadline and conservative fallback for terminal
capability negotiation, and — if the cause is upstream — a pinned patch of `@opentui/core@0.5.11` through the
existing `patches/` mechanism guarded by `script/check-patched-deps.ts`. Check how upstream opencode, which
shares the renderer, configures the same negotiation before writing a local fix.

Out of scope: the 4.8-5.2s firstPaint median and 500-620MB RSS (EOT-08 and EOT-01 own those), any renderer
rewrite, an OpenTUI fork, and any change to renderer worker/thread defaults.

## Design and Requirements

1. **Count it before fixing it.** The probe records `{painted, hung, hangRate}` per run and never throws on a
   wedged sample. A run that hangs is data, not an aborted collection. `hangRate` appears in the JSON that
   `bench:startup` emits and in the `BASELINE` comparison.
2. **Reproduce on demand.** A harness spawns the compiled binary under a PTY that deliberately never answers
   capability queries, and asserts the startup still paints. This is the smallest deterministic form of the
   defect and does not depend on catching the intermittent case.
3. **Deadline the negotiation.** Terminal capability negotiation gets a bounded wait. On expiry the renderer
   starts with a conservative capability set (no Kitty graphics, no OSC 99 notifications, no OSC 66 text
   sizing) rather than waiting for a reply that is not coming. A capability that could not be negotiated is
   reported as absent, never assumed present.
4. **Do not paper over it.** Raising the probe's paint threshold, enabling `--print-logs`, or averaging over
   the samples that did paint are all forbidden as resolutions. Each certifies a startup that sometimes does
   not happen.
5. **Fix upstream if it is upstream.** If the block is inside `@opentui/core`, land a patch under `patches/`
   and keep `script/check-patched-deps.ts` green; record the upstream issue so the patch has a removal criterion.

## Release Gate

- `hangRate == 0` over **200 consecutive compiled starts** across a PTY matrix of at least: `xterm-256color`,
  inside `tmux`, Ghostty, and an unknown/minimal `TERM`. Raw per-run outcomes attached to the PR.
- The non-answering-PTY harness from requirement 2 passes, and fails if the deadline is removed.
- `bench:startup` emits `hangRate` and a wedged sample no longer aborts the collection.
- EOT-01 startup budgets may be ratified only after this gate passes.

## Rollback

The deadline is a bounded wait around existing negotiation, so rollback restores the unbounded await and the
recorded `hangRate` immediately shows the regression. The capability fallback must not be rolled back
separately: a terminal reported as capable without a reply is the defect, not the mitigation.

## Root Cause — 2026-09-24

**The capability negotiation was never the cause.** It is simply the last thing the renderer writes before the
first frame, so it is what every stalled start shows last. The stall is further in: a request from the TUI to the
embedded server worker that was **lost**, leaving the first bootstrap waiting forever.

### The mechanism

`packages/nikcli/src/cli/handlers/default.ts` constructs the server `Worker` and starts calling it through
`Rpc.client` straight away. The worker, `src/cli/cmd/tui/worker.ts`, installs its listener with `Rpc.listen` on its
last line — after a top-level `await Log.init(...)` and the whole server import graph. Upstream opencode's worker has
no top-level `await` before `Rpc.listen`; nikcli added one.

Bun delivers a message that reaches a worker while its module is suspended on a top-level `await` to no listener, and
**drops it**. Measured in isolation on Bun 1.4.2: with the listener installed synchronously, 20 of 20 early messages
arrive; with it installed after a 50 ms or 300 ms `await`, 0 of 20. `Rpc.client.call` has no timeout, so the caller
of a dropped request never settles. When that request is one the first frame waits on — `SyncProvider` renders its
children only once its bootstrap leaves `loading` — the frame never comes. Which request is lost in a given stall was
not captured; that it is one on the first render's path is inferred from the fix, which removes the stalls.

It fits every observation recorded above. The worker takes longer to reach its listener under CPU load, which widens
the window — hence "intermittent" and load-sensitive. A sampled stalled process shows the main thread **and** the
single `Worker` thread idle in `kevent64`, at 0% CPU, with no child processes: both sides waiting for a message the
other will never send. And a stalled start does not recover: none of the stalls sampled here painted within 90 s.

### The fix

`packages/tui/src/util/rpc.ts`: `listen` posts `rpc.ready` once `onmessage` is in place, and the client holds every
request until it arrives, then sends them in call order. The request is registered as pending when it is made, so a
reply is never missed either. Because the client waits on a signal from the listener rather than on the timing of the
worker's imports, no top-level `await` anywhere in the worker's graph can reopen the window. Both sides always ship in
the same binary, so there is no version skew to handle. Serialising the input happens before the request is registered,
so an input that cannot be serialised still rejects without leaving a pending entry, as it did before.

`packages/nikcli/test/tui/rpc-error.test.ts` spawns a real `Worker` (`test/tui/fixtures/slow-rpc-worker.ts`) that
awaits 200 ms before `Rpc.listen`, and calls it at once. Before the fix the call is lost (the test's 3 s race returns
`"lost"`); after it, the call is answered.

### Measured

All on one machine (8 cores, macOS, Bun 1.4.2), compiled binaries, a PTY that never answers terminal queries, starts
interleaved so time-varying conditions fall on both binaries alike:

| Condition                                    | Before (`0.0.0-live-main-202609221720`) | After (this fix)        |
| -------------------------------------------- | --------------------------------------- | ----------------------- |
| `tmux-256color`, 4 of 8 cores busy, 40+40    | **14 of 40 never painted**              | **0 of 40**             |
| `xterm-256color`, no added load, 20+20       | 0 of 20                                 | 0 of 20                 |
| Same tree with only `rpc.ts` reverted, 30+30 | control: 0 of 30, median 4566 ms        | 0 of 30, median 3992 ms |

Unattended samples before the fix, 60 starts per `TERM`: `xterm-256color` 0, `tmux-256color` 6 (during a period of
heavy unrelated load), and a minimal unknown `TERM` 1 at a load average of 3 — so `tmux` is not required, load is what
widens the window. The handshake costs no measurable startup latency: the control comparison differs by less than the
run-to-run noise on this host, in the fixed binary's favour.

### Requirement 1 is done; requirement 3 was aimed at the wrong thing

`script/tui-startup.ts` now records a stalled start instead of throwing: each stall carries its outcome
(`never-painted` / `no-prompt`) and the last control sequences the terminal was sent, reduced to request names by
`trailingControlSequences` so no screen text or path enters the report. The collection always completes, the report
carries `startup: { attempts, stalls, hangRate }`, and the probe still exits non-zero when anything stalled.

Requirement 3 (a deadline on capability negotiation) was written from the last-output evidence and does not address
this defect: every negotiation in `@opentui/core@0.5.11` is already timer-bounded (`detectOSCSupport` 300 ms, palette
queries 1200 ms, the capability window 5 s). It stays as defence in depth only if a stall is ever sampled inside the
renderer itself; none has been.

### What the gate still needs

The release gate is **not** passed by this section. 200 consecutive compiled starts across the PTY matrix is still
owed — Ghostty in particular cannot be driven from a headless PTY here — and requirement 2's never-answering-PTY
harness exists only as a scratch script, not as a checked-in check. A separate hazard seen while diagnosing: the
worker's `Log.init({ dev })` truncates the same `dev.log` the main process writes in local builds, which is why every
sampled stall had an empty log. It did not cause the hang, but it hid it.

## Gate Evidence — 2026-09-25

Two claims in the section above are out of date. Requirement 2's harness **is** checked in:
`bun run repro:startup-hang <binary>` (`c004b6ae8d`) drives `script/tui-startup.ts` through `spawnPty`
(`packages/util/src/pty.ts`), which attaches no responder, so the PTY never answers a capability query. It runs 200
warm starts plus the bootstrap start with a 30 s deadline and exits non-zero on any stall. And the matrix has now been
run against a binary built from `c5d5229e0` (`0.0.0-live-main-202609251440`, a clean tree; later probe headers read
"dirty" because the source tree moved while the same binary ran):

| Terminal                            | Starts | Stalls | Warm firstPaint median / p95 / max | Load (start → end) |
| ----------------------------------- | ------ | ------ | ---------------------------------- | ------------------ |
| `TERM=xterm-256color`               | 201    | 0      | 4086 / 7360 / 7619 ms              | 2.58 → 3.32        |
| `TERM=tmux-256color`, `TMUX` set    | 201    | 0      | 4274 / 14972 / 27646 ms            | 1.73 → 3.02        |
| `TERM=nikcli-unknown` (no terminfo) | 201    | 0      | 3118 / 4530 / 7591 ms              | 2.72 → 2.35        |

**603 compiled starts, `hangRate` 0 on each row**, in the non-answering PTY, on one macOS arm64 host with 8 cores.

What that does and does not establish:

- **`tmux` is emulated, not real.** tmux is not installed on this host. `@opentui/core` forwards `TMUX` to its native
  renderer (`DEFAULT_FORWARDED_ENV_KEYS`), so the row sets both `TERM` and `TMUX`. It shows the renderer's tmux path does
  not stall. It does not exercise a tmux server in between.
- **The tmux row ran under extra load, by accident rather than design:** a root typecheck and the `test/server/`
  suite overlapped it. That is harsher for this defect, whose window widened under CPU load, and it is also why its
  p95 and max are high. The slowest start painted at 27.6 s, 2.4 s inside the probe's 30 s deadline. Under that load
  the deadline, not the startup, is the thin margin, and a stall reported under similar load should be checked against
  it before it is read as a hang.
- **Ghostty is still owed.** It cannot be driven from a headless PTY here, so the gate's matrix is three of four rows.
  The gate stays open until it is run.
