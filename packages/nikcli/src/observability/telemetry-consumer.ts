/**
 * `TelemetryRecord` consumer contract.
 *
 * EOT-13 mandates a live panel that renders spans as they fire, with three
 * invariants:
 *
 *  - 250 ms throttle — frames emitted faster than that are coalesced.
 *  - Bounded recent-N — a fixed window keeps the panel's memory ceiling
 *    independent of the producer's rate.
 *  - Never blocks the input thread — even when the producer overwhelms the
 *    consumer, the consumer must drain at its own pace.
 *
 * `telemetry-consumer.ts` is the reference implementation of those
 * invariants. It is not wired into the TUI today (B27 confirms the
 * consumer side does not exist yet); the test in
 * `test/observability/telemetry-consumer.test.ts` exercises it directly so
 * the contract is pinned before a TUI panel adopts it.
 */
export type TelemetryFrame = {
  readonly id: string
  readonly traceId: string
  readonly name: string
  readonly startTime: number
  readonly durationMs: number
}

export type ConsumerOptions = {
  /** Coalesce window in milliseconds. Default: 250. */
  readonly throttleMs?: number
  /** Maximum frames retained. Default: 200. */
  readonly maxFrames?: number
}

const DEFAULT_THROTTLE_MS = 250
const DEFAULT_MAX_FRAMES = 200

/**
 * Build a throttled, bounded `TelemetryRecord` consumer.
 *
 * The returned object exposes:
 *  - `push(frame)` — enqueue a frame. Non-blocking, always O(1).
 *  - `snapshot()` — read the current bounded window.
 *  - `drain()` — return and reset the coalesced window since the last drain.
 *
 * Coalescing rule: if two frames are less than `throttleMs` apart, the
 * second replaces the first in the buffer instead of appending. Frames
 * further apart than that append normally. The bounded window keeps the
 * most recent `maxFrames`.
 *
 * The window is measured on `frame.startTime` — the producer's clock — not
 * on arrival. A span's start time is what the panel is showing, and reading
 * it makes the consumer a pure function of its input: the same frames
 * always coalesce the same way, whether they arrive live or are replayed
 * from a capture, and a test never has to control the wall clock.
 *
 * **Non-blocking guarantee**: `push` is synchronous and never awaits. A
 * producer that calls `push` 10_000 times in a tight loop cannot block
 * the consumer or starve other code paths.
 */
export function createTelemetryConsumer(options: ConsumerOptions = {}): {
  push(frame: TelemetryFrame): void
  snapshot(): readonly TelemetryFrame[]
  drain(): readonly TelemetryFrame[]
  readonly pending: number
  readonly throttledCount: number
  readonly overflowCount: number
} {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES

  const buffer: TelemetryFrame[] = []
  let lastPushAt = 0
  let throttledCount = 0
  let overflowCount = 0

  function push(frame: TelemetryFrame): void {
    // Producer clock, deliberately — see the coalescing note above.
    const now = frame.startTime
    const within = now - lastPushAt < throttleMs
    if (within && buffer.length > 0) {
      // Coalesce: replace the last frame so the panel keeps the freshest
      // telemetry instead of two near-simultaneous frames.
      buffer[buffer.length - 1] = frame
      throttledCount++
    } else {
      buffer.push(frame)
      if (buffer.length > maxFrames) {
        buffer.shift()
        overflowCount++
      }
    }
    lastPushAt = now
  }

  function snapshot(): readonly TelemetryFrame[] {
    return buffer.slice()
  }

  function drain(): readonly TelemetryFrame[] {
    const out = buffer.slice()
    buffer.length = 0
    return out
  }

  return {
    push,
    snapshot,
    drain,
    get pending() {
      return buffer.length
    },
    get throttledCount() {
      return throttledCount
    },
    get overflowCount() {
      return overflowCount
    },
  }
}
