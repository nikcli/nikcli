# Integration plan

Scope: what the specs still owe the code, and the order this repo should pay it in.
Written 2026-09-27, after an audit of `specs/effect-tui/*` and `specs/v2/*` against
production call paths and existing tests.

The premise of this document: in this catalog the **contracts are landed and gated**,
and what is missing is the **consumer side** — the migrations the contracts were
written to govern. A structural gate that greps source cannot tell you the consumer
exists, which is why the tree reads as unfinished while most of it is finished.

## Tier 1 — real defects, small diffs

**Status 2026-09-29: all three landed in `487fbd6`**, the same commit that added this
document, so the items read as open while the tree already carries the fix. Each keeps its
original text as the record of the defect; the `Landed` paragraph under it is what the code
does now, checked against `origin/live-main` at `b8cb366`.

### 1. Plugin shutdown budget starts after the unbounded awaits

`packages/tui/src/plugin/runtime.ts`, `dispose()`.

The `SHUTDOWN_BUDGET_MS` deadline is computed after `await task` (the load promise)
and after `await reloading` (the serialized reload chain). Both awaits are
unbounded, and `dispose()` runs on the exit path that
`packages/tui/src/context/exit.tsx` blocks on before the renderer is destroyed and
the terminal is restored. A wedged plugin load therefore hangs the terminal
indefinitely — the budget only bounds the part that already had one.

Fix: compute the deadline on entry, and pass it to both awaits through the existing
`runCleanup` helper, which already distinguishes ok / timeout / error.

Acceptance: a plugin whose load never settles still returns from `dispose()` within
the budget, logs the overrun, and leaves the terminal restorable.

Landed: `dispose()` computes the deadline on entry and hands the remaining budget to both
awaits through `runCleanup`, then to every `deactivatePluginEntry`. The comment above it
records why timing out is not skipping: `load()` assigns `runtime` before its first await,
so whatever registered by the deadline is still disposed. `test/tui/plugin-dispose.test.ts`
pins the shared deadline across several wedged plugins.

### 2. State bounds are counts, not bytes

- `packages/tui/src/context/sync.tsx` — the session LRU is 25 entries / 30 min.
  One long session can hold thousands of turns, so the ceiling that reads as
  protection is not one.
- `packages/tui/src/context/sdk.tsx` — the SSE batch has a meter but no cap, so
  arrival rate is observable and retained bytes are not.

The streaming virtualization fallback in
`packages/tui/src/routes/session/index.tsx` is a consequence of this, and stays
until item 2 is measured on a real terminal. Removing the fallback blind trades a
known-correct full render for an unmeasured windowed one.

Landed, as counts rather than bytes by design: `sync.tsx` caps retained transcript elements
at 20,000 across every session (`MAX_RETAINED_ELEMENTS`, messages plus their parts), the
dimension the per-session LRU could not see; `sdk.tsx` caps one batch at 512 envelopes
(`EVENT_BATCH_CAP`), flushed early rather than dropped, because the queue carries permission
prompts and final outcomes. The comment above `MAX_RETAINED_ELEMENTS` says why bytes were
rejected: `JSON.stringify` over every retained transcript on each reap would stall worse than
the growth it prevents. The virtualization fallback stays, as the paragraph above says.

### 3. Plugin storage has no quota and no eviction on unload

`packages/tui/src/plugin/storage.ts` keeps process-global maps keyed `id.key` with
no bound, and evicts nothing when a plugin unloads. EOT-14 asks for bounded stores
and unload eviction. The keying already prevents cross-plugin reads; the quota and
the eviction are what is absent.

Landed: `MAX_STORE_BYTES` (32 MB across every plugin store) refuses a write that would
exceed it — refused and logged, not silently evicted, which is what EOT-14 requires of
quota exhaustion — and `evictPluginStorage(id)` runs from `deactivatePluginEntry` on unload.

## Tier 2 — real architecture, one PR each, not in this pass

1. **Snapshot / watermark barrier (EOT-15).** The producer is complete — sync
   journal, `detectSequenceGap`, `/sync/snapshot/:aggregateID`. No consumer keeps a
   per-aggregate cursor, and reconnect recovery is a blind refetch. The TUI's own
   comment at `context/sync.tsx` states this outright. This is the highest-value
   item in the catalog: it is what turns reconnect from "refetch and hope" into a
   guarantee.
2. **Workspace scope (EOT-16).** `locallyWorkspace` pins a value; it does not scope
   resources. Two workspaces on one directory share everything. Tracked as open gap
   B31 in the register.
3. **Adapter convergence (EOT-11).** The native branch and the AI SDK branch both
   ship, with coverage counters. The three typed services the spec names do not
   exist. Worth doing last: the diff is large and the payoff is a performance
   number nobody has ratified.

## Tier 3 — validation, not code

- EOT-00: the compiled-terminal row (real tmux, real Ghostty) is a matrix result
  that cannot be obtained from source.
- EOT-01: budget ratification needs the same real-terminal measurements.
- EOT-06: measured row heights and anchors, before streaming virtualization.

## Tier 4 — elective, do not start blind

- EOT-13 HTTP spans. `server/httpapi/bridge.ts` documents why the built-in server
  span is disabled: it records most of the forbidden attribute list, and no tracer
  is installed to consume it. Wiring one is an L-effort migration that must first
  solve that.
- EOT-17 network chokepoint. 45 modules call `fetch` directly; the egress
  inventory is accounting, not enforcement. Building a chokepoint around a layer
  nothing calls would add a policy check no traffic passes through.
- `specs/v2/config.md` renames. The highest-risk change class in the catalog for
  zero runtime value. Two of its entries are cheap and honest on their own:
  `teleport` and `logLevel` are published in the config schema with no reader.
- Deleting the `Database.syncDb` export. Gated at zero for `src` already; 24 test
  files still call it. Mechanical, but it is cleanup, not a fix.

## Non-goals

Retiring the full test suite from CI, forcing an account requirement onto
public/BYOK/anonymous/share/mobile surfaces, and adopting mandatory account JWTs
where `nkm_` pairing already works. Each would convert working behaviour into
failures to satisfy stale spec prose.
