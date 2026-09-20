# EOT-04: Event Delivery and Recovery

Status: proposed. Tier: 1. Phase: P2. Dependencies: EOT-02, EOT-10.
Owner: bus/server transport and TUI SDK maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B05, B06, B13, B19: the server already encodes an event once and bounds lag in frames; the TUI has an uncapped
array and manual reconnect loop. The durable sync journal has per-aggregate sequences, but global envelopes do not carry
a universal replay cursor. The missing architecture is an end-to-end delivery policy, not replacing everything with PubSub.

## Scope and Non-Goals

Bound event memory, preserve ordering and critical outcomes, isolate subscribers, and recover truthfully after disconnect.
Keep HTTP SSE and embedded worker semantics aligned. Do not promise exactly-once delivery, reinterpret wake dedup as durable
acknowledgement, add a second event journal, or change all existing best-effort Bus callers into failing writes.

## Design and Requirements

1. Maintain an explicit event-class registry with payload identity, scope key, order requirements, replayability, and
   coalescing rules. Validate at the transport boundary using the canonical schema; do not trust casts of unknown envelopes.
2. Use one client admission/flush coordinator, shared by HTTP and worker adapters. Merge the current SDK and sync batching
   only after tests preserve ordering and identity. Limit each drain by item count and elapsed work, yield to input, then
   resume. A Solid `batch` is not a scheduler and must not contain an arbitrarily large backlog.
3. Preserve server encode-once fan-out. Add byte accounting alongside frame counts, including locally generated frames.
   Candidate initial limits for P0 ratification: 4096 frames and 8 MiB per connection/admission queue, maximum 1 MiB inline
   event. Oversized existing event producers must be inventoried before enabling limits; use paged/reference fetches or
   explicit disconnect/resync, never silent truncation. Do not repeatedly stringify the same event for each subscriber.
4. A slow subscriber cannot block healthy subscribers or domain persistence indefinitely. Effect `Queue.bounded`/
   `PubSub.bounded` provide backpressure only where producers can suspend safely; never block the main publisher on a
   stalled UI. Keep connection eviction for non-cooperative readers. Sliding/dropping strategies are legal only for
   explicitly lossy derived snapshots, not ordered deltas or user decisions.
5. Include instance/workspace/session identity in queue, dedup, and recovery keys. Keep the existing wake LRU bounded and
   test that different workspaces do not share a dedup key. Completion delivery is not equivalent to successful persistence.
6. Isolate subscriber failure so one callback cannot prevent other registered consumers from receiving an accepted event.
   Log a sanitized defect, mark affected projections stale, and recover them; do not continue claiming a healthy projection.

## Delivery Classes

| Class                                    | Policy                                                                             | Overflow response                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Text/entry deltas and ordered mutations  | Preserve order; concatenate only identical-target deltas with equivalent semantics | Mark stale, stop applying affected stream, recover from authoritative state          |
| Permission/question requests and answers | Never silently drop or coalesce different requests                                 | Visible resync barrier; refresh authoritative pending set before interaction resumes |
| Job terminal states and deletions        | Preserve identity and terminal ordering; duplicate processing must be safe         | Refresh authoritative state; never infer completion from missing events              |
| Replaceable status/progress snapshots    | Latest per scope/entity/version if producer guarantees replacement semantics       | Count coalescing and retain latest snapshot                                          |
| Heartbeats/connection metadata           | Liveness only; not a session update                                                | Keep bounded; missing liveness triggers reconnect, not domain mutation               |

## Recovery Protocol

1. On EOF, overflow, decoding failure, or transport error, transition from connected to reconnecting/stale. An EOF must not
   create a tight reconnect loop. Abort old attempts and use capped exponential backoff with jitter; keep current 250 ms
   base/5 s cap initially, classify auth/schema failures as non-retryable, and honor server retry guidance where applicable.
2. Capture the scope generation, subscribe and buffer within the same bounded budget, then restore authoritative state.
   Where the existing sync API exposes a sequence/snapshot, recover per aggregate and apply only events after its watermark.
   Sequence gaps or compacted cursors require a fresh snapshot, not a guessed offset.
3. Do not manufacture a global ordering from unrelated aggregate sequence numbers. For unsequenced feeds, ordinary fetch
   plus buffer replay can overwrite newer state. Before promoting recovery, either add a validated snapshot/watermark
   seam through EOT-15, which produces the readiness gate this spec consumes (contract changes still land through
   EOT-10), or demonstrate an existing idempotent versioned reducer protocol. Until then remain visibly stale
   and use a full restart/bootstrap recovery, not an assertion of lossless live catch-up.
   A restart is not itself a consistency proof. The recovery readiness gate requires a snapshot watermark tied atomically
   to the replay stream, a server snapshot/subscription barrier, or producer-versioned replacement semantics proven by
   deterministic concurrent-mutation tests. If no such seam exists for an affected aggregate, keep its projection stale
   and its mutation controls unavailable until that seam is implemented; do not label the restart healthy by assumption.
