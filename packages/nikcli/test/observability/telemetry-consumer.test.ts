import { describe, expect, it } from "bun:test"
import { createTelemetryConsumer, type TelemetryFrame } from "@/observability/telemetry-consumer"

/**
 * EOT-13 telemetry consumer contract.
 *
 * The TUI live panel does not exist yet (B27 confirms), but its three
 * invariants are pinned here so a future consumer cannot regress them:
 *
 *  - 250 ms throttle — frames closer than the budget coalesce.
 *  - Bounded recent-N — the buffer's size is independent of producer rate.
 *  - Never blocks the input thread — `push` is synchronous, O(1).
 *
 * The reference implementation lives at
 * `src/observability/telemetry-consumer.ts`.
 */

const FRAME = (i: number, startTime: number): TelemetryFrame => ({
  id: `frame-${i}`,
  traceId: `trace-${i}`,
  name: `span-${i}`,
  startTime,
  durationMs: 1,
})

describe("TelemetryRecord consumer (EOT-13)", () => {
  it("keeps every frame when the producer rate is below the throttle", () => {
    const consumer = createTelemetryConsumer({
      throttleMs: 10,
      maxFrames: 100,
    })
    for (let i = 0; i < 5; i++) consumer.push(FRAME(i, i * 100))
    expect(consumer.snapshot()).toHaveLength(5)
    expect(consumer.throttledCount).toBe(0)
  })

  it("coalesces frames within the throttle window (250 ms default)", () => {
    const consumer = createTelemetryConsumer()
    // Two frames in the same millisecond: the second replaces the first.
    consumer.push(FRAME(1, 1000))
    consumer.push(FRAME(2, 1000))
    expect(consumer.snapshot()).toHaveLength(1)
    expect(consumer.snapshot()[0].id).toBe("frame-2")
    expect(consumer.throttledCount).toBe(1)
  })

  it("respects a custom throttleMs", () => {
    const consumer = createTelemetryConsumer({ throttleMs: 100 })
    consumer.push(FRAME(1, 0))
    consumer.push(FRAME(2, 50)) // within 100 ms
    expect(consumer.throttledCount).toBe(1)
    consumer.push(FRAME(3, 150)) // outside
    expect(consumer.snapshot()).toHaveLength(2)
    expect(consumer.throttledCount).toBe(1)
  })

  it("bounds the buffer to maxFrames and tracks overflows", () => {
    const consumer = createTelemetryConsumer({ throttleMs: 0, maxFrames: 3 })
    for (let i = 0; i < 10; i++) consumer.push(FRAME(i, i * 10))
    expect(consumer.snapshot()).toHaveLength(3)
    expect(consumer.overflowCount).toBe(7)
  })

  it("push is non-blocking and O(1) under tight producer pressure", () => {
    const consumer = createTelemetryConsumer({ throttleMs: 0, maxFrames: 200 })
    const start = Date.now()
    for (let i = 0; i < 10_000; i++) consumer.push(FRAME(i, i))
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(200) // 10k pushes well under 200 ms wall
    expect(consumer.snapshot().length).toBeLessThanOrEqual(200)
    expect(consumer.overflowCount).toBeGreaterThan(0)
  })

  it("drain returns and resets the buffer", () => {
    const consumer = createTelemetryConsumer({ throttleMs: 0 })
    consumer.push(FRAME(1, 0))
    consumer.push(FRAME(2, 1_000))
    const drained = consumer.drain()
    expect(drained).toHaveLength(2)
    expect(consumer.snapshot()).toHaveLength(0)
    consumer.push(FRAME(3, 2_000))
    expect(consumer.snapshot()).toHaveLength(1)
  })

  it("default throttleMs is 250 ms per EOT-13 spec", () => {
    const consumer = createTelemetryConsumer({ maxFrames: 1000 })
    // First frame sets lastPushAt; second within 250 ms coalesces.
    consumer.push(FRAME(1, 1_000))
    consumer.push(FRAME(2, 1_100))
    expect(consumer.throttledCount).toBe(1)
    consumer.push(FRAME(3, 1_500)) // 500 ms after first — outside window
    expect(consumer.throttledCount).toBe(1)
    expect(consumer.snapshot()).toHaveLength(2)
  })
})
