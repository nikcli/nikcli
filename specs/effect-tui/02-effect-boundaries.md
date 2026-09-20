# EOT-02: Effect Runtime and Service Boundaries

Status: proposed. Tier: 1. Phase: P1. Dependencies: EOT-01.
Owner: nikcli Effect/domain maintainers. [Roadmap](../ROADMAP.md).

## Problem and Evidence

Evidence B02, B03, B18: runtime reuse, instance scopes, and two-layer services already exist. However,
`packages/nikcli/src/effect/runtime.ts` and `packages/nikcli/src/effect/run-service.ts` widen service requirements with
`any`; `SessionPrompt` coordinates many Promise-to-Effect calls. The opportunity is stronger boundaries and fewer
crossings, not another runtime abstraction or a wholesale asynchronous rewrite.

## Scope and Non-Goals

Improve the existing bridge, service interfaces, lifetime ownership, and high-value caller chains. Keep SDK Promise
compatibility and the current instance ALS boundary. Do not introduce a TUI dependency on nikcli runtime, eagerly rebuild
all layers, replace synchronous repositories, or apply newer/v3 Effect APIs without checking rc.112.

## Design and Requirements

1. Domain services expose typed operations through `Context.Service`. Export `layer` with explicit dependencies and
   `defaultLayer` with those dependencies provided. Keep Layer values stable at module scope so shared memoization works.
2. Keep `makeRuntime` and `sharedMemoMap` authoritative. Promise callers use `runPromiseWithLayer` or `runService`; Effect
   callers compose Effects directly instead of calling a Promise wrapper and rewrapping its result.
3. Tighten requirement typing in the existing runtime helpers. Derive the service context from the supplied Layer and
   make missing-service calls fail a compile-time fixture. If unavoidable library variance needs a cast, isolate it at
   the bridge with a tested invariant; do not push `any`, `unknown as`, or `orDie` into callers to obtain green types.
4. Use named `Effect.fn` operations and `Effect.gen` for orchestration; keep pure transformations as ordinary functions.
   Convert fallible foreign Promise APIs with `Effect.tryPromise`, map expected failures into domain `Schema.TaggedError`,
   and forward the interruption signal into APIs that actually support abort.
5. Use `InstanceRef`/`WorkspaceRef` inside Effect. Capture ambient state only at the existing Promise boundary. Preserve
   `InstanceScope.with` semantics: caller interruption reaches the inner fiber and waits for finalizers; typed failure,
   defect, and interruption are not flattened into a generic success/error string.
6. Acquire external resources with `Effect.acquireRelease`; fork service-owned work with `Effect.forkScoped`. Associate
   each scope with a real lifetime: request, instance, process, or durable job. Do not scope a durable job to the request
   that submitted it. Unstructured forks require a named owner, shutdown path, and error observation.
7. Audit `InstanceState` entries before introducing capacity. Reloadable config derivations can be invalidated; live bus,
   session, and process resources cannot be evicted like cache values. Bound inactive-instance retention at the owning
   instance registry, with active-reference accounting and tested finalizers, rather than adding arbitrary cache TTLs.
8. Preserve redacted logging and shared observability layers. Trace service operations at the existing boundary and avoid
   duplicate spans on every compatibility wrapper or high-cardinality labels.
9. Per-token paths are the one exception to requirement 4's `Effect.gen`. `Bus.publish` runs once per streaming delta
   (`session/processor.ts`, `updatePartCoalesced`), so a generator frame per call is a measured cost, not a style
   preference: `Bus.publish`, the bus service's own `publish`, and `withCurrentInstance` use `Effect.flatMap` instead and
   say so in a comment. Restoring `Effect.gen` there is a regression. Requirement 4 still governs everything that runs
   once per request, per session, or per command.
10. `InstanceState.get` reads through a synchronous mirror of already-resolved entries, not through `ScopedCache` on
    every call. The cache stays the source of truth for creation, invalidation, and disposal; the mirror is written by the
    cache's own `lookup` and removed by a finalizer on the **entry's** scope, so it cannot outlive the entry it mirrors.
    A new cache-eviction path must run those finalizers — see requirement 7 before adding capacity or a TTL.

