import { describe, expect, it } from "bun:test"
import { createTelemetryBuffer, DEFAULT_FLUSH_MS, DEFAULT_MAX_RECORDS } from "@tui/util/telemetry-buffer"

/**
 * EOT-13's "live panel bounded" gate, on the buffer the panel actually uses.
 *
 * The panel was bounded and nothing else: every `telemetry.record` event wrote
 * a Solid signal, and each write rebuilt a 2000-element array. A busy turn
 * emits spans far faster than a terminal repaints, so it did a full re-render
 * per span to show frames nobody could read. The cap limits what is *kept*;
 * the flush window limits how often the rest of the app is told, which is the
 * part the input thread pays for.
 *
 * No timers are awaited here. `schedule` is a seam, so a test drives the clock
 * instead of sleeping long enough that the throttle has probably fired — the
 * discipline in `20-testing-architecture-harnesses.md`.
 */
function harness<T>(options: { max?: number; flushMs?: number } = {}) {
  const flushes: (readonly T[])[] = []
  let queued: (() => void) | undefined
  const buffer = createTelemetryBuffer<T>({
    ...options,
    onFlush: (records) => flushes.push(records.slice()),
    schedule: (fn) => {
      queued = fn
    },
  })
  return {
    buffer,
    flushes,
    /** Run the pending flush, if the buffer asked for one. */
    tick() {
      const fn = queued
      queued = undefined
      fn?.()
    },
    get scheduled() {
      return queued !== undefined
    },
  }
}

describe("telemetry buffer (EOT-13)", () => {
  it("does not call the sink inline — pushing never blocks the caller", () => {
    const h = harness<number>()
    h.buffer.push(1)
    h.buffer.push(2)
    expect(h.flushes).toEqual([])
    h.tick()
    expect(h.flushes).toEqual([[1, 2]])
  })

  it("coalesces a burst into a single flush", () => {
    // The whole point: 500 spans inside one window cost one notification, not
    // 500 signal writes and 500 array rebuilds.
    const h = harness<number>()
    for (let i = 0; i < 500; i++) h.buffer.push(i)
    expect(h.flushes.length).toBe(0)
    h.tick()
    expect(h.flushes.length).toBe(1)
    expect(h.flushes[0].length).toBe(500)
  })

  it("schedules again for records that arrive after a flush", () => {
    const h = harness<number>()
    h.buffer.push(1)
    h.tick()
    expect(h.scheduled).toBe(false)
    h.buffer.push(2)
    expect(h.scheduled).toBe(true)
    h.tick()
    expect(h.flushes).toEqual([[1], [1, 2]])
  })

  it("keeps the most recent records and reports what the cap discarded", () => {
    const h = harness<number>({ max: 3 })
    for (const n of [1, 2, 3, 4, 5]) h.buffer.push(n)
    h.tick()
    expect(h.flushes[0]).toEqual([3, 4, 5])
    // A panel that silently loses records is worse than one that says so.
    expect(h.buffer.dropped).toBe(2)
  })

  it("stays at the cap under sustained pressure", () => {
    const h = harness<number>({ max: 10 })
    for (let i = 0; i < 10_000; i++) h.buffer.push(i)
    expect(h.buffer.size).toBe(10)
    h.tick()
    expect(h.flushes[0].length).toBe(10)
  })

  it("flushNow delivers a window parked behind the throttle", () => {
    // Otherwise the last flush is the one the panel never receives.
    const h = harness<number>()
    h.buffer.push(7)
    h.buffer.flushNow()
    expect(h.flushes).toEqual([[7]])
  })

  it("flushNow is a no-op when nothing is pending", () => {
    const h = harness<number>()
    h.buffer.flushNow()
    expect(h.flushes).toEqual([])
  })

  it("clear empties the window without inventing a flush", () => {
    const h = harness<number>()
    h.buffer.push(1)
    h.buffer.clear()
    expect(h.buffer.size).toBe(0)
    h.tick()
    expect(h.flushes).toEqual([[]])
  })

  it("keeps the defaults the spec names", () => {
    expect(DEFAULT_MAX_RECORDS).toBe(2000)
    expect(DEFAULT_FLUSH_MS).toBe(250)
  })
})
