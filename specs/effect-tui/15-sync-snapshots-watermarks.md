# EOT-15: Sync Snapshots, Watermarks, and Multi-Device State

Status: proposed. Tier: 1. Phase: P2. Dependencies: EOT-04, EOT-05, EOT-09.
Owner: sync, session, mobile-bridge maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B06, B19 in the [register](../README.md): the durable sync journal has per-aggregate sequences and snapshots
machinery (`docs/sync-architecture.md`, `packages/nikcli/src/sync/index.ts`), and the server encodes events once with
bounded frame lag. EOT-04 covers delivery and recovery. The remaining gap is the **end-to-end replay/catch-up** protocol:
snapshot watermarks, sequence gaps, compaction cursors, multi-device state ordering, and the seam between aggregate-level
replay and global SSE. Without it, the recovery model in EOT-04 cannot safely promise lossless catch-up across a
disconnect, and the mobile companion (which depends on sync snapshots) inherits the gap.

## Scope and Non-Goals

Define the canonical snapshot/watermark contract for the sync subsystem, the recovery protocol that ties snapshot
acquisition to event replay, and the multi-device consistency model for the mobile companion. Preserve the existing
`docs/sync-architecture.md` semantics and the existing aggregate-level replay machinery. Do not introduce a second
journal, change existing aggregate sequence semantics, or invent a new global SSE cursor without the matching snapshot
watermark seam.

## Design and Requirements

1. Each aggregate (session, project, workspace, loop, mission) carries an opaque `watermark` (monotonic within the
   aggregate) and an `aggregateVersion` (a server-defined content version). The watermark is the **lowest** boundary
   after which the snapshot is authoritative; events with sequence `> watermark` must be replayed before the snapshot is
   usable.
2. A snapshot is delivered with `(aggregateID, aggregateVersion, watermark, payload)`. Consumers validate
   `aggregateVersion` against the local schema; an unknown version is treated as a contract change, not a corrupt frame.
   Snapshots are content-addressed; equal payloads share a content hash to enable dedup.
3. Subscription establishes a barrier: the consumer subscribes, captures the snapshot for the aggregate (or fetches it
   from the server), and only marks itself `subscribed` after **both** the subscription ack and the snapshot are received
   for every required aggregate. Late events after the barrier are applied in `sequence` order. The barrier is the seam
   that makes recovery lossless.
4. Sequence gaps: a gap between the snapshot's `watermark` and the next event's sequence is a contract violation. The
   consumer treats it as `SyncError.SequenceGap`, refreshes the snapshot, and continues; the recovery is bounded, not
   infinite. A repeated gap within the same generation is a fatal `SyncError.SequenceGapUnrecoverable` and surfaces as a
   visible stale state, never as silent catch-up.
5. Compaction: the server may compact old events away. A consumer whose `watermark` is below the server's compaction
   floor must refetch the snapshot atomically before replaying. The atomicity here is critical: the snapshot, the
   compaction cursor, and the replay position are delivered as one barrier; a partial fetch is treated as a failed
   barrier and retried.
6. Multi-device: the mobile companion, the CLI's TUI, and a remote TUI can attach the same account simultaneously. The
   server tags events with `originDeviceID`; the consumer can apply device-aware coalescing (drop events the local
   originator already applied). Conflict resolution is per-aggregate: sessions are additive (no destructive merge),
   settings are last-write-wins with a vector clock, and file edits use the existing snapshot-diff protocol.
7. Cursor types: each consumer maintains a per-aggregate cursor `(aggregateID, watermark)`. Global cursors are
   **derived** from the per-aggregate cursors; they are not authoritative. A consumer that needs a global cursor must
   reason about it as a fold over per-aggregate cursors, never as a stored global sequence.
8. Recovery readiness gate: a consumer may only mark itself `ready` after the barrier completes and after the
   per-aggregate cursors are validated against the snapshot. EOT-04's recovery readiness protocol consumes this gate;
   EOT-15 is the producer.
9. Read-after-write: a request that mutates a session returns the new `watermark`; the consumer can issue a follow-up
   read that includes `(watermark >= newWatermark)` to guarantee the mutation is visible. The guarantee is local to the
   consumer's connection; cross-device visibility is bounded by the multi-device ordering above.
10. Bootstrap from a fresh install: the consumer subscribes with `bootstrap=true` and the server delivers the full
    snapshot bundle plus the live stream. The barrier holds until every required aggregate is delivered. The consumer
    never operates on partial state.

## Snapshot Topology

```text
Server (publisher)
  - per-aggregate watermark
  - snapshot bundle (typed per aggregate)
  - live event stream with per-aggregate sequence
Consumer (TUI / mobile / remote)
  - subscribe -> snapshot barrier -> replay -> ready
  - per-aggregate cursor; global cursor is derived
  - gap -> refetch -> continue; repeated gap -> fatal stale
Multi-device
  - originDeviceID tags events
  - last-write-wins settings; additive sessions; snapshot-diff files
```

