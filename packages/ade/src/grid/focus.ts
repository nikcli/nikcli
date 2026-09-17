/**
 * Which pane holds focus, across the two events that move it: closing a pane,
 * and arrowing between them.
 *
 * Both are kept away from the components on purpose. Focus in a tiled grid is
 * the kind of logic that looks obvious and is wrong in one direction only —
 * usually by tracking an *index* through a mutation that reorders the list, so
 * closing a pane silently focuses whatever slid into its slot several panes
 * away. Everything here is keyed by pane id for that reason.
 */

export interface CloseInput {
  /** Pane ids in grid order, before the close. */
  panes: readonly string[]
  /** The focused pane's id, if any. */
  focused: string | undefined
  /** The pane being closed. */
  closing: string
}

/**
 * The pane that should hold focus once `closing` is gone.
 *
 * Closing a pane that is not focused must not move focus at all — a background
 * session finishing and tidying itself away would otherwise yank the keyboard
 * out of the pane you were typing into.
 *
 * When the focused pane is the one closing, focus goes to its *successor*, so
 * repeatedly closing walks forward through the grid instead of bouncing back to
 * the start. The last pane has no successor, so it falls back to its
 * predecessor.
 */
export function focusAfterClose(input: CloseInput): string | undefined {
  const index = input.panes.indexOf(input.closing)
  if (index === -1) return input.focused

  const remaining = input.panes.filter((id) => id !== input.closing)
  if (remaining.length === 0) return undefined
  if (input.closing !== input.focused) {
    // Focus is on some other pane, and that pane still exists. Identity, not
    // position: its index has very likely shifted.
    return input.focused !== undefined && remaining.includes(input.focused) ? input.focused : undefined
  }

  return index < remaining.length ? remaining[index] : remaining[remaining.length - 1]
}

export type FocusDirection = "left" | "right" | "up" | "down"

export interface MoveInput {
  count: number
  columns: number
  /** Index of the focused pane. */
  index: number
  direction: FocusDirection
}

/**
 * The index focus moves to, or the current index when the move is not possible.
 *
 * Horizontal movement stops at the row edge rather than wrapping onto the next
 * row. In a grid of live sessions the rows are meaningful groupings the user
 * arranged, and a right-arrow that silently jumps down a row makes the position
 * of focus something you have to look up rather than know.
 *
 * Vertical movement into a short last row clamps to its final pane instead of
 * refusing. Refusing would leave panes in the last row reachable only by
 * arrowing along it, which is worse than landing one column off.
 */
export function moveFocus(input: MoveInput): number {
  const { count, index, direction } = input
  const columns = Math.max(1, input.columns)
  if (count <= 0) return 0
  if (index < 0 || index >= count) return 0

  const column = index % columns

  switch (direction) {
    case "left":
      return column > 0 ? index - 1 : index
    case "right":
      return column < columns - 1 && index + 1 < count ? index + 1 : index
    case "up":
      return index - columns >= 0 ? index - columns : index
    case "down": {
      const below = index + columns
      if (below < count) return below
      // No pane directly below. There may still be a row down there — a short
      // last row — in which case land on its final pane rather than stalling.
      const row = Math.floor(index / columns)
      const hasRowBelow = (row + 1) * columns < count
      return hasRowBelow ? count - 1 : index
    }
  }
}
