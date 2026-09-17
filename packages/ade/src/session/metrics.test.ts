import { describe, expect, test } from "bun:test"
import {
  formatDuration,
  formatTokens,
  formatCost,
  elapsed,
  startTiming,
  pauseTiming,
  resumeTiming,
  activeElapsed,
  sumMetrics,
} from "./metrics"

describe("formatDuration", () => {
  test("seconds only", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(999)).toBe("0s")
    expect(formatDuration(1000)).toBe("1s")
    expect(formatDuration(41_000)).toBe("41s")
    expect(formatDuration(59_999)).toBe("59s")
  })

  test("minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 00s")
    expect(formatDuration(188_000)).toBe("3m 08s")
    expect(formatDuration(3_599_000)).toBe("59m 59s")
  })

  test("hours and minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h 00m")
    expect(formatDuration(3_720_000)).toBe("1h 02m")
    expect(formatDuration(7_200_000)).toBe("2h 00m")
  })

  test("negative and non-finite inputs", () => {
    expect(formatDuration(-1)).toBe("0s")
    expect(formatDuration(NaN)).toBe("0s")
    expect(formatDuration(Infinity)).toBe("0s")
    expect(formatDuration(-Infinity)).toBe("0s")
  })
})

describe("formatTokens", () => {
  test("small counts are plain numbers", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(742)).toBe("742")
    expect(formatTokens(999)).toBe("999")
  })

  test("thousands use 'k' with Italian comma", () => {
    expect(formatTokens(1_000)).toBe("1,0k")
    expect(formatTokens(2_100)).toBe("2,1k")
    expect(formatTokens(999_900)).toBe("999,9k")
  })

  test("millions use 'M' with Italian comma", () => {
    expect(formatTokens(1_000_000)).toBe("1,0M")
    expect(formatTokens(1_300_000)).toBe("1,3M")
  })

  test("negative and non-finite inputs", () => {
    expect(formatTokens(-1)).toBe("0")
    expect(formatTokens(NaN)).toBe("0")
  })
})

describe("formatCost", () => {
  test("formats with Italian comma and dollar sign", () => {
    expect(formatCost(0)).toBe("$0,00")
    expect(formatCost(0.42)).toBe("$0,42")
    expect(formatCost(12)).toBe("$12,00")
    expect(formatCost(1.5)).toBe("$1,50")
  })

  test("negative and non-finite inputs", () => {
    expect(formatCost(-1)).toBe("$0,00")
    expect(formatCost(NaN)).toBe("$0,00")
  })
})

describe("elapsed", () => {
  test("positive difference", () => {
    expect(elapsed(1000, 2000)).toBe(1000)
  })

  test("zero when now is before start", () => {
    expect(elapsed(2000, 1000)).toBe(0)
  })

  test("zero when equal", () => {
    expect(elapsed(1000, 1000)).toBe(0)
  })
})

describe("SessionTiming", () => {
  test("starts active", () => {
    const t = startTiming(100)
    expect(t.activeSegmentStart).toBe(100)
    expect(t.accumulatedMs).toBe(0)
  })

  test("active elapsed grows while active", () => {
    const t = startTiming(100)
    expect(activeElapsed(t, 200)).toBe(100)
    expect(activeElapsed(t, 300)).toBe(200)
  })

  test("pause stops accumulation", () => {
    const t0 = startTiming(100)
    const t1 = pauseTiming(t0, 200) // 100ms active
    expect(activeElapsed(t1, 300)).toBe(100) // doesn't grow after pause
    expect(activeElapsed(t1, 500)).toBe(100)
  })

  test("resume restarts accumulation", () => {
    const t0 = startTiming(100)
    const t1 = pauseTiming(t0, 200)   // 100ms banked
    const t2 = resumeTiming(t1, 300)   // resume at 300
    expect(activeElapsed(t2, 400)).toBe(200) // 100 banked + 100 new
  })

  test("multiple pause/resume cycles accumulate correctly", () => {
    let t = startTiming(0)
    t = pauseTiming(t, 100)   // 100ms active
    t = resumeTiming(t, 200)  // 100ms paused (not counted)
    t = pauseTiming(t, 350)   // 150ms active
    t = resumeTiming(t, 400)  // 50ms paused
    expect(activeElapsed(t, 500)).toBe(350) // 100 + 150 + 100
  })

  test("pause is idempotent", () => {
    const t0 = startTiming(100)
    const t1 = pauseTiming(t0, 200)
    const t2 = pauseTiming(t1, 300) // should be no-op
    expect(t2.accumulatedMs).toBe(t1.accumulatedMs)
  })

  test("resume is idempotent", () => {
    const t0 = startTiming(100)
    const t1 = resumeTiming(t0, 200) // already active, no-op
    expect(t1).toBe(t0)
  })
})

describe("sumMetrics", () => {
  test("sums all fields across panes", () => {
    const result = sumMetrics([
      { tokens: 100, costUsd: 0.10, activeMs: 1000 },
      { tokens: 200, costUsd: 0.20, activeMs: 2000 },
      { tokens: 50, costUsd: 0.05, activeMs: 500 },
    ])
    expect(result.totalTokens).toBe(350)
    expect(result.totalCostUsd).toBeCloseTo(0.35)
    expect(result.totalActiveMs).toBe(3500)
  })

  test("empty array returns zeroes", () => {
    const result = sumMetrics([])
    expect(result.totalTokens).toBe(0)
    expect(result.totalCostUsd).toBe(0)
    expect(result.totalActiveMs).toBe(0)
  })
})
