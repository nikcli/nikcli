import { describe, expect, it } from "bun:test"
import {
  anchorAdjustment,
  cumulativeOffsets,
  indexAtOffset,
  spacerHeights,
  visibleRange,
} from "@tui/routes/session/message-window"

describe("anchorAdjustment", () => {
  it("keeps the anchored message in place when a message above it grows", () => {
    const before = [10, 10, 10, 10]
    const after = [10, 25, 10, 10]
    // scrollTop 25 sits 5 rows into message 2 (starts at 20). Message 1 grew by 15, so message 2
    // now starts at 35 and the same content sits at 35 + 5 = 40.
    expect(anchorAdjustment(before, after, 25)).toBe(15)
  })

  it("does nothing when only messages below the viewport change", () => {
    const before = [10, 10, 10, 10]
    const after = [10, 10, 10, 90]
    expect(anchorAdjustment(before, after, 5)).toBe(0)
  })

  it("does nothing for an empty list", () => {
    expect(anchorAdjustment([], [], 0)).toBe(0)
  })

  it("keeps the anchor when the message above shrinks", () => {
    // scrollTop 25 is 5 rows into message 1 (starts at 20). Message 0 shrank 20 -> 5, so message 1
    // now starts at 5 and the same content sits at 5 + 5 = 10: a correction of 10 - 25 = -15.
    expect(anchorAdjustment([20, 10, 10], [5, 10, 10], 25)).toBe(-15)
  })
})

describe("cumulativeOffsets", () => {
  it("returns a running sum with a leading zero and a total", () => {
    expect(cumulativeOffsets([2, 3, 5])).toEqual([0, 2, 5, 10])
  })

  it("returns just the zero for an empty list", () => {
    expect(cumulativeOffsets([])).toEqual([0])
  })

  it("clamps a negative height to zero rather than moving the list backwards", () => {
    expect(cumulativeOffsets([2, -5, 3])).toEqual([0, 2, 2, 5])
  })
})

describe("indexAtOffset", () => {
  const offsets = cumulativeOffsets([10, 10, 10])

  it("finds the message containing an offset", () => {
    expect(indexAtOffset(offsets, 0)).toBe(0)
    expect(indexAtOffset(offsets, 9)).toBe(0)
    expect(indexAtOffset(offsets, 10)).toBe(1)
    expect(indexAtOffset(offsets, 25)).toBe(2)
  })

  it("clamps past the end instead of running off it", () => {
    expect(indexAtOffset(offsets, 10_000)).toBe(2)
  })

  it("returns 0 for an empty list", () => {
    expect(indexAtOffset(cumulativeOffsets([]), 5)).toBe(0)
  })

  it("agrees with a linear scan across the whole range", () => {
    // Binary search is easy to get subtly wrong at boundaries; check it against
    // the definition rather than against hand-picked points.
    const heights = [3, 1, 7, 2, 5, 1, 4]
    const o = cumulativeOffsets(heights)
    const naive = (y: number) => {
      let best = 0
      for (let i = 0; i < heights.length; i++) if (o[i] <= y) best = i
      return best
    }
    for (let y = 0; y <= o[o.length - 1] + 2; y++) expect(indexAtOffset(o, y)).toBe(naive(y))
  })
})

describe("visibleRange", () => {
  const heights = Array.from({ length: 10 }, () => 10)

  it("returns the slice intersecting the viewport", () => {
    expect(visibleRange({ heights, scrollTop: 0, viewportHeight: 30 })).toEqual({ start: 0, end: 3 })
  })

  it("treats the viewport bottom as exclusive", () => {
    // A message whose top sits exactly on the bottom edge is offscreen.
    expect(visibleRange({ heights, scrollTop: 0, viewportHeight: 20 })).toEqual({ start: 0, end: 2 })
  })

  it("pads by overscan on both sides", () => {
    expect(visibleRange({ heights, scrollTop: 50, viewportHeight: 10, overscan: 2 })).toEqual({ start: 3, end: 8 })
  })

  it("clamps overscan at the list edges", () => {
    const range = visibleRange({
      heights,
      scrollTop: 0,
      viewportHeight: 10,
      overscan: 99,
    })
    expect(range.start).toBe(0)
    expect(range.end).toBe(heights.length)
  })

  it("returns an empty range for an empty list", () => {
    expect(visibleRange({ heights: [], scrollTop: 0, viewportHeight: 50 })).toEqual({ start: 0, end: 0 })
  })

  it("returns an empty range for a zero-height viewport", () => {
    expect(visibleRange({ heights, scrollTop: 0, viewportHeight: 0 })).toEqual({
      start: 0,
      end: 0,
    })
  })

  it("never returns an inverted or out-of-bounds range", () => {
    for (const scrollTop of [-50, 0, 5, 45, 95, 10_000]) {
      for (const viewportHeight of [0, 1, 13, 200]) {
        const range = visibleRange({
          heights,
          scrollTop,
          viewportHeight,
          overscan: 3,
        })
        expect(range.start).toBeGreaterThanOrEqual(0)
        expect(range.end).toBeLessThanOrEqual(heights.length)
        expect(range.end).toBeGreaterThanOrEqual(range.start)
      }
    }
  })

  it("covers every message the viewport actually intersects", () => {
    // The property that matters: nothing on screen may be windowed out.
    const varied = [4, 12, 1, 30, 7, 2, 18, 9]
    const offsets = cumulativeOffsets(varied)
    for (let scrollTop = 0; scrollTop < offsets[offsets.length - 1]; scrollTop += 3) {
      const viewportHeight = 25
      const range = visibleRange({
        heights: varied,
        scrollTop,
        viewportHeight,
      })
      const bottom = scrollTop + viewportHeight
      for (let i = 0; i < varied.length; i++) {
        const intersects = offsets[i] < bottom && offsets[i + 1] > scrollTop
        if (intersects) {
          expect(range.start).toBeLessThanOrEqual(i)
          expect(range.end).toBeGreaterThan(i)
        }
      }
    }
  })
})

describe("spacerHeights", () => {
  const heights = [10, 20, 30, 40]

  it("measures the hidden space above and below the window", () => {
    expect(spacerHeights(heights, { start: 1, end: 3 })).toEqual({
      top: 10,
      bottom: 40,
    })
  })

  it("is all-bottom when the window starts at the top", () => {
    expect(spacerHeights(heights, { start: 0, end: 1 })).toEqual({
      top: 0,
      bottom: 90,
    })
  })

  it("has no spacers when the whole list is windowed", () => {
    expect(spacerHeights(heights, { start: 0, end: heights.length })).toEqual({
      top: 0,
      bottom: 0,
    })
  })

  it("clamps a range that runs past the end", () => {
    expect(spacerHeights(heights, { start: 99, end: 99 })).toEqual({
      top: 100,
      bottom: 0,
    })
  })

  it("keeps top + window + bottom equal to the total height", () => {
    const total = heights.reduce((sum, h) => sum + h, 0)
    for (let start = 0; start <= heights.length; start++) {
      for (let end = start; end <= heights.length; end++) {
        const { top, bottom } = spacerHeights(heights, { start, end })
        const windowed = heights.slice(start, end).reduce((sum, h) => sum + h, 0)
        expect(top + windowed + bottom).toBe(total)
      }
    }
  })
})