4. Abort a superseded recovery; only the matching scope generation can replace state. Mark connected/ready only after the
   restoration barrier completes. If the bounded buffer overflows again, restart recovery with capped retries and expose
   degraded status rather than loop indefinitely without user feedback.
5. Preserve `/event` unwrapped and `/global/event` wrapped wire shapes. Any additive cursor/version contract requires
   generated clients, old-client compatibility tests, and explicit fallback behavior for older servers.

## Failure and Cancellation

Closing a provider cancels the read, iterator, reconnect delay, and recovery request. Stop queue drains after owner disposal.
No detached timer may flush old events into a new workspace. Keep existing best-effort `Bus.publish` semantics documented;
use an explicit typed/committed path for operations that require durable acknowledgement rather than retroactively
changing fire-and-forget callers. Persistence success and notification failure remain distinguishable.

## Acceptance and Verification

- Burst and oversized-frame tests assert both count and byte ceilings; healthy subscribers receive the complete ordered
  sequence while a stalled subscriber is evicted with an observable reason. No missing/duplicate final text after recovery.
- Interleave create/delete, delta/completion, permission/reply, and two workspaces; compare recovered state to a fresh
  authoritative snapshot. Assert monotonic per-aggregate handling without assuming global sequence order.
- Mutate between subscription acknowledgement, snapshot capture, snapshot delivery, and replay completion using controlled
  barriers. Assert exact final state and that readiness cannot become true before the consistency mechanism is proven.
- Fail one handler and verify later handlers still run; assert stale status and recovery for the failed projection.
- Cancel during iterator acquisition, backoff, drain, and snapshot fetch; assert no subsequent requests or store mutations.
- Test clean EOF, 401, malformed envelopes, compaction gaps, and repeated overflow; no zero-delay loop or false connected state.
- Extend `packages/nikcli/test/server/event-feed.test.ts`, `packages/nikcli/test/server/event-visibility.test.ts`,
  `packages/nikcli/test/tui/streaming-store.test.ts`, and `packages/nikcli/test/tui/thread.test.ts`.
- From `packages/nikcli`: `bun test test/server/event-feed.test.ts test/server/event-visibility.test.ts test/tui/streaming-store.test.ts test/tui/thread.test.ts`.
  Contract changes additionally follow EOT-10 codegen/route checks. Meet EOT-01's flush and input budgets under burst load.

## Migration and Rollback

First classify events and instrument queue depth/bytes; next add overflow behavior and recovery tests; only then unify
batching and consider Effect queue primitives on backend-owned paths. Keep existing server fan-out until parity is proven.
Rollback the admission implementation behind the same interface, preserving boundedness and stale-state reporting. Never
restore an unbounded queue as the permanent fix for an overflow test failure.

## Discipline Addendum — 2026-09-19

Slice 3 promotes `BYTE_BUDGET` from a candidate ceiling (`src/server/httpapi/event-feed.ts:79`) to an enforced one and pins the Promise publish contract. These do not change the spec above; they codify what the code does today so a code reviewer does not have to re-derive it.

1. **`BYTE_BUDGET = 8 MiB` is enforced per frame.** `Connection.offer()` evicts with `ByteBudgetExceededError` when _one_ broadcast frame exceeds the ceiling. It is deliberately not a lifetime budget: `Connection.written` only grows, so `written + frame > BYTE_BUDGET` would evict every healthy reader that had been sent eight megabytes of ordinary events — which a TUI session reaches well inside an hour — and would report it as the client's fault. Per frame the question needs no producer inventory to answer: an event that large is a producer bug, and forwarding it puts the same megabytes into the client. Local frames (greeting, heartbeat, close reason) bypass the check entirely — they exist to hold the connection open and to state why it is being dropped. A lifetime or windowed budget remains possible later; `Connection.cost.bytes` is the measurement it would be ratified against.
2. **Promise publish is best-effort by design.** `Bus.publish` in `packages/nikcli/src/bus/index.ts:173` swallows rejections — the spec wording was "best-effort" because changing it globally would change compatibility semantics for every existing caller. Tests assert _no exception escapes_; recovery from a dropped publish happens at the next event, not via redelivery.
3. **The two budgets answer different questions.** Frame-count eviction (`SubscriberOverflowError`, `LAG_BUDGET = 4096`) catches a reader that cannot keep up. Frame-size eviction (`ByteBudgetExceededError`) catches a producer emitting a single event nobody should have to receive. Neither subsumes the other, and both write their reason into the close frame so a client knows which one tripped.

Tests in `packages/nikcli/test/server/event-feed.test.ts` exercise all of it: a reader handed more than `BYTE_BUDGET` _in total_ stays attached, a single oversized broadcast evicts with `ByteBudgetExceededError` and is itself never delivered, and local frames bypass the check. A future change that introduces a new eviction reason must add a matching test in the same describe block before merge.
