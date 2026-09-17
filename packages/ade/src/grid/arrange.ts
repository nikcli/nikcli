/**
 * Where each tile sits once the user has had a say: the order they dragged the
 * panes into, and how many cells each one covers.
 *
 * `./layout` still decides the column count. This file decides what fills
 * those columns, and it is plain data in, plain data out, because every rule
 * here is a rule about geometry that is easy to get wrong in one direction —
 * "above" that lands below when a wide pane sits in the row, a swap that loses
 * a pane of another project — and none of it needs a DOM to be checked.
 */

/** How many grid cells a tile covers. */
export interface Span {
  columns: number
  rows: number
}

/** A tile with its position in the grid, zero-based. */
export interface Placement {
  row: number
  column: number
  rows: number
  columns: number
}

/**
 * The tallest a tile may be dragged. Past three rows a pane is taller than
 * any window it will be shown in, and the grid starts scrolling to show one
 * session.
 */
export const MAX_SPAN_ROWS = 3

/**
 * The size every tile has until the user resizes it: one cell.
 *
 * The same for every session, whatever it is called. Giving one session more
 * room by its title decides how the user orchestrates their work for them,
 * and whoever coordinates is free to make their own pane larger.
 */
export const DEFAULT_SPAN: Span = { columns: 1, rows: 1 }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * The span a tile is drawn with: the user's, when there is one, clamped to the
 * grid it has to fit in.
 *
 * The stored span is kept as chosen even when it is clamped here, so a pane
 * made three wide on a large monitor is three wide again when the window
 * grows back, instead of having been silently shrunk by a narrow moment.
 */
export function effectiveSpan(tile: { span?: Span }, gridColumns: number): Span {
  const columns = Math.max(1, Math.floor(gridColumns))
  const chosen = tile.span ?? DEFAULT_SPAN
  return {
    columns: clamp(Math.round(chosen.columns) || 1, 1, columns),
    rows: clamp(Math.round(chosen.rows) || 1, 1, MAX_SPAN_ROWS),
  }
}

/**
 * The size each tile is laid out at, given how many tiles there are.
 *
 * A pane alone in the grid — the only session, or the one that was enlarged —
 * fills it, whatever size it was given. Its span describes its share of a
 * grid it is not in any more: a pane made one column wide and three tall,
 * kept at that shape on its own, chose three columns and sat in a third of
 * the window next to two empty ones. The stored span is not touched, so it
 * applies again as soon as there is a second pane.
 */
export function spanInGrid(tile: { span?: Span }, tiles: number): { span?: Span } {
  return tiles <= 1 ? {} : tile
}

/**
 * How many cells the tiles want, for choosing the column count.
 *
 * A resized pane counts as the cells it covers: choosing the columns as if it
 * were one cell would lay out a grid it is not, and leave a row with a hole.
 */
export function cellsWanted(tiles: ReadonlyArray<{ span?: Span }>): number {
  let cells = 0
  for (const tile of tiles) {
    const span = tile.span ?? DEFAULT_SPAN
    cells += Math.max(1, Math.round(span.columns)) * Math.max(1, Math.round(span.rows))
  }
  return cells
}

/**
 * Places tiles in order, the way CSS auto-placement does without `dense`.
 *
 * Without `dense` on purpose: dense packing back-fills a hole with a later
 * tile, so the order on screen stops being the order the user dragged into,
 * and "drop it after this one" would put it somewhere else. A hole is the
 * honest price of a wide pane that does not fit at the end of a row.
 *
 * The grid is given these positions explicitly, rather than trusting the
 * browser to arrive at the same ones, so the drop targets computed from this
 * function are the tiles actually drawn.
 */
export function packTiles(spans: ReadonlyArray<Span>, gridColumns: number): { placements: Placement[]; rows: number } {
  const columns = Math.max(1, Math.floor(gridColumns))
  const taken = new Set<string>()
  const placements: Placement[] = []
  let cursorRow = 0
  let cursorColumn = 0
  let rows = 0

  const fits = (row: number, column: number, span: Span) => {
    if (column + span.columns > columns) return false
    for (let r = row; r < row + span.rows; r++) {
      for (let c = column; c < column + span.columns; c++) if (taken.has(`${r}:${c}`)) return false
    }
    return true
  }

  for (const raw of spans) {
    const span = { columns: clamp(raw.columns, 1, columns), rows: Math.max(1, raw.rows) }
    let row = cursorRow
    let column = cursorColumn
    while (!fits(row, column, span)) {
      column++
      if (column + span.columns > columns) {
        column = 0
        row++
      }
    }
    for (let r = row; r < row + span.rows; r++) {
      for (let c = column; c < column + span.columns; c++) taken.add(`${r}:${c}`)
    }
    placements.push({ row, column, ...span })
    rows = Math.max(rows, row + span.rows)
    cursorRow = row
    cursorColumn = column + span.columns
  }
  return { placements, rows }
}

/** Where on a tile a dragged pane is let go. */
export type DropZone = "before" | "after" | "above" | "below" | "swap"

/**
 * The zone under the pointer, from its position inside the target tile.
 *
 * The middle is a swap and the edges are the four directions, each edge owning
 * the triangle that points at it. A swap zone that is too small cannot be hit
 * on purpose, one too large leaves the edges as slivers, so the middle is the
 * central 40% both ways.
 */
