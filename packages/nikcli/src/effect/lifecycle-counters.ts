/**
 * Lifecycle counters for the Effect runtime bridge.
 *
 * Pure counters — no scheduling, no I/O. Read them through `snapshot()` for
 * tests and `script/perf-baseline.ts`; do not branch on them in production
 * code.
 *
 * `specs/effect-tui/01-performance-baseline.md` defines the candidate budgets;
 * this module is the telemetry hook so we can ratify them against real runs.
 *
 * Every key declared here is emitted by something. A counter that no call
 * site can ever increment reads as evidence — a zero that means "measured,
 * none" when it actually means "never measured" — so a key is added with its
 * emitter, not ahead of it. `runtime.bridge.stale-result` was declared and
 * dropped again for that reason: a result arriving after its consumer is gone
 * is only observable where the consumer is, which is the TUI lifecycle work
 * in `specs/effect-tui/03-tui-lifecycle.md`, not this bridge.
 */

type CounterKey =
  /** An instance scope was entered. */
  | "scope.created"
  /** The scope's effect reached an Exit that was not an interruption. */
  | "scope.completed"
  /** The caller cancelled, or the effect interrupted itself. */
  | "scope.interrupted"
  /** Instance bootstrap threw; the scope's effect never ran. */
  | "scope.failed"
  /**
   * A cancelled scope did not produce its Exit within `FINALIZER_GRACE_MS`.
   * The contract is that interrupting the caller waits for the inner
   * fiber's finalizers, so a scope still outstanding this long after the
   * interruption has a finalizer that is not returning.
   */
  | "scope.finalizer-leak"
  | "runtime.bridge.success"
  | "runtime.bridge.failure"
  | "runtime.bridge.interrupted"

const counts: Record<CounterKey, number> = Object.seal({
  "scope.created": 0,
  "scope.completed": 0,
  "scope.interrupted": 0,
  "scope.failed": 0,
  "scope.finalizer-leak": 0,
  "runtime.bridge.success": 0,
  "runtime.bridge.failure": 0,
  "runtime.bridge.interrupted": 0,
}) as Record<CounterKey, number>

/** Increment a counter by one. Safe to call from any thread (single-process). */
export function increment(key: CounterKey, by = 1): void {
  counts[key] += by
}

/** Return a stable snapshot. Do not mutate the result. */
export function snapshot(): Readonly<Record<CounterKey, number>> {
  return { ...counts }
}

/** Reset every counter to zero. Tests only. */
export function reset(): void {
  for (const key of Object.keys(counts) as CounterKey[]) {
    counts[key] = 0
  }
}

export const LIFECYCLE_KEYS = Object.keys(counts) as CounterKey[]

/**
 * How long after a cancellation a scope may still be settling before it
 * counts as a leaked finalizer. Long enough that an ordinary finalizer doing
 * a little I/O is not slandered, short enough that a hung one is reported
 * within the same session.
 */
export const FINALIZER_GRACE_MS = 5_000
