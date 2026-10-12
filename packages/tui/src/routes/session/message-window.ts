/**
 * Pure windowing math for the session message list.
 *
 * First step of `specs/effect-tui/06-terminal-rendering.md`: extract the
 * scroll→visible-range computation as a dependency-free, unit-testable module so the live
 * render can later switch from `<For each={messages()}>` to a windowed slice behind a flag
 * without re-deriving this logic. This module performs no DOM/OpenTUI work.
 */

/** Running sum of heights: `offsets[i]` is the top y of message `i`, `offsets[n]` is total height. */
export function cumulativeOffsets(heights: number[]): number[] {
  const offsets = new Array<number>(heights.length + 1)
  offsets[0] = 0
  for (let i = 0; i < heights.length; i++) {
    offsets[i + 1] = offsets[i] + Math.max(0, heights[i])
  }
  return offsets
}

/** Largest index `i` with `offsets[i] <= y` (binary search). Clamped to `[0, len-1]`. */
export function indexAtOffset(offsets: number[], y: number): number {
  const last = offsets.length - 1 // == message count
  if (last <= 0) return 0
  let lo = 0
  let hi = last - 1
  let result = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] <= y) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

export type VisibleRangeInput = {
  /** Per-message heights, in render order. */
  heights: number[]
  /** Scroll offset of the viewport top, in the same units as heights. */
  scrollTop: number
  /** Height of the visible viewport. */
  viewportHeight: number
  /** Extra messages to mount above/below the viewport to avoid mount churn on scroll. */
  overscan?: number
}

/**
 * Compute the half-open `[start, end)` slice of messages that intersect the viewport,
 * padded by `overscan`. `end` is exclusive and suitable for `messages.slice(start, end)`.
 */
export function visibleRange(input: VisibleRangeInput): {
  start: number
  end: number
} {
  const { heights, scrollTop, viewportHeight } = input
  const overscan = Math.max(0, input.overscan ?? 0)
  const count = heights.length
  if (count === 0) return { start: 0, end: 0 }

  const offsets = cumulativeOffsets(heights)
  const top = Math.max(0, scrollTop)
  const bottom = scrollTop + Math.max(0, viewportHeight)
  if (bottom <= 0) return { start: 0, end: 0 }

  // The viewport bottom is exclusive, so the last visible message is the one containing the
  // last visible pixel (`bottom - 1`); a message whose top sits exactly on `bottom` is offscreen.
  const first = indexAtOffset(offsets, top)
  const last = indexAtOffset(offsets, bottom - 1)

  const start = Math.max(0, first - overscan)
  const end = Math.min(count, last + 1 + overscan)
  return { start, end }
}

/**
 * Scroll correction that keeps the message under the viewport top in place after heights change.
 *
 * The anchor is the message that contains `scrollTop` under the old heights, and its intra-message
 * offset is kept. Returns the delta to add to `scrollTop` under the new heights; 0 when nothing above
 * the anchor moved, so a height change below the viewport never shifts what the user is reading.
 */
export function anchorAdjustment(oldHeights: number[], newHeights: number[], scrollTop: number): number {
  if (oldHeights.length === 0 || newHeights.length === 0) return 0
  const oldOffsets = cumulativeOffsets(oldHeights)
  const newOffsets = cumulativeOffsets(newHeights)
  const anchor = Math.min(indexAtOffset(oldOffsets, Math.max(0, scrollTop)), newHeights.length - 1)
  const intra = Math.max(0, scrollTop) - oldOffsets[anchor]
  const newTop = newOffsets[anchor] + intra
  return newTop - Math.max(0, scrollTop)
}

/** Total spacer heights above/below the rendered window, for scrollbar/sticky math. */
export function spacerHeights(
  heights: number[],
  range: { start: number; end: number },
): { top: number; bottom: number } {
  const offsets = cumulativeOffsets(heights)
  const total = offsets[offsets.length - 1]
  const top = offsets[Math.min(range.start, heights.length)]
  const bottom = total - offsets[Math.min(range.end, heights.length)]
  return { top: Math.max(0, top), bottom: Math.max(0, bottom) }
}