export function dropZone(x: number, y: number, width: number, height: number): DropZone {
  const fx = width > 0 ? clamp(x / width, 0, 1) : 0.5
  const fy = height > 0 ? clamp(y / height, 0, 1) : 0.5
  if (fx >= 0.3 && fx <= 0.7 && fy >= 0.3 && fy <= 0.7) return "swap"
  const edges: Array<[DropZone, number]> = [
    ["before", fx],
    ["after", 1 - fx],
    ["above", fy],
    ["below", 1 - fy],
  ]
  edges.sort((a, b) => a[1] - b[1])
  return edges[0]![0]
}

export interface ArrangeTile {
  id: string
  span: Span
}

const centre = (p: Placement) => p.column + p.columns / 2

/**
 * The new order after dropping `dragged` on `target` in `zone`.
 *
 * Before, after and swap are positions in the order. Above and below are not:
 * in a grid laid out in reading order, "above C" is some index a row's width
 * earlier, and what that index is depends on every span in between. So those
 * two try every position, lay each one out, and keep the one that puts the
 * pane directly over (or under) the target — nearest row first, then nearest
 * column. When no position can do it, as above a tile already in the top row,
 * it falls back to before (or after), which is the nearest thing the order
 * can express.
 */
export function moveTile(
  tiles: ReadonlyArray<ArrangeTile>,
  dragged: string,
  target: string,
  zone: DropZone,
  gridColumns: number,
): string[] {
  const ids = tiles.map((tile) => tile.id)
  const from = ids.indexOf(dragged)
  const to = ids.indexOf(target)
  if (from === -1 || to === -1 || dragged === target) return ids

  if (zone === "swap") {
    const next = [...ids]
    next[from] = target
    next[to] = dragged
    return next
  }

  const rest = ids.filter((id) => id !== dragged)
  const targetIndex = rest.indexOf(target)
  const insert = (at: number) => [...rest.slice(0, at), dragged, ...rest.slice(at)]

  if (zone === "before") return insert(targetIndex)
  if (zone === "after") return insert(targetIndex + 1)

  const spanOf = new Map(tiles.map((tile) => [tile.id, tile.span]))
  let best: string[] | undefined
  let bestCost = Number.POSITIVE_INFINITY
  for (let at = 0; at <= rest.length; at++) {
    const order = insert(at)
    const { placements } = packTiles(
      order.map((id) => spanOf.get(id)!),
      gridColumns,
    )
    const d = placements[at]!
    const t = placements[order.indexOf(target)]!
    const gap = zone === "above" ? t.row - (d.row + d.rows) : d.row - (t.row + t.rows)
    if (gap < 0) continue
    // Rows dominate: a pane two rows away but in the right column is not
    // "above" in any sense the user meant. The last term only breaks ties, in
    // favour of disturbing the order least.
    const cost = gap * 100 + Math.abs(centre(d) - centre(t)) + Math.abs(at - targetIndex) * 0.001
    if (cost < bestCost) {
      bestCost = cost
      best = order
    }
  }
  return best ?? insert(zone === "above" ? targetIndex : targetIndex + 1)
}

export type Direction = "left" | "right" | "up" | "down"

/**
 * The tile next to `index` in `direction`, or -1 when there is none.
 *
 * Geometric rather than by index, because with spans the index arithmetic of
 * `moveFocus` is wrong: next to a two-wide pane, "down" is not `index +
 * columns`. Sideways stays in the row, as `moveFocus` does, so a right arrow
 * never silently drops to the next row. Up and down take the nearest row and
 * then the nearest column, which lands a down arrow into a short last row on
 * the closest pane rather than refusing.
 */
export function neighbour(placements: ReadonlyArray<Placement>, index: number, direction: Direction): number {
  const me = placements[index]
  if (!me) return -1
  let best = -1
  let bestCost = Number.POSITIVE_INFINITY
  placements.forEach((p, i) => {
    if (i === index) return
    let cost: number
    if (direction === "left" || direction === "right") {
      const overlaps = p.row < me.row + me.rows && me.row < p.row + p.rows
      if (!overlaps) return
      const gap = direction === "left" ? me.column - (p.column + p.columns) : p.column - (me.column + me.columns)
      if (gap < 0) return
      cost = gap * 100 + Math.abs(p.row - me.row)
    } else {
      const gap = direction === "up" ? me.row - (p.row + p.rows) : p.row - (me.row + me.rows)
      if (gap < 0) return
      cost = gap * 100 + Math.abs(centre(p) - centre(me))
    }
    if (cost < bestCost) {
      bestCost = cost
      best = i
    }
  })
  return best
}

/** The order with `a` and `b` exchanged. */
export function swapTiles(ids: ReadonlyArray<string>, a: string, b: string): string[] {
  const i = ids.indexOf(a)
  const j = ids.indexOf(b)
  const next = [...ids]
  if (i === -1 || j === -1) return next
  next[i] = b
  next[j] = a
  return next
}

/**
 * Writes a new order for some items back into the full list.
 *
 * The grid shows one project's panes, and the workbench holds every
 * project's. The visible ones take the slots they already occupied, in their
 * new order, and everything else stays exactly where it was — so rearranging
 * one project never shuffles another's.
 */
export function applyOrder<T extends { id: string }>(all: ReadonlyArray<T>, order: ReadonlyArray<string>): T[] {
  const moving = new Set(order)
  const byId = new Map(all.map((item) => [item.id, item]))
  const queue = order.filter((id) => byId.has(id))
  let next = 0
  return all.map((item) => (moving.has(item.id) ? byId.get(queue[next++]!)! : item))
}
