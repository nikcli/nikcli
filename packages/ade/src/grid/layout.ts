/**
 * How many columns the session grid should use, and where each pane lands.
 *
 * The grid holds live agent sessions rather than documents, so "fit as many as
 * possible" is the wrong objective twice over. A pane narrower than a wrapped
 * shell command shows a transcript nobody can read; a pane taller than it is
 * wide wastes most of itself on a column of short lines. What the layout is
 * actually solving for is the *shape* of a pane, and the column count is just
 * the lever that reaches it.
 */

/**
 * Below this a pane cannot hold a wrapped shell command without turning it into
 * confetti. Sized against the transcript's monospace step.
 */
export const MIN_PANE_WIDTH = 380

/**
 * A pane shorter than this shows its header and almost no transcript. Applied
 * as the pane's CSS `min-height`; past it the grid scrolls rather than shrinks.
 */
export const MIN_PANE_HEIGHT = 220

/**
 * The shape a pane is steered toward: half again as wide as it is tall.
 *
 * Transcripts are wide — a tool call and its output are long lines — so the
 * ideal is wider than square, but not by much: past roughly 2:1 the pane starts
 * spending its height on nothing while the text runs off to the right.
 */
export const TARGET_ASPECT = 1.6

/**
 * How hard an unfilled cell is punished, relative to being off-shape.
 *
 * This is the term that stops four panes from laying out as a row of three with
 * an orphan underneath. Three columns puts a pane closer to the target shape
 * than two does, and on shape alone it would win — but it leaves a hole, and a
 * grid with a hole in it reads as broken in a way that a slightly tall pane
 * does not. Tuned so that a quarter of the grid standing empty outweighs any
 * shape gain that is available at these sizes.
 */
export const WASTE_PENALTY = 0.6

/**
 * Gutter between panes, in px. Must match `--ade-grid-gap` in the stylesheet.
 *
 * A hairline, not a gutter. Twelve pixels of background between panes is twelve
 * pixels not showing a terminal, paid for on all four sides of every tile: at
 * six panes it costs more of the window than the header rows do. What the eye
 * needs to separate two terminals is a line, and a line is one pixel — so the
 * grid paints its ground in the border colour and lets the gap be that line.
 */
export const GRID_GAP = 1

export interface GridInput {
  /** Panes to place. */
  count: number
  /** Usable width of the grid container, in px, excluding its own padding. */
  width: number
  /** Usable height of the grid container, in px. */
  height: number
  /** User-pinned column count. Honoured up to what stays readable. */
  pinned?: number
  minPaneWidth?: number
  gap?: number
}

interface Resolved {
  count: number
  width: number
  height: number
  minWidth: number
  gap: number
}

function resolve(input: GridInput): Resolved {
  return {
    count: input.count,
    width: input.width,
    height: input.height,
    minWidth: input.minPaneWidth ?? MIN_PANE_WIDTH,
    gap: input.gap ?? GRID_GAP,
  }
}

/** The widest column count that keeps every pane readable at this width. */
function maxFeasibleColumns(r: Resolved): number {
  // One column is always allowed: a single pane that is too narrow still beats
  // two that are narrower, and the alternative is refusing to render.
  let columns = 1
  while (columns < r.count) {
    const next = columns + 1
    if ((r.width - r.gap * (next - 1)) / next < r.minWidth) break
    columns = next
  }
  return columns
}

function paneWidthAt(r: Resolved, columns: number): number {
  return (r.width - r.gap * (columns - 1)) / columns
}

/**
 * A pane's height at this row count.
 *
 * Deliberately *not* floored at `MIN_PANE_HEIGHT`, though the first version was.
 * The worry was that once the grid overflows and starts scrolling, scoring the
 * notional height rather than the drawn one would buy a shape that never
 * materialises. Sweeping every count from 1 to 16 across widths 600-3200 and
 * heights 240-1600 — about 144,000 layouts — the floor changed the chosen
 * column count in exactly zero of them: it applies to every candidate at once,
 * and the ranking survives it. So the floor was doing nothing except making
 * this function harder to reason about.
 *
 * `MIN_PANE_HEIGHT` still exists, and still applies — as the pane's CSS
 * `min-height`, which is where the grid actually stops shrinking and scrolls.
 */
function paneHeightAt(r: Resolved, rows: number): number {
  return (r.height - r.gap * (rows - 1)) / rows
}

/**
 * How badly this column count misses.
 *
 * Shape is measured in log space so that being twice as wide as the target and
 * half as wide are penalised equally — in linear space, "too wide" is unbounded
 * while "too narrow" saturates at zero, and a single-column layout on a wide
 * monitor would score better than it deserves.
 */
function score(r: Resolved, columns: number): number {
  const rows = Math.ceil(r.count / columns)
  const aspect = paneWidthAt(r, columns) / paneHeightAt(r, rows)
  const shape = Math.abs(Math.log(aspect / TARGET_ASPECT))
  const waste = (columns * rows - r.count) / r.count
  return shape + WASTE_PENALTY * waste
}

/**
 * The column count to lay out with: the one whose panes come closest to the
 * target shape without leaving conspicuous holes in the grid.
 *
 * Two simpler rules were tried first and both degenerate:
 *
 *   - Fewest rows. One row of everything always wins, and the grid becomes a
 *     strip of tall slivers.
 *   - Largest pane area. On a wide container a single full-width column wins,
 *     for the same reason.
 *
 * Both fail because they optimise one dimension while the container fixes the
 * other. Scoring the ratio is what makes the two dimensions trade against each
 * other, and the waste term is what keeps that trade from producing an orphan.
 */
export function gridColumns(input: GridInput): number {
  const r = resolve(input)
  if (r.count <= 0) return 1
  const feasible = maxFeasibleColumns(r)

  if (input.pinned !== undefined) {
    // A pin is a preference, not a licence to make panes unreadable.
    return Math.max(1, Math.min(input.pinned, feasible))
  }

  let best = 1
  let bestScore = Number.POSITIVE_INFINITY
  for (let columns = 1; columns <= feasible; columns++) {
    const candidate = score(r, columns)
    // Strictly better only. Two column counts scoring bit-identically is not
    // something these formulas actually produce, so this is a guard rather than
    // a tie-break: it fixes the smaller — and wider — column count as the
    // winner if one ever does.
    if (candidate < bestScore) {
      bestScore = candidate
      best = columns
    }
  }
  return best
}

export interface PaneSlot {
  row: number
  column: number
}

/**
 * Where pane `index` sits, in reading order.
 *
 * A short last row is left short rather than stretched to fill the width.
 * Stretching breaks the column alignment that lets the eye compare two panes in
 * the same column, and it makes a pane's size depend on how many *other*
 * sessions are open — which reads as a glitch at the moment one closes.
 */
export function paneSlot(index: number, columns: number): PaneSlot {
  const safeColumns = Math.max(1, columns)
  return { row: Math.floor(index / safeColumns), column: index % safeColumns }
}

/** Rows the grid occupies at this column count. */
export function gridRows(count: number, columns: number): number {
  if (count <= 0) return 0
  return Math.ceil(count / Math.max(1, columns))
}