## Ownership Matrix

| Resource                       | Owner                      | End condition                           | Required behavior                                |
| ------------------------------ | -------------------------- | --------------------------------------- | ------------------------------------------------ |
| Request fiber and fetch        | Request scope              | Completion/abort/deadline               | Interrupt and wait for owned cleanup             |
| Instance state/subscriptions   | Existing instance scope    | Instance disposal                       | Dispose once without affecting another workspace |
| Memoized application services  | Existing process runtime   | Application shutdown                    | Release after dependents finish                  |
| Submitted background execution | Existing durable job owner | Job terminal transition/shutdown policy | Survive submitter disconnect, remain cancellable |
| Solid renderables              | Solid/OpenTUI owner        | Unmount                                 | Never acquire a backend runtime                  |

## Failure and Cancellation

Expected validation, unavailable resource, permission denial, and domain-not-found outcomes belong on typed channels.
Unexpected defects remain defects internally and become sanitized failures at the outer boundary. Do not catch all causes
into `Effect.void`. Cancellation before acquisition must prevent work; cancellation racing with acquisition must release
the newly acquired resource. A cleanup failure is observable and must not replace an earlier failure without retaining it.

Future bridge support for AbortSignal must be additive and preserve current callers; implementing a timeout around a
Promise is insufficient unless the underlying I/O/child fiber is interrupted. Scope closure must not dispose shared
process layers while another instance still uses them.

## Acceptance and Verification

- A missing required service is rejected by the final typecheck; a valid supplied Layer compiles without caller casts.
- Two simultaneous instances with different directories/workspaces never exchange context, caches, or finalizers.
- A finalizer runs once on success, failure, defect, interruption, and cancellation during acquisition; assert the full
  Exit category rather than only an error message.
- Repeated service access constructs the same shared dependency once for its intended lifetime; invalidating a reloadable
  derivation does not cancel running jobs or remove live tool registrations.
- A migrated caller chain performs no nested Promise-to-Effect-to-Promise round trip inside its service body. Compare
  boundary invocation counts and duration against EOT-01; no required workload regresses more than its approved budget.
- Extend `packages/nikcli/test/effect/runtime.test.ts`, `packages/nikcli/test/effect/instance-scope.test.ts`, and
  `packages/nikcli/test/effect/instance-ambient.test.ts`; add domain assertions next to the migrated service's existing tests.
- From `packages/nikcli`: `bun test test/effect/runtime.test.ts test/effect/instance-scope.test.ts test/effect/instance-ambient.test.ts`.
  Run one final root `bun run typecheck` after all implementation edits, not once per service.

## Migration and Rollback

Start with a single bounded service operation, characterize its Promise contract, then migrate its internal chain while
keeping the exported facade. Move account/session/tool operations only in independently testable slices. Remove legacy
ambient fallbacks only after an exhaustive caller inventory and concurrent-instance tests show they are unused. Roll back
the internal implementation behind the same facade; never add a second runtime or discard caller cancellation to recover.

## Discipline Addendum — 2026-09-20

`runPromiseWithLayer` and `runPromiseExitWithLayer` now record their outcomes (commit `644a8f28`), and `test/effect/multi-instance-teardown.test.ts` covers two `WorkspaceRef`s on one directory.

1. **The two bridge entry points classify differently, and the asymmetry is real.** `runPromiseExitWithLayer` sees the `Exit`, so it separates `runtime.bridge.interrupted` from `runtime.bridge.failure` via `Cause.hasInterruptsOnly`. `runPromiseWithLayer` only sees a rejected promise and books every non-success as `runtime.bridge.failure`. Rewriting it on top of `runPromiseExit` and rethrowing `Cause.squash` would classify correctly and would also change the rejection value at roughly 165 call sites — a behaviour change disguised as instrumentation. The asymmetry stays until those call sites are the actual subject of a slice.
2. **Instrumentation must not change what the bridge throws.** Both wrappers count and re-throw the original value untouched. A bridge whose failure mode depends on whether a counter was enabled is worse than no counter.