## Failure and Cancellation

Use `Schema.TaggedError`: `SyncError.SnapshotInvalid`, `SyncError.SequenceGap`, `SyncError.SequenceGapUnrecoverable`,
`SyncError.CompactedWatermark`, `SyncError.AggregateVersionUnknown`, `SyncError.BarrierFailed`,
`SyncError.BootstrapIncomplete`. Subscription cancellation aborts the barrier and the replay iterator; partial state is
discarded. The barrier does not leak resources across cancellation: an interrupted bootstrap re-runs from scratch, not
from the partial snapshot. A server-side snapshot failure during the barrier is reported as `SyncError.SnapshotInvalid`
with a typed retry; the retry budget is bounded. Compaction that occurs mid-barrier is detected by watermark validation
and forces a refetch.

## Acceptance and Verification

- A controlled subscriber/snapshot fixture exercises subscribe → snapshot → replay → ready; mutations between
  subscription ack and snapshot delivery are reflected in the final state; a watermark issued during the barrier matches
  the post-replay state.
- A sequence gap during replay forces a snapshot refetch and continues; a repeated gap in the same generation surfaces as
  `SyncError.SequenceGapUnrecoverable` and the consumer is visibly stale.
- A compacted watermark below the consumer's cursor forces a refetch before replay; partial fetches are detected and
  retried atomically.
- Two consumers on the same account (TUI + mobile) receive `originDeviceID`-tagged events; device-aware coalescing
  suppresses local-origin events; cross-device conflicts resolve per the documented rules.
- Bootstrap from a fresh install delivers the full snapshot bundle before the first live event; the consumer never sees
  partial state.
- Extend `packages/nikcli/test/sync/`, `packages/nikcli/test/mobile/` (sync tests in the mobile surface),
  `packages/nikcli/test/server/event-feed.test.ts`, `packages/nikcli/test/server/event-visibility.test.ts`, and
  `packages/nikcli/test/tui/streaming-store.test.ts`.
- From `packages/nikcli`: `bun test test/sync/ test/mobile/ test/server/event-feed.test.ts test/tui/streaming-store.test.ts`.
  Run with the existing isolated database (`withIsolatedDatabase`). One final root `bun run typecheck` after the slice.
- Meet EOT-01 budgets; recovery readiness gate measured end-to-end against the snapshot+replay fixture.

## Migration and Rollback

Phase by aggregate. Snapshot barrier lands on `session` first, then `project`, then `workspace`, then `loop`/`mission`.
Each phase flips a per-aggregate barrier flag; the legacy path stays until both directions are tested. The mobile
companion migrates after the server-side barrier is ratified. Roll back by toggling the per-aggregate flag to the legacy
path; never delete per-aggregate cursors or stored snapshots. Schema changes are additive (new optional fields); a v1
consumer can ignore a v2 snapshot's unknown fields without forcing a full re-bootstrap.

## Ordering and the Replay Contract — 2026-09-20

### Global SSE is not a replay protocol

Stated here because the plan asked for it explicitly, and because the two look alike from
the client's side. `/event` and `/global/event` carry **no sequence numbers**: a frame is a
notification that something happened, not a numbered position in a log. A client that
misses frames — evicted for lag, for an oversized producer, or by a network failure —
cannot resume from where it was, and nothing in the feed lets it discover that it missed
anything. It refetches, and the close reason
(`specs/effect-tui/04-event-delivery.md`) is what tells it to.

The sync journal is the replay protocol. It has per-aggregate `seq`, `detectSequenceGap`
to find a hole, and snapshots to bound the replay. Reaching for `detectSequenceGap` on the
SSE path would be reaching for a cursor that does not exist.

### `seq` is the order; `origin` is not

`reserveSeqAndAppend` assigns `seq` per aggregate, in the writer's database, inside one
transaction. A device's `origin` and `origin_seq` are provenance and idempotency — two
devices do not interleave their own counters into one stream, and a reader's order is the
server's, not any device's.

`test/sync/ordering.test.ts` pins the property: no duplicate `seq`, no holes,
per-aggregate independence, and cursor reads in order — in-process under a 40-write burst,
and across four contending processes, which is the production shape since the server runs
one per workspace.

**What it does not establish.** It pins the property, not the mechanism. Flipping the
transaction to `deferred` was tried both ways and nothing failed: in-process because the
drizzle driver is synchronous, so the read and the append cannot interleave at all, and
across processes because SQLite's own locking and retry appear to close the window first.
So the guarantee is more robust than the one line usually credited with it, a regression in
it would still be caught here, and `BEGIN IMMEDIATE` should not be cited as _proven_
load-bearing on the strength of this file.

Why the property matters beyond ordering: `detectSequenceGap` reads consecutiveness as
proof that nothing was deleted. Two appends colliding on one `seq` would leave the next
reader's gap check quietly wrong — no hole to find, and an event gone.
